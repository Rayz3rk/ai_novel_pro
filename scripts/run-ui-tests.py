"""Run browser acceptance in a fresh workspace and terminate the direct server process on Windows too."""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'test-results'
OUTPUT.mkdir(exist_ok=True)

for test in sys.argv[1:]:
    script = (ROOT / test).resolve()
    if not script.is_relative_to(ROOT / 'tests' / 'e2e') or script.suffix != '.py':
        raise ValueError('Only repository browser acceptance scripts are supported.')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    directory = Path(tempfile.mkdtemp(prefix='browser-acceptance-', dir=OUTPUT))
    credentials = Path(tempfile.mkdtemp(prefix='shujian-browser-credentials-'))
    env = dict(os.environ, PORT=str(port), NOVEL_DATA_DIR=str(directory), NOVEL_CREDENTIAL_DIR=str(credentials),
               NOVEL_CONNECTIONS_FILE=str(credentials / 'connections.json'), NOVEL_TEST_URL=f'http://127.0.0.1:{port}')
    # Tests must not inherit a personal PostgreSQL URL or database selection.
    env.pop('NOVEL_DATABASE_URL', None)
    env.pop('NOVEL_DATABASE_FILE', None)
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js is required.')
    with (directory / 'server.log').open('w', encoding='utf-8') as log:
        server = subprocess.Popen([node, str(ROOT / 'apps/server/dist/main.js')], cwd=ROOT, env=env,
                                  stdout=log, stderr=log,
                                  creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        try:
            deadline = time.monotonic() + 15
            while True:
                if server.poll() is not None:
                    raise RuntimeError(f'Test server exited: {directory / "server.log"}')
                try:
                    with urlopen(f'http://127.0.0.1:{port}/api/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    if time.monotonic() > deadline:
                        raise RuntimeError('Test server did not start.')
                    time.sleep(0.1)
            subprocess.run([sys.executable, str(script)], cwd=ROOT, env=env, check=True)
        finally:
            server.terminate()
            server.wait(timeout=10)
