#!/usr/bin/env python3
"""Explicitly paired, loopback-only YouTube download helper for Dream Unity.

The web page sends only a video ID and output format. No journal data, browser
credentials, arbitrary URLs, executable options, or output paths are accepted.
"""

import argparse
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


PORT = 8766
MAX_BYTES = 2 * 1024 ** 3
MAX_DURATION = 3 * 60 * 60
MAX_JOB_SECONDS = 60 * 60
MAX_JOBS = 30
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{16,128}\Z")
JOB_PATH = re.compile(r"/jobs/([a-f0-9]{32})\Z")
TERMINAL = {"complete", "error", "cancelled"}


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def supported_runtime():
    # Minimums documented by yt-dlp's EJS setup guide, July 2026.
    for name, minimum in (("deno", (2, 3, 0)), ("node", (22, 0, 0))):
        executable = shutil.which(name)
        if not executable:
            continue
        try:
            result = subprocess.run([executable, "--version"], stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                                    text=True, encoding="utf-8", errors="replace",
                                    timeout=2, check=False)
            match = re.match(r"(?:deno\s+|v)(\d+)\.(\d+)\.(\d+)", result.stdout.strip())
            if result.returncode == 0 and match and tuple(map(int, match.groups())) >= minimum:
                return name
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def dependencies():
    command = [sys.executable, "-m", "yt_dlp"] if importlib.util.find_spec("yt_dlp") else None
    ffmpeg = shutil.which("ffmpeg")
    runtime = supported_runtime()
    missing = []
    if not command:
        missing.append("yt-dlp Python package")
    if not importlib.util.find_spec("yt_dlp_ejs"):
        missing.append("yt-dlp-ejs (included with yt-dlp[default])")
    if not ffmpeg:
        missing.append("FFmpeg")
    if not shutil.which("ffprobe"):
        missing.append("ffprobe (included with FFmpeg)")
    if not runtime:
        missing.append("Deno 2.3+ or Node.js 22+")
    return command, ffmpeg, runtime, missing


def command_for(command, ffmpeg, runtime, video_id, output_format, staging):
    if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
        raise RequestError(400, "Use a valid YouTube video ID.")
    if output_format not in ("video", "mp3"):
        raise RequestError(400, "Choose video or mp3.")
    args = [*command, "--ignore-config", "--no-plugin-dirs", "--no-update",
            "--no-remote-components", "--no-cookies", "--no-cookies-from-browser",
            "--no-cache-dir", "--proxy", "", "--no-playlist", "--no-wait-for-video",
            "--no-overwrites", "--restrict-filenames", "--no-progress", "--newline",
            "--socket-timeout", "20", "--retries", "2", "--fragment-retries", "2",
            "--max-filesize", str(MAX_BYTES), "--match-filters",
            f"!is_live & duration <= {MAX_DURATION}", "--ffmpeg-location", ffmpeg,
            "--output", str(Path(staging) / "media.%(ext)s")]
    if runtime:
        args.extend(["--no-js-runtimes", "--js-runtimes", runtime])
    if output_format == "mp3":
        args.extend(["--format", "ba/b", "--extract-audio", "--audio-format", "mp3",
                     "--audio-quality", "192K"])
    else:
        args.extend(["--format", "bv[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]",
                     "--merge-output-format", "mp4"])
    args.extend(["--", f"https://www.youtube.com/watch?v={video_id}"])
    return args


