#!/usr/bin/env python3
"""Install and start one download worker, serialized across gateway instances.

Only maintained Ubuntu repositories and pinned PyPI packages supply binaries.
The service credential is generated inside the sandbox and never printed.
"""
import fcntl
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path('/vercel/sandbox/download-service')
SOURCE = Path(__file__).resolve().parent
SECRET = ROOT / 'service-secret'
DEADLINE = time.monotonic() + 180


def healthy():
    try:
        with urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2) as response:
            return json.load(response) == {'version': 1, 'ready': True}
    except (OSError, ValueError, urllib.error.URLError):
        return False


def run(command, log):
    seconds = max(1, int(DEADLINE - time.monotonic()))
    subprocess.run(command, check=True, timeout=seconds, stdin=subprocess.DEVNULL,
                   stdout=log, stderr=log)


def start():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chdir(ROOT)
    with (ROOT / 'startup.lock').open('a') as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= DEADLINE:
                    raise TimeoutError('Worker initialization is still in progress.')
                time.sleep(0.25)

        if healthy():
            return

        for relative in ('service.py', 'requirements.txt', 'worker/helper.py'):
            target = ROOT / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + '.new')
            shutil.copyfile(SOURCE / relative, temporary)
            temporary.replace(target)

        if not SECRET.exists():
            fd = os.open(SECRET, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as secret:
                secret.write(secrets.token_hex(32))
        if not __import__('re').fullmatch('[a-f0-9]{64}', SECRET.read_text()):
            raise ValueError('Invalid worker credential file.')

        python = ROOT / 'venv/bin/python'
        marker = ROOT / 'dependencies-ready'
        requirements = (ROOT / 'requirements.txt').read_text()
        with (ROOT / 'startup.log').open('w') as log:
            if not (python.exists() and marker.exists() and marker.read_text() == requirements):
                if not (shutil.which('ffmpeg') and shutil.which('ffprobe')):
                    run(['sudo', 'apt-get', 'update', '-qq'], log)
                    run(['sudo', 'apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg'], log)
                run([sys.executable, '-m', 'venv', str(ROOT / 'venv')], log)
                run([str(python), '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
                     '--no-input', '--no-cache-dir', '--index-url', 'https://pypi.org/simple',
                     '-r', str(ROOT / 'requirements.txt')], log)
                # Fail closed if the managed image loses a required executable.
                run([str(python), '-c',
                     "import sys;sys.path.insert(0, 'worker');import helper;"
                     "assert not helper.dependencies()[-1], helper.dependencies()[-1]"], log)
                marker.write_text(requirements)

            # No shell, user-supplied arguments, cookies, or credential forwarding.
            subprocess.Popen([str(python), str(ROOT / 'service.py'),
                              '--host', '0.0.0.0', '--port', '8080',
                              '--secret-file', str(SECRET), '--folder', str(ROOT / 'files')],
                             cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             start_new_session=True, close_fds=True)
            ready_deadline = min(DEADLINE, time.monotonic() + 15)
            while time.monotonic() < ready_deadline:
                if healthy():
                    return
                time.sleep(0.25)
        raise RuntimeError('Worker did not become ready.')


if __name__ == '__main__':
    try:
        os.chdir(ROOT if ROOT.exists() else SOURCE)
        start()
        print('ready')
    except Exception:
        # Keep internal paths and package-manager output out of public responses.
        print('Worker initialization failed.', file=sys.stderr)
        sys.exit(1)
