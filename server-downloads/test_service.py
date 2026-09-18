import http.client
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest


spec = importlib.util.spec_from_file_location("download_service_tested", Path(__file__).with_name("service.py"))
service = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = service
spec.loader.exec_module(service)

SECRET = "a" * 48
CLIENT = "1" * 64
VIDEO = "M7lc1UVf-VE"


class Clock:
    value = 1000
    def __call__(self):
        return self.value
    def advance(self, seconds):
        self.value += seconds


class FakeManager:
    def __init__(self, folder):
        self.folder = Path(folder)
        self.jobs = {}
        self.lock = threading.RLock()
        self.closing = False
        self.ready = True
        self.create_count = 0

    def health(self):
        return {"ready": self.ready, "folder": "/secret/private/path", "missing": ["sensitive details"]}

    def create(self, payload):
        if any(job["state"] not in service.helper.TERMINAL for job in self.jobs.values()):
            raise service.RequestError(409, "helper internal details")
        if not self.ready:
            raise service.RequestError(503, "secret dependency diagnostic")
        self.create_count += 1
        job = {"id": secrets.token_hex(16), "videoId": payload["videoId"],
               "format": payload["format"], "state": "running", "message": "internal status"}
        self.jobs[job["id"]] = job
        return dict(job)

    def get(self, job_id):
        if job_id not in self.jobs:
            raise service.RequestError(404, "private unavailable diagnostic")
        return dict(self.jobs[job_id])

    def cancel(self, job_id):
        job = self.jobs[job_id]
        if job["state"] not in service.helper.TERMINAL:
            job["state"] = "cancelled"
        return dict(job)

    def complete(self, job_id, data=b"test media bytes"):
        job = self.jobs[job_id]
        ext = "mp3" if job["format"] == "mp3" else "mp4"
        filename = f"dream-unity-{job['videoId']}-20260919-120000-{job_id}.{ext}"
        (self.folder / filename).write_bytes(data)
        job.update(state="complete", filename=filename)
        return self.folder / filename

    def close(self):
        self.closing = True
        for job_id in self.jobs:
            self.cancel(job_id)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.manager = FakeManager(self.directory.name)
        self.clock = Clock()
        self.service = service.DownloadService(self.manager, SECRET, self.clock, cleanup_interval=0)
        self.server = service.DownloadHTTPServer(("127.0.0.1", 0), service.handler_for(self.service))
        self.server_thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01})
        self.server_thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join()
        self.service.close()
        self.directory.cleanup()

    def payload(self, number=1, client=CLIENT, output_format="video"):
        return {"videoId": VIDEO, "format": output_format,
                "clientRequestId": f"request-number-{number:04}", "clientKey": client}

    def request(self, method, path, body=None, token=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        request_headers = dict(headers or {})
        if body is not None:
            body = json.dumps(body).encode()
            request_headers.setdefault("Content-Type", "application/json")
        if token is not None:
            request_headers["Authorization"] = "Bearer " + token
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        result = (response.status, dict(response.getheaders()), response.read())
        connection.close()
        return result

    def create(self, **kwargs):
        status, _, body = self.request("POST", "/jobs", self.payload(**kwargs), SECRET)
        self.assertEqual(status, 202, body)
        return json.loads(body)

    def test_public_health_discloses_no_secret_path_or_dependency(self):
        status, _, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"version": 1, "ready": True})
        self.manager.ready = False
        self.assertEqual(json.loads(self.request("GET", "/health")[2]), {"version": 1, "ready": False})

    def test_create_requires_service_secret_and_does_not_echo_it(self):
        for token in (None, "incorrect", "é" * 32):
            status, _, body = self.request("POST", "/jobs", self.payload(), token)
            self.assertEqual(status, 401)
            self.assertNotIn(SECRET.encode(), body)
        job = self.create()
        self.assertNotEqual(job["token"], SECRET)
        self.assertEqual(set(job), {"id", "videoId", "format", "state", "message", "token"})
        self.assertNotIn(CLIENT, json.dumps(job))

    def test_capability_needed_for_status_cancel_and_file(self):
        job = self.create()
        for token in (None, SECRET, "x" * 43):
            for method in ("GET", "DELETE"):
                self.assertEqual(self.request(method, "/jobs/" + job["id"], token=token)[0], 404)
        self.assertEqual(self.request("GET", "/jobs/" + job["id"], token=job["token"])[0], 200)
        self.assertEqual(self.request("GET", "/files/" + job["id"] + "?token=" + SECRET)[0], 404)
        self.assertEqual(self.request("GET", "/files/" + job["id"] + "?token=" + job["token"])[0], 409)
        self.assertEqual(self.request("GET", "/jobs/" + "f" * 32, token=job["token"])[0], 404)

    def test_origin_is_exact_and_cors_is_scoped(self):
        for origin in ("https://evil.example", "https://dream-unity.github.io.evil.example", "null"):
            status, headers, _ = self.request("POST", "/jobs", self.payload(), SECRET, {"Origin": origin})
            self.assertEqual(status, 403)
            self.assertNotIn("Access-Control-Allow-Origin", headers)
        status, headers, _ = self.request("OPTIONS", "/jobs", headers={
            "Origin": service.ORIGIN, "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,content-type"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], service.ORIGIN)
        self.assertNotIn("Access-Control-Allow-Credentials", headers)
        self.assertEqual(self.request("OPTIONS", "/jobs", headers={
            "Origin": service.ORIGIN, "Access-Control-Request-Method": "PATCH"})[0], 403)

    def test_idempotent_create_has_same_token_without_extra_charge(self):
        first = self.create()
        retry = self.create()
        self.assertEqual(retry, first)
        self.assertEqual(self.manager.create_count, 1)
        self.assertEqual(len(self.service.global_starts), 1)
        self.manager.complete(first["id"])
        self.assertEqual(self.create()["token"], first["token"])
        conflict = self.payload(output_format="mp3")
        self.assertEqual(self.request("POST", "/jobs", conflict, SECRET)[0], 409)

    def test_idempotency_scoped_by_client(self):
        first = self.create()
        self.manager.complete(first["id"])
        second = self.create(client="2" * 64)
        self.assertNotEqual(first["id"], second["id"])
        self.assertNotEqual(first["token"], second["token"])
        self.assertEqual(self.request("GET", "/jobs/" + second["id"], token=first["token"])[0], 404)

    def test_invalid_inputs_never_reach_downloader(self):
        bad = [[], None, {**self.payload(), "url": "https://evil.example"},
               {**self.payload(), "videoId": "../../../etc/passwd"},
               {**self.payload(), "videoId": [VIDEO]},
               {**self.payload(), "format": "--exec evil"},
               {**self.payload(), "clientKey": "unhashed-address"},
               {**self.payload(), "clientRequestId": "short"},
               {**self.payload(), "output": "/tmp/target"}]
        for payload in bad:
            with self.subTest(payload=payload):
                if payload is None:
                    self.assertEqual(self.request("POST", "/jobs", payload, SECRET)[0], 415)
                else:
                    self.assertEqual(self.request("POST", "/jobs", payload, SECRET)[0], 400)
        self.assertEqual(self.manager.create_count, 0)

    def test_oversized_body_rejected(self):
        payload = {**self.payload(), "padding": "x" * 1024}
        self.assertEqual(self.request("POST", "/jobs", payload, SECRET)[0], 413)
        self.assertEqual(self.manager.create_count, 0)

    def test_global_active_job_is_limited_and_rejection_not_charged(self):
        self.create()
        status, _, body = self.request("POST", "/jobs", self.payload(number=2), SECRET)
        self.assertEqual(status, 409)
        self.assertNotIn(b"helper", body)
        self.assertEqual(len(self.service.global_starts), 1)

    def test_per_client_rate_limit_and_time_window(self):
        for number in range(3):
            job = self.create(number=number)
            self.manager.complete(job["id"])
        status, headers, _ = self.request("POST", "/jobs", self.payload(number=4), SECRET)
        self.assertEqual(status, 429)
        self.assertEqual(headers["Retry-After"], "3600")
        self.clock.advance(3600)
        self.create(number=5)

    def test_global_rate_limit_cannot_be_evaded_by_client_rotation(self):
        for number in range(10):
            job = self.create(number=number, client=f"{number:064x}")
            self.manager.complete(job["id"])
        self.assertEqual(self.request("POST", "/jobs", self.payload(number=11, client="f" * 64), SECRET)[0], 429)

    def test_dependency_error_hides_diagnostics(self):
        self.manager.ready = False
        status, _, body = self.request("POST", "/jobs", self.payload(), SECRET)
        self.assertEqual(status, 503)
        self.assertNotIn(b"secret", body)
        self.assertNotIn(b"dependency", body)
        self.assertEqual(len(self.service.global_starts), 0)

    def test_cancel_affects_own_job_only_and_does_not_leak_token(self):
        first = self.create()
        self.manager.complete(first["id"])
        second = self.create(number=2)
        status, _, body = self.request("DELETE", "/jobs/" + second["id"], token=second["token"])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["state"], "cancelled")
        self.assertNotIn(second["token"].encode(), body)
        self.assertEqual(self.manager.get(first["id"])["state"], "complete")

    def test_streams_file_larger_than_serverless_payload_limit(self):
        job = self.create()
        content = bytes(range(256)) * (28 * 1024)  # 7 MiB, beyond a 4.5 MiB function response.
        path = self.manager.complete(job["id"], content)
        status, headers, body = self.request("GET", "/files/" + job["id"] + "?token=" + job["token"], headers={"Origin": service.ORIGIN})
        self.assertEqual(status, 200)
        self.assertEqual(body, content)
        self.assertEqual(int(headers["Content-Length"]), len(content))
        self.assertEqual(headers["Content-Type"], "video/mp4")
        self.assertEqual(headers["Content-Disposition"], f'attachment; filename="{path.name}"')
        self.assertEqual(headers["Cache-Control"], "private, no-store")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

    def test_mp3_mime_and_filename(self):
        job = self.create(output_format="mp3")
        self.manager.complete(job["id"])
        status, headers, _ = self.request("GET", "/files/" + job["id"] + "?token=" + job["token"])
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/mpeg")
        self.assertTrue(headers["Content-Disposition"].endswith('.mp3"'))

    def test_file_expiry_removes_only_owned_file_and_capability(self):
        job = self.create()
        path = self.manager.complete(job["id"])
        unknown = self.manager.folder / "keep-me.txt"
        unknown.write_text("unrelated")
        self.service.cleanup()
        self.clock.advance(service.JOB_TTL + 1)
        self.service.cleanup()
        self.assertFalse(path.exists())
        self.assertTrue(unknown.exists())
        self.assertEqual(self.request("GET", "/jobs/" + job["id"], token=job["token"])[0], 404)
        self.assertEqual(self.request("GET", "/files/" + job["id"] + "?token=" + job["token"])[0], 404)
        self.assertEqual(self.service.requests, {})

    def test_expiry_does_not_delete_file_during_stream(self):
        job = self.create()
        path = self.manager.complete(job["id"])
        self.service.cleanup()
        with self.service.open_file(job["id"], job["token"]) as (stream, *_):
            self.clock.advance(service.JOB_TTL + 1)
            self.service.cleanup()
            self.assertTrue(path.exists())
            self.assertTrue(stream.read())
        self.service.cleanup()
        self.assertFalse(path.exists())

    def test_parallel_downloads_and_retries_are_bounded(self):
        job = self.create()
        self.manager.complete(job["id"])
        with self.service.open_file(job["id"], job["token"]):
            self.assertEqual(self.request("GET", "/files/" + job["id"] + "?token=" + job["token"])[0], 429)
        self.assertEqual(self.service.capabilities[job["id"]].download_attempts, 1)
        for _ in range(service.MAX_DOWNLOAD_ATTEMPTS - 1):
            self.assertEqual(self.request("GET", "/files/" + job["id"] + "?token=" + job["token"])[0], 200)
        self.assertEqual(self.request("GET", "/files/" + job["id"] + "?token=" + job["token"])[0], 429)
        self.assertEqual(self.service.capabilities[job["id"]].streams, 0)

    def test_filename_traversal_and_header_injection_rejected(self):
        job = self.create()
        self.manager.complete(job["id"])
        for filename in ("../outside.mp4", "/etc/passwd", "video.mp4\r\nX-Injected: yes"):
            self.manager.jobs[job["id"]]["filename"] = filename
            status, headers, body = self.request("GET", "/files/" + job["id"] + "?token=" + job["token"])
            self.assertEqual(status, 404)
            self.assertNotIn("X-Injected", headers)
            self.assertNotIn(filename.encode(), body)

    @unittest.skipUnless(hasattr(os, "O_NOFOLLOW"), "Sandbox runs Linux")
    def test_symlink_not_followed_and_oversized_file_rejected(self):
        job = self.create()
        path = self.manager.complete(job["id"])
        outside = self.manager.folder / "outside-secret"
        outside.write_text("must not be read")
        path.unlink()
        path.symlink_to(outside)
        self.assertEqual(self.request("GET", "/files/" + job["id"] + "?token=" + job["token"])[0], 404)
        path.unlink()
        with path.open("wb") as file:
            file.truncate(service.MAX_BYTES + 1)
        self.assertEqual(self.request("GET", "/files/" + job["id"] + "?token=" + job["token"])[0], 404)

    def test_duplicate_or_extra_file_query_parameters_rejected(self):
        job = self.create()
        self.manager.complete(job["id"])
        for suffix in ("", "?token=", "?token=" + job["token"] + "&token=" + job["token"],
                       "?token=" + job["token"] + "&path=/etc/passwd"):
            self.assertEqual(self.request("GET", "/files/" + job["id"] + suffix)[0], 404)

    def test_shutdown_cancels_active_job_and_rejects_new_work(self):
        job = self.create()
        self.service.close()
        self.assertTrue(self.manager.closing)
        self.assertEqual(self.manager.get(job["id"])["state"], "cancelled")
        self.assertEqual(self.request("POST", "/jobs", self.payload(number=2), SECRET)[0], 503)

    def test_downloader_command_enforces_size_and_fixed_youtube_host(self):
        args = service.helper.command_for(["python", "-m", "yt_dlp"], "/usr/bin/ffmpeg", "node", VIDEO, "video", "/tmp/staging")
        self.assertEqual(args[args.index("--max-filesize") + 1], str(service.MAX_BYTES))
        self.assertEqual(args[-1], "https://www.youtube.com/watch?v=" + VIDEO)
        self.assertIn("--no-cookies-from-browser", args)
        self.assertIn("--no-remote-components", args)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Requires FFmpeg fixture tools")
    def test_real_media_encoding_publication_and_http_download(self):
        """Exercise the real supervisor/files with local FFmpeg, without YouTube access."""
        ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
        def encode_fixture(args, **kwargs):
            audio = "--extract-audio" in args
            extension = "mp3" if audio else "mp4"
            output = args[args.index("--output") + 1].replace("%(ext)s", extension)
            command = [ffmpeg, "-nostdin", "-loglevel", "error"]
            if not audio:
                command.extend(["-f", "lavfi", "-i", "color=c=green:s=64x64:r=10"])
            command.extend(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "0.2"])
            command.extend(["-c:a", "libmp3lame"] if audio else ["-c:v", "mpeg4", "-c:a", "aac"])
            command.append(output)
            return subprocess.Popen(command, **kwargs)
        self.manager = service.helper.JobManager(
            folder=self.directory.name,
            dependency_check=lambda: (["test-extractor"], ffmpeg, "node", []),
            popen=encode_fixture, timeout=10, max_bytes=service.MAX_BYTES, poll_interval=.01)
        self.service.manager = self.manager
        for index, output_format in enumerate(("video", "mp3")):
            job = self.create(number=index, output_format=output_format)
            self.manager.jobs[job["id"]].thread.join(timeout=15)
            status, _, body = self.request("GET", "/jobs/" + job["id"], token=job["token"])
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["state"], "complete", body)
            status, _, media = self.request("GET", "/files/" + job["id"] + "?token=" + job["token"])
            self.assertEqual(status, 200)
            received = Path(self.directory.name) / ("received.mp3" if output_format == "mp3" else "received.mp4")
            received.write_bytes(media)
            probe = subprocess.run([ffprobe, "-v", "error", "-show_entries", "stream=codec_name,codec_type", "-of", "json", str(received)],
                                   check=True, capture_output=True, text=True, timeout=10)
            streams = json.loads(probe.stdout)["streams"]
            self.assertTrue(any(item["codec_type"] == "audio" for item in streams))
            if output_format == "mp3":
                self.assertEqual(streams[0]["codec_name"], "mp3")
            else:
                self.assertTrue(any(item["codec_type"] == "video" for item in streams))


if __name__ == "__main__":
    unittest.main()
