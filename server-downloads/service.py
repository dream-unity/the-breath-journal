#!/usr/bin/env python3
"""Private job creation and capability-scoped public downloads for a sandbox VM."""

from collections import defaultdict, deque
from contextlib import contextmanager
from dataclasses import dataclass
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import stat
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlsplit


HELPER_PATH = Path(__file__).resolve().parent / "worker" / "helper.py"
spec = importlib.util.spec_from_file_location("dream_unity_hosted_helper", HELPER_PATH)
helper = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = helper
spec.loader.exec_module(helper)

MAX_BYTES = 512 * 1024 * 1024
MAX_SECONDS = 15 * 60
JOB_TTL = 15 * 60
RATE_WINDOW = 60 * 60
CLIENT_LIMIT = 3
GLOBAL_LIMIT = 10
MAX_STREAMS = 2
MAX_DOWNLOAD_ATTEMPTS = 3
ORIGIN = "https://dream-unity.github.io"
JOB_PATH = re.compile(r"/jobs/([a-f0-9]{32})\Z")
FILE_PATH = re.compile(r"/files/([a-f0-9]{32})\Z")
CLIENT_KEY = re.compile(r"[a-f0-9]{64}\Z")
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}\Z")
RequestError = helper.RequestError

# This module gets its own helper import. Limits also apply to downloader arguments,
# not just the supervisor's working-directory checks.
helper.MAX_BYTES = MAX_BYTES
helper.MAX_JOB_SECONDS = MAX_SECONDS


