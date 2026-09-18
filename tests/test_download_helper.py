"""Local helper tests; no internet access, browser cookies or real downloads."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("download_helper", Path(__file__).resolve().parents[1] / "downloads" / "dream-unity-helper.py")
helper = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = helper
SPEC.loader.exec_module(helper)
ID = "BaW_jenozKc"
ORIGIN = "https://dream-unity.github.io"
TOKEN = "test-token-" + "a" * 32


def request(output_format="video", request_id="test-request-00000001", video_id=ID):
    return {"videoId": video_id, "format": output_format, "clientRequestId": request_id}


def available():
    return ["yt-dlp"], "/usr/bin/ffmpeg", "deno", []


EXTRACTOR = r'''
import pathlib, sys, time
mode, size = sys.argv[1:3]
args = sys.argv[3:]
extension = 'mp3' if '--extract-audio' in args else 'mp4'
target = pathlib.Path(args[args.index('--output') + 1].replace('%(ext)s', extension))
if mode == 'error':
    print('ERROR: Sign in to confirm. DO NOT EXPOSE SECRET-123', flush=True)
    sys.exit(1)
if mode == 'empty':
    sys.exit(0)
if mode in ('hang', 'oversize'):
    target.with_suffix('.part').write_bytes(b'x' * int(size))
    time.sleep(120)
target.write_bytes((b'ID3' if extension == 'mp3' else b'ftypmp42') + b'x' * int(size))
'''


class HelperTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.mode = "complete"
        self.size = 32
        self.calls = []

        def popen(args, **kwargs):
            self.calls.append((args, kwargs))
            return subprocess.Popen([sys.executable, "-c", EXTRACTOR, self.mode, str(self.size), *args], **kwargs)

        self.manager = helper.JobManager(self.temp.name, available, popen, timeout=2,
                                         max_bytes=1024, poll_interval=0.01)

    def tearDown(self):
        self.manager.close()
        self.temp.cleanup()

    def wait(self, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = self.manager.get(job_id)
            if job["state"] in helper.TERMINAL:
                self.manager.jobs[job_id].thread.join(timeout=3)
                return job
            time.sleep(0.01)
        self.fail("Job did not finish")

    def test_mp4_and_real_mp3_encoding_arguments_are_scoped(self):
        for index, output_format in enumerate(("video", "mp3")):
            created = self.manager.create(request(output_format, f"test-request-00000{index:03d}"))
            result = self.wait(created["id"])
            self.assertEqual(result["state"], "complete")
            extension = "mp4" if output_format == "video" else "mp3"
            self.assertTrue(result["filename"].endswith("." + extension))
            self.assertTrue((Path(self.temp.name) / result["filename"]).is_file())
            args, options = self.calls[-1]
            self.assertEqual(args[-2:], ["--", f"https://www.youtube.com/watch?v={ID}"])
            for flag in ("--ignore-config", "--no-plugin-dirs", "--no-remote-components",
                         "--no-cookies", "--no-cookies-from-browser", "--no-playlist"):
                self.assertIn(flag, args)
            self.assertEqual(args[args.index("--proxy") + 1], "")
            self.assertNotIn("shell", options)
            self.assertNotIn("https_proxy", {key.lower() for key in options["env"]})
            if output_format == "mp3":
                self.assertEqual(args[args.index("--audio-format") + 1], "mp3")
                self.assertIn("--extract-audio", args)
        self.assertEqual(len(list(Path(self.temp.name).iterdir())), 2)

    def test_payload_cannot_supply_urls_paths_or_options(self):
        for bad in (request(video_id="https://x.y"), request(video_id=";rm -rf xxx"),
                    request(output_format="--exec"), request(request_id="short"),
                    dict(request(), output="/tmp/test"), {"videoId": ID, "format": "video"}):
            with self.assertRaises(helper.RequestError) as caught:
                self.manager.create(bad)
            self.assertEqual(caught.exception.status, 400)
        self.assertFalse(self.calls)

    def test_idempotent_retries_and_payload_conflicts(self):
        created = self.manager.create(request())
        duplicate = self.manager.create(request())
        self.assertEqual(created["id"], duplicate["id"])
        self.wait(created["id"])
        self.assertEqual(self.manager.create(request())["id"], created["id"])
        self.assertEqual(len(self.calls), 1)
        with self.assertRaises(helper.RequestError) as caught:
            self.manager.create(request("mp3"))
        self.assertEqual(caught.exception.status, 409)

    def test_cancel_stops_process_and_removes_staging(self):
        self.mode = "hang"
        created = self.manager.create(request())
        deadline = time.monotonic() + 2
        while not self.calls and time.monotonic() < deadline:
            time.sleep(0.01)
        with self.assertRaises(helper.RequestError) as caught:
            self.manager.create(request(request_id="test-request-00000002"))
        self.assertEqual(caught.exception.status, 409)
        self.manager.cancel(created["id"])
        self.assertEqual(self.wait(created["id"])["state"], "cancelled")
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_failure_does_not_expose_raw_downloader_output(self):
        self.mode = "error"
        result = self.wait(self.manager.create(request())["id"])
        self.assertEqual(result["state"], "error")
        self.assertIn("requires access", result["message"])
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertNotIn("filename", result)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_exit_zero_without_output_is_not_success(self):
        self.mode = "empty"
        self.assertEqual(self.wait(self.manager.create(request())["id"])["state"], "error")

    def test_timeout_and_working_file_limit_cleanup(self):
        for index, mode in enumerate(("hang", "oversize")):
            self.mode = mode
            self.manager.timeout = 0.15 if mode == "hang" else 2
            self.size = 2048 if mode == "oversize" else 32
            result = self.wait(self.manager.create(request(request_id=f"limit-request-00000{index}"))["id"])
            self.assertEqual(result["state"], "error")
            self.assertIn("time limit" if mode == "hang" else "working-file limit", result["message"])
            self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_missing_dependencies_block_jobs(self):
        self.manager.dependency_check = lambda: (None, None, None, ["FFmpeg"])
        self.assertFalse(self.manager.health()["ready"])
        with self.assertRaises(helper.RequestError) as caught:
            self.manager.create(request())
        self.assertEqual(caught.exception.status, 503)
        self.assertFalse(self.calls)

    def test_atomic_publication_never_overwrites_existing_file(self):
        with patch.object(helper.os, "link", side_effect=FileExistsError("Collision")):
            result = self.wait(self.manager.create(request())["id"])
        self.assertEqual(result["state"], "error")
        self.assertNotIn("filename", result)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])


class HTTPTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = helper.JobManager(self.temp.name, lambda: (None, None, None, ["yt-dlp"]))
        self.server = helper.ThreadingHTTPServer(("127.0.0.1", 0), helper.handler_for(self.manager, TOKEN))
        self.port = self.server.server_address[1]
        self.server.RequestHandlerClass = helper.handler_for(self.manager, TOKEN, expected_host=f"127.0.0.1:{self.port}")
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.manager.close()
        self.temp.cleanup()

    def call(self, method, path, body=None, overrides=None):
        headers = {"Host": f"127.0.0.1:{self.port}", "Origin": ORIGIN,
                   "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}
        headers.update(overrides or {})
        headers = {key: value for key, value in headers.items() if value is not None}
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        content = response.read()
        result = response.status, dict(response.getheaders()), json.loads(content) if content else None
        connection.close()
        return result

    def test_authenticated_health_and_pna_preflight(self):
        status, headers, result = self.call("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(result["version"], 1)
        self.assertFalse(result["ready"])
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(headers["Cache-Control"], "no-store")
        status, headers, _ = self.call("OPTIONS", "/jobs", overrides={
            "Authorization": None, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization, content-type",
            "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")

    def test_rejects_wrong_token_host_origin_and_no_origin_writes(self):
        cases = [("GET", {"Authorization": None}, 401),
                 ("GET", {"Authorization": "Bearer wrong"}, 401),
                 ("GET", {"Authorization": "Bearer é"}, 401),
                 ("GET", {"Host": "evil.example"}, 403),
                 ("GET", {"Origin": "https://evil.example"}, 403),
                 ("GET", {"Origin": "null"}, 403),
                 ("GET", {"Origin": "http://localhost:8765"}, 403),
                 ("POST", {"Origin": None}, 403),
                 ("DELETE", {"Origin": None}, 403)]
        for method, overrides, expected in cases:
            self.assertEqual(self.call(method, "/health", {}, overrides)[0], expected)

    def test_unknown_routes_and_untrusted_body_are_rejected(self):
        self.assertEqual(self.call("GET", "/health?token=not-supported")[0], 404)
        self.assertEqual(self.call("POST", "/jobs", request(), {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.call("POST", "/jobs", {"tooBig": "x" * 1024})[0], 413)
        self.assertEqual(self.call("POST", "/open-folder", {"folder": "/tmp"})[0], 400)
        self.assertEqual(self.call("GET", "/jobs/../../passwd")[0], 404)
        self.assertEqual(self.call("POST", "/jobs", request())[0], 503)

    def test_dev_origin_is_opt_in(self):
        self.server.RequestHandlerClass = helper.handler_for(self.manager, TOKEN, dev=True, expected_host=f"127.0.0.1:{self.port}")
        status, headers, _ = self.call("GET", "/health", overrides={"Origin": "http://localhost:8765"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:8765")

    def test_cors_rejects_unexpected_preflight_headers(self):
        self.assertEqual(self.call("OPTIONS", "/jobs", overrides={
            "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "X-Other"})[0], 403)


class DependencyTest(unittest.TestCase):
    def test_old_runtime_is_rejected_and_supported_node_is_fallback(self):
        def result(args, **kwargs):
            return subprocess.CompletedProcess(args, 0, "deno 2.2.0\nv8 x" if args[0].endswith("deno") else "v22.0.0")
        with patch.object(helper.shutil, "which", side_effect=lambda name: "/tools/" + name), patch.object(helper.subprocess, "run", side_effect=result):
            self.assertEqual(helper.supported_runtime(), "node")
        with patch.object(helper.shutil, "which", return_value="/tools/deno"), patch.object(helper.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "deno 2.2.0")):
            self.assertIsNone(helper.supported_runtime())

    def test_supported_deno_is_preferred_and_runtime_timeouts_are_handled(self):
        with patch.object(helper.shutil, "which", return_value="/tools/deno"), patch.object(helper.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "deno 2.3.0\nv8 x")):
            self.assertEqual(helper.supported_runtime(), "deno")
        with patch.object(helper.shutil, "which", return_value="/tools/deno"), patch.object(helper.subprocess, "run", side_effect=subprocess.TimeoutExpired("deno", 2)):
            self.assertIsNone(helper.supported_runtime())

    def test_current_python_module_is_used_and_ejs_is_required(self):
        with patch.object(helper.shutil, "which", side_effect=lambda name: "/tools/" + name), patch.object(helper, "supported_runtime", return_value="deno"), patch.object(helper.importlib.util, "find_spec", side_effect=lambda name: object() if name == "yt_dlp" else None):
            command, _, _, missing = helper.dependencies()
            self.assertEqual(command, [sys.executable, "-m", "yt_dlp"])
            self.assertIn("yt-dlp-ejs", " ".join(missing))


if __name__ == "__main__":
    unittest.main()