def terminate_process(process):
    """Stop both yt-dlp and FFmpeg, including a child left after its parent exits."""
    if os.name == "nt":
        taskkill = shutil.which("taskkill")
        if taskkill:
            subprocess.run([taskkill, "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=10, check=False)
        elif process.poll() is None:
            process.kill()
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        # A parent can exit before its FFmpeg child. Kill the original group too.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def safe_failure(lines):
    text = "\n".join(lines).lower()
    if "sign in" in text or "private video" in text or "members-only" in text:
        return "YouTube requires access that this helper does not use. Try a public video."
    if "requested format is not available" in text:
        return "A compatible MP4 is unavailable for this video. You can try MP3 instead."
    if "match filter" in text or "does not pass filter" in text:
        return "Live videos and videos longer than three hours are not supported."
    if "max-filesize" in text or "larger than max" in text:
        return "This download exceeds the 2 GiB size limit."
    return "Download failed. The video may be unavailable, or yt-dlp may need updating. See the helper setup guide."


def working_size(folder):
    total = 0
    for path in folder.iterdir():
        try:
            if path.is_file():
                total += path.stat().st_size
        except FileNotFoundError:
            # yt-dlp may rename a .part file between the directory read and stat.
            continue
    return total


@dataclass
class Job:
    id: str
    video_id: str
    output_format: str
    request_id: str
    state: str = "queued"
    message: str = "Waiting to start."
    filename: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    process: object = None
    thread: object = None

    def public(self):
        result = {"id": self.id, "videoId": self.video_id, "format": self.output_format,
                  "state": self.state, "message": self.message}
        if self.filename:
            result["filename"] = self.filename
        return result


class JobManager:
    def __init__(self, folder=None, dependency_check=dependencies, popen=subprocess.Popen,
                 timeout=MAX_JOB_SECONDS, max_bytes=MAX_BYTES, poll_interval=0.25):
        self.folder = Path(folder) if folder else Path.home() / "Downloads" / "Dream Unity"
        self.folder.mkdir(parents=True, exist_ok=True)
        self.dependency_check = dependency_check
        self.popen = popen
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.poll_interval = poll_interval
        self.jobs = {}
        self.lock = threading.RLock()
        self.closing = False

    def health(self):
        *_, missing = self.dependency_check()
        return {"version": 1, "ready": not missing, "missing": missing,
                "folder": str(self.folder)}

    def create(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"videoId", "format", "clientRequestId"}:
            raise RequestError(400, "Send only videoId, format and clientRequestId.")
        video_id, output_format = payload["videoId"], payload["format"]
        request_id = payload["clientRequestId"]
        if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
            raise RequestError(400, "Use a valid YouTube video ID.")
        if output_format not in ("video", "mp3"):
            raise RequestError(400, "Choose video or mp3.")
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            raise RequestError(400, "Use a unique client request ID of 16–128 letters, digits, underscores or hyphens.")
        with self.lock:
            for prior in self.jobs.values():
                if prior.request_id == request_id:
                    if prior.video_id != video_id or prior.output_format != output_format:
                        raise RequestError(409, "This request ID already belongs to a different download.")
                    return prior.public()
            if self.closing:
                raise RequestError(503, "The helper is shutting down.")
            command, ffmpeg, runtime, missing = self.dependency_check()
            if missing:
                raise RequestError(503, "Install the missing dependencies: " + ", ".join(missing) + ".")
            if any(job.state not in TERMINAL for job in self.jobs.values()):
                raise RequestError(409, "A download is already running. Finish or cancel it first.")
            while len(self.jobs) >= MAX_JOBS:
                del self.jobs[next(iter(self.jobs))]
            job = Job(secrets.token_hex(16), video_id, output_format, request_id)
            self.jobs[job.id] = job
            job.thread = threading.Thread(target=self._run, args=(job, command, ffmpeg, runtime), daemon=True)
            job.thread.start()
            return job.public()

    def get(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise RequestError(404, "Download not found. The helper may have restarted.")
            return job.public()

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise RequestError(404, "Download not found.")
            if job.state not in TERMINAL:
                job.cancel.set()
                job.message = "Cancelling and removing unfinished files…"
            return job.public()

    def _update(self, job, state, message):
        with self.lock:
            job.state, job.message = state, message

    def _run(self, job, command, ffmpeg, runtime):
        staging = None
        process = None
        reader = None
        lines = deque(maxlen=30)
        state, message = "error", "Download failed. Check that the helper can write to the Downloads folder."
        try:
            staging = Path(tempfile.mkdtemp(prefix=".dream-unity-", dir=self.folder))
            with self.lock:
                if job.cancel.is_set():
                    state, message = "cancelled", "Download cancelled."
                    return
                job.state = "running"
                job.message = "Downloading audio and preparing MP3…" if job.output_format == "mp3" else "Downloading and preparing MP4…"
                env = {key: value for key, value in os.environ.items()
                       if key.lower() not in {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}}
                options = {"stdout": subprocess.PIPE, "stderr": subprocess.STDOUT,
                           "stdin": subprocess.DEVNULL, "text": True, "encoding": "utf-8",
                           "errors": "replace", "env": env, "cwd": str(staging)}
                if os.name == "nt":
                    options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
                else:
                    options["start_new_session"] = True
                process = self.popen(command_for(command, ffmpeg, runtime, job.video_id,
                                                 job.output_format, staging), **options)
                job.process = process

            def consume_output():
                try:
                    # Bounded reads avoid one maliciously long line consuming memory.
                    while True:
                        line = process.stdout.readline(4096)
                        if not line:
                            break
                        lines.append(line.rstrip())
                except (OSError, ValueError):
                    pass

            reader = threading.Thread(target=consume_output, daemon=True)
            reader.start()
            started = time.monotonic()
            while process.poll() is None:
                if job.cancel.wait(self.poll_interval):
                    state, message = "cancelled", "Download cancelled."
                    return
                if time.monotonic() - started > self.timeout:
                    message = "Download exceeded the one-hour time limit. Try again or choose a shorter video."
                    return
                if working_size(staging) > self.max_bytes:
                    message = "This download exceeds the 2 GiB working-file limit."
                    return
            reader.join(timeout=2)
            if job.cancel.is_set():
                state, message = "cancelled", "Download cancelled."
                return
            if process.returncode != 0:
                message = safe_failure(lines)
                return
            extension = "mp3" if job.output_format == "mp3" else "mp4"
            source = staging / f"media.{extension}"
            if not source.is_file() or source.is_symlink() or not 0 < source.stat().st_size <= self.max_bytes:
                message = "No completed file was produced. The video may be unavailable or exceed the download limits."
                return
            stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
            filename = f"dream-unity-{job.video_id}-{stamp}-{job.id}.{extension}"
            with self.lock:
                if job.cancel.is_set():
                    state, message = "cancelled", "Download cancelled."
                    return
                # Same-filesystem hard linking publishes the complete file atomically
                # and fails if the destination exists. No overwrite/partial file race.
                os.link(source, self.folder / filename)
                job.filename = filename
                state, message = "complete", "Saved to Downloads / Dream Unity."
                job.state, job.message = state, message
        except (OSError, ValueError, subprocess.SubprocessError):
            message = "The helper could not finish this download. Check dependencies, available disk space and folder permissions."
        finally:
            if process:
                try:
                    terminate_process(process)
                except (OSError, subprocess.SubprocessError):
                    pass
                if reader:
                    reader.join(timeout=2)
                if process.stdout:
                    process.stdout.close()
            if staging:
                shutil.rmtree(staging, ignore_errors=True)
            with self.lock:
                job.process = None
                self._update(job, state, message)

    def close(self):
        with self.lock:
            self.closing = True
            jobs = list(self.jobs.values())
            for job in jobs:
                if job.state not in TERMINAL:
                    job.cancel.set()
        for job in jobs:
            job.thread.join(timeout=15)

    def open_folder(self):
        try:
            if os.name == "nt":
                os.startfile(str(self.folder))
            else:
                executable = shutil.which("open" if sys.platform == "darwin" else "xdg-open")
                if not executable:
                    raise OSError("No folder opener")
                subprocess.Popen([executable, str(self.folder)], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as error:
            raise RequestError(503, "Open Downloads / Dream Unity in your file manager.") from error


def handler_for(manager, token, dev=False, expected_host=f"127.0.0.1:{PORT}"):
    origins = {"https://dream-unity.github.io"}
    if dev:
        origins.add("http://localhost:8765")

    class Handler(BaseHTTPRequestHandler):
        server_version = "DreamUnityHelper/1"

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, _format, *args):
            # Never log tokens, URLs, queries or third-party downloader output.
            pass

        def _respond(self, status, data=None):
            body = b"" if data is None else json.dumps(data).encode("utf-8")
            self.send_response(status)
            origin = self.headers.get("Origin")
            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            if body:
                self.wfile.write(body)

        def _check(self, preflight=False):
            if self.headers.get_all("Host", []) != [expected_host]:
                raise RequestError(403, "Unexpected local host.")
            origin_values = self.headers.get_all("Origin", [])
            if len(origin_values) > 1 or (origin_values and origin_values[0] not in origins):
                raise RequestError(403, "This website is not allowed to use the helper.")
            if (preflight or self.command in ("POST", "DELETE")) and not origin_values:
                raise RequestError(403, "A permitted website origin is required.")
            if preflight:
                if self.headers.get("Access-Control-Request-Method") not in ("GET", "POST", "DELETE"):
                    raise RequestError(403, "Unsupported method.")
                requested = {value.strip().lower() for value in self.headers.get("Access-Control-Request-Headers", "").split(",") if value.strip()}
                if not requested.issubset({"authorization", "content-type"}):
                    raise RequestError(403, "Unsupported request headers.")
                return
            authorizations = self.headers.get_all("Authorization", [])
            expected = f"Bearer {token}"
            if len(authorizations) != 1 or not secrets.compare_digest(authorizations[0].encode("utf-8"), expected.encode("ascii")):
                raise RequestError(401, "Connect using the token printed by your local helper.")

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
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError("Incomplete body")
                return json.loads(data)
            except (ValueError, UnicodeError, OSError) as error:
                raise RequestError(400, "Send valid JSON.") from error

        def _route(self):
            try:
                self._check(preflight=self.command == "OPTIONS")
                if self.command == "OPTIONS":
                    self._respond(204)
                    return
                if self.command == "GET" and self.path == "/health":
                    self._respond(200, manager.health())
                    return
                if self.command == "POST" and self.path == "/jobs":
                    self._respond(202, manager.create(self._json()))
                    return
                match = JOB_PATH.fullmatch(self.path)
                if match and self.command in ("GET", "DELETE"):
                    self._respond(200, manager.get(match[1]) if self.command == "GET" else manager.cancel(match[1]))
                    return
                if self.command == "POST" and self.path == "/open-folder":
                    if self._json() != {}:
                        raise RequestError(400, "No folder path or other arguments are accepted.")
                    manager.open_folder()
                    self._respond(200, {"message": "Opened Downloads / Dream Unity."})
                    return
                raise RequestError(404, "Endpoint not found.")
            except RequestError as error:
                self._respond(error.status, {"message": str(error)})

        do_GET = _route
        do_POST = _route
        do_DELETE = _route
        do_OPTIONS = _route

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dev", action="store_true", help="Also allow the development site at http://localhost:8765")
    args = parser.parse_args()
    manager = JobManager()
    token = secrets.token_urlsafe(32)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), handler_for(manager, token, args.dev))
    except OSError:
        manager.close()
        print(f"Could not start on 127.0.0.1:{PORT}. Close another running helper and try again.", file=sys.stderr)
        return 1
    print(f"Dream Unity download helper — http://127.0.0.1:{PORT}")
    print(f"Connection token: {token}")
    print(f"Files save to: {manager.folder}")
    missing = manager.health()["missing"]
    if missing:
        print("Install missing dependencies, then reconnect: " + ", ".join(missing))
    print("Keep this window open. Press Ctrl+C to stop and cancel unfinished downloads.", flush=True)
    def request_shutdown(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, request_shutdown)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        manager.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