def validate_secret(secret):
    if not isinstance(secret, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", secret):
        raise ValueError("SERVICE_SECRET must be 32–256 random letters, digits, underscores or hyphens.")
    return secret


def public_job(job):
    """Do not expose helper paths, misleading local-save wording, or diagnostics."""
    state = job.get("state")
    messages = {
        "queued": "Waiting to start.",
        "running": "Preparing your MP3…" if job.get("format") == "mp3" else "Preparing your video…",
        "complete": "Your download is ready.",
        "cancelled": "Download cancelled.",
        "error": "The download could not be completed. The video may be unavailable or exceed the 512 MiB or 15-minute processing limit.",
    }
    result = {key: job[key] for key in ("id", "videoId", "format", "state")}
    result["message"] = messages.get(state, "Download status is unavailable.")
    if job.get("filename"):
        result["filename"] = job["filename"]
    return result


@dataclass
class Capability:
    token: str
    client_key: str
    request_id: str
    video_id: str
    output_format: str
    finished_at: float | None = None
    streams: int = 0
    download_attempts: int = 0


class DownloadService:
    def __init__(self, manager, secret, clock=time.monotonic, cleanup_interval=2):
        self.manager = manager
        self.secret = validate_secret(secret)
        self.clock = clock
        self.lock = threading.RLock()
        self.capabilities = {}
        self.requests = {}
        self.client_starts = defaultdict(deque)
        self.global_starts = deque()
        self.closing = False
        self.stop_cleanup = threading.Event()
        self.cleanup_thread = None
        if cleanup_interval:
            self.cleanup_thread = threading.Thread(target=self._cleanup_loop,
                                                   args=(cleanup_interval,), daemon=True)
            self.cleanup_thread.start()

    def _cleanup_loop(self, interval):
        while not self.stop_cleanup.wait(interval):
            self.cleanup()

    def authenticate_service(self, authorization):
        expected = "Bearer " + self.secret
        if not isinstance(authorization, str) or not secrets.compare_digest(
                authorization.encode("utf-8"), expected.encode("ascii")):
            raise RequestError(401, "Download creation requires the trusted gateway.")

    def health(self):
        try:
            ready = not self.closing and bool(self.manager.health().get("ready"))
        except Exception:
            ready = False
        return {"version": 1, "ready": ready}

    def _prune_rates(self, now):
        while self.global_starts and self.global_starts[0] <= now - RATE_WINDOW:
            self.global_starts.popleft()
        for client, starts in list(self.client_starts.items()):
            while starts and starts[0] <= now - RATE_WINDOW:
                starts.popleft()
            if not starts:
                del self.client_starts[client]

    def create(self, payload):
        if not isinstance(payload, dict) or set(payload) != {
                "videoId", "format", "clientRequestId", "clientKey"}:
            raise RequestError(400, "Send only videoId, format, clientRequestId and clientKey.")
        video_id, output_format = payload["videoId"], payload["format"]
        request_id, client = payload["clientRequestId"], payload["clientKey"]
        if not isinstance(video_id, str) or not helper.VIDEO_ID.fullmatch(video_id):
            raise RequestError(400, "Use a valid YouTube video ID.")
        if output_format not in ("video", "mp3"):
            raise RequestError(400, "Choose video or mp3.")
        if not isinstance(request_id, str) or not helper.REQUEST_ID.fullmatch(request_id):
            raise RequestError(400, "Use a unique request ID of 16–128 letters, digits, underscores or hyphens.")
        if not isinstance(client, str) or not CLIENT_KEY.fullmatch(client):
            raise RequestError(400, "A gateway-generated client key is required.")
        with self.lock:
            self.cleanup()
            if self.closing:
                raise RequestError(503, "Downloads are temporarily unavailable.")
            prior_id = self.requests.get((client, request_id))
            if prior_id:
                prior = self.capabilities[prior_id]
                if (prior.video_id, prior.output_format) != (video_id, output_format):
                    raise RequestError(409, "This request ID belongs to a different download.")
                return {**public_job(self.manager.get(prior_id)), "token": prior.token}
            now = self.clock()
            self._prune_rates(now)
            if len(self.global_starts) >= GLOBAL_LIMIT or len(self.client_starts.get(client, ())) >= CLIENT_LIMIT:
                raise RequestError(429, "The download limit has been reached. Please try again later.")
            internal_id = hashlib.sha256((client + ":" + request_id).encode("ascii")).hexdigest()
            try:
                job = self.manager.create({"videoId": video_id, "format": output_format,
                                           "clientRequestId": internal_id})
            except RequestError as error:
                messages = {409: "Another download is being prepared. Please try again shortly.",
                            503: "Downloads are temporarily unavailable. Please try again later."}
                raise RequestError(error.status, messages.get(error.status, "The download could not be started.")) from None
            capability = Capability(secrets.token_urlsafe(32), client, request_id, video_id, output_format)
            self.capabilities[job["id"]] = capability
            self.requests[(client, request_id)] = job["id"]
            self.client_starts[client].append(now)
            self.global_starts.append(now)
            return {**public_job(job), "token": capability.token}

    def _authorize(self, job_id, token):
        capability = self.capabilities.get(job_id)
        if not capability or not isinstance(token, str) or not TOKEN.fullmatch(token) or not secrets.compare_digest(token, capability.token):
            raise RequestError(404, "Download not found or expired.")
        return capability

    def get(self, job_id, token, cancel=False):
        with self.lock:
            self.cleanup()
            self._authorize(job_id, token)
            job = self.manager.cancel(job_id) if cancel else self.manager.get(job_id)
            result = public_job(job)
            if cancel and job["state"] not in helper.TERMINAL:
                result["message"] = "Cancelling your download…"
            return result

    def _file_path(self, job):
        extension = "mp3" if job["format"] == "mp3" else "mp4"
        expected = re.compile(r"dream-unity-" + re.escape(job["videoId"]) +
                              r"-\d{8}-\d{6}-" + re.escape(job["id"]) + r"\." + extension + r"\Z")
        filename = job.get("filename")
        if not isinstance(filename, str) or not expected.fullmatch(filename):
            raise RequestError(404, "The completed file is unavailable.")
        return self.manager.folder / filename

    @contextmanager
    def open_file(self, job_id, token):
        stream = None
        capability = None
        try:
            with self.lock:
                self.cleanup()
                capability = self._authorize(job_id, token)
                if capability.streams or sum(item.streams for item in self.capabilities.values()) >= MAX_STREAMS:
                    raise RequestError(429, "A file transfer is already running. Please let it finish before trying again.")
                if capability.download_attempts >= MAX_DOWNLOAD_ATTEMPTS:
                    raise RequestError(429, "This download's retry limit has been reached. Please prepare a new download.")
                job = self.manager.get(job_id)
                if job["state"] != "complete":
                    raise RequestError(409, "Your download is not ready yet.")
                path = self._file_path(job)
                try:
                    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    stream = os.fdopen(fd, "rb")
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_BYTES:
                        raise OSError("Invalid completed file")
                except OSError:
                    if stream:
                        stream.close()
                    stream = None
                    raise RequestError(404, "The completed file is unavailable or expired.") from None
                capability.streams += 1
                capability.download_attempts += 1
            yield stream, info.st_size, path.name, "audio/mpeg" if job["format"] == "mp3" else "video/mp4"
        finally:
            if stream:
                stream.close()
                with self.lock:
                    capability.streams -= 1

    def cleanup(self):
        with self.lock:
            now = self.clock()
            self._prune_rates(now)
            for job_id, capability in list(self.capabilities.items()):
                try:
                    job = self.manager.get(job_id)
                except RequestError:
                    job = None
                if job and job["state"] not in helper.TERMINAL:
                    continue
                if capability.finished_at is None:
                    capability.finished_at = now
                if capability.streams or now - capability.finished_at < JOB_TTL:
                    continue
                if job and job.get("filename"):
                    try:
                        self._file_path(job).unlink(missing_ok=True)
                    except (OSError, RequestError):
                        pass
                with self.manager.lock:
                    self.manager.jobs.pop(job_id, None)
                del self.capabilities[job_id]
                self.requests.pop((capability.client_key, capability.request_id), None)

    def close(self):
        with self.lock:
            self.closing = True
        self.stop_cleanup.set()
        if self.cleanup_thread:
            self.cleanup_thread.join(timeout=3)
        self.manager.close()


def handler_for(service):
    class Handler(BaseHTTPRequestHandler):
        server_version = "DreamUnityDownloads/1"
        sys_version = ""

        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def log_message(self, _format, *args):
            # File capabilities may be in the URL. Never send URLs to logs.
            pass

        def _headers(self, status, content_type, length):
            self.send_response(status)
            if self.headers.get("Origin") == ORIGIN:
                self.send_header("Access-Control-Allow-Origin", ORIGIN)
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
            self.send_header("Vary", "Origin")
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "private, no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Connection", "close")
            self.close_connection = True

        def _respond(self, status, data=None):
            body = b"" if data is None else json.dumps(data, ensure_ascii=True).encode("utf-8")
            self._headers(status, "application/json; charset=utf-8", len(body))
            if status == 429:
                self.send_header("Retry-After", str(RATE_WINDOW))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _origin(self):
            origins = self.headers.get_all("Origin", [])
            if len(origins) > 1 or (origins and origins[0] != ORIGIN):
                raise RequestError(403, "This website is not permitted.")

        def _authorization(self):
            headers = self.headers.get_all("Authorization", [])
            return headers[0] if len(headers) == 1 else None

        def _job_token(self):
            authorization = self._authorization()
            return authorization[7:] if authorization and authorization.startswith("Bearer ") else None

        def _json(self):
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise RequestError(415, "Use application/json.")
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not lengths[0].isdigit() or self.headers.get("Transfer-Encoding"):
                raise RequestError(400, "A valid Content-Length is required.")
            length = int(lengths[0])
            if not 0 < length <= 1024:
                raise RequestError(413, "Request body is too large or empty.")
            try:
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError("Incomplete body")
                return json.loads(body)
            except (ValueError, UnicodeError, OSError):
                raise RequestError(400, "Send valid JSON.") from None

        def _route(self):
            sending_file = False
            try:
                self._origin()
                path = urlsplit(self.path)
                if self.command == "OPTIONS":
                    requested = {value.strip().lower() for value in self.headers.get("Access-Control-Request-Headers", "").split(",") if value.strip()}
                    if (self.headers.get("Origin") != ORIGIN or
                            self.headers.get("Access-Control-Request-Method") not in ("GET", "POST", "DELETE") or
                            not requested.issubset({"authorization", "content-type"})):
                        raise RequestError(403, "Unsupported preflight request.")
                    self._respond(204)
                    return
                if self.command == "GET" and self.path == "/health":
                    self._respond(200, service.health())
                    return
                if self.command == "POST" and self.path == "/jobs":
                    service.authenticate_service(self._authorization())
                    self._respond(202, service.create(self._json()))
                    return
                match = JOB_PATH.fullmatch(self.path)
                if match and self.command in ("GET", "DELETE"):
                    self._respond(200, service.get(match[1], self._job_token(), self.command == "DELETE"))
                    return
                match = FILE_PATH.fullmatch(path.path)
                if match and self.command == "GET":
                    query = parse_qs(path.query, keep_blank_values=True, max_num_fields=4)
                    if set(query) != {"token"} or len(query["token"]) != 1:
                        raise RequestError(404, "Download not found or expired.")
                    with service.open_file(match[1], query["token"][0]) as (stream, size, filename, mime):
                        self._headers(200, mime, size)
                        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                        self.end_headers()
                        sending_file = True
                        shutil.copyfileobj(stream, self.wfile, length=256 * 1024)
                    return
                raise RequestError(404, "Endpoint not found.")
            except RequestError as error:
                if not sending_file:
                    self._respond(error.status, {"message": str(error)})
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            except Exception:
                if not sending_file:
                    self._respond(500, {"message": "Downloads are temporarily unavailable."})

        do_GET = _route
        do_POST = _route
        do_DELETE = _route
        do_OPTIONS = _route

    return Handler


class DownloadHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # Do not emit raw request or third-party media diagnostics.
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", choices=("0.0.0.0",), default="0.0.0.0")
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--secret-file", type=Path)
    parser.add_argument("--folder", type=Path)
    args = parser.parse_args()
    try:
        secret = validate_secret(args.secret_file.read_text(encoding="ascii").strip()
                                 if args.secret_file else os.environ.pop("SERVICE_SECRET", None))
    except (ValueError, OSError, UnicodeError):
        print("Provide a valid private service secret.", file=sys.stderr)
        return 1
    # Never pass the gateway credential on to the downloader process environment.
    os.environ.pop("SERVICE_SECRET", None)
    parent = args.folder or Path(os.environ.get("DOWNLOAD_DATA_ROOT", "/vercel/sandbox/download-data"))
    parent.mkdir(parents=True, exist_ok=True)
    # A fresh, private directory on every boot. Only this directory is ever removed;
    # the sandbox VM lifecycle disposes of files abandoned by a forced termination.
    folder = Path(tempfile.mkdtemp(prefix="dream-unity-jobs-", dir=parent))
    os.chmod(folder, 0o700)
    service = DownloadService(helper.JobManager(folder=folder, timeout=MAX_SECONDS, max_bytes=MAX_BYTES), secret)
    server = None
    try:
        server = DownloadHTTPServer((args.host, args.port), handler_for(service))
        def stop(_signum, _frame):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        print(f"Dream Unity download service listening on port {args.port}.", flush=True)
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        if server:
            server.server_close()
        service.close()
        shutil.rmtree(folder)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
