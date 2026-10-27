"""Windows batch entrypoints with a PATH containing neither Node nor pnpm.

Uses isolated SQLite/config directories and free ports; never stops the personal app.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-results/startup-fix'
RUN = ROOT.parent / ('novel-qa-startup-' + uuid.uuid4().hex[:10])
OUT.mkdir(parents=True, exist_ok=True)
RUN.mkdir(parents=True)
CWD = RUN / 'foreign working directory'
CWD.mkdir()
SYSTEM = Path(os.environ['SystemRoot'])
PS = SYSTEM / 'System32/WindowsPowerShell/v1.0/powershell.exe'
CMD = SYSTEM / 'System32/cmd.exe'
TASKKILL = SYSTEM / 'System32/taskkill.exe'
ENV = {k: v for k, v in os.environ.items() if not k.startswith('NOVEL_') and k != 'PORT'}
ENV['PATH'] = str(SYSTEM / 'System32') + ';' + str(PS.parent)
assert shutil.which('pnpm', path=ENV['PATH']) is None
assert shutil.which('node', path=ENV['PATH']) is None
checks = []


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def get(port, path):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}' + path, timeout=2) as response:
        return json.load(response)


def launch(batch, port, label, callback, cwd=CWD, extra=None):
    env = {**ENV, 'PORT': str(port), 'NOVEL_DATA_DIR': str(RUN / label / 'data'),
           'NOVEL_CREDENTIAL_DIR': str(RUN / label / 'credentials'),
           'NOVEL_CONNECTIONS_FILE': str(RUN / label / 'connections.json'), **(extra or {})}
    with (RUN / (label + '.log')).open('wb') as log:
        # CALL avoids cmd /c treating the batch path's quotes as command delimiters.
        process = subprocess.Popen([str(CMD), '/d', '/c', 'call', str(batch)], cwd=cwd, env=env,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            deadline = time.monotonic() + 45
            while True:
                if process.poll() is not None:
                    raise AssertionError(f'{label} exited; see isolated log')
                try:
                    get(port, '/api/books')
                    break
                except (OSError, urllib.error.URLError):
                    assert time.monotonic() < deadline, f'{label} timed out'
                    time.sleep(0.1)
            callback(env)
        finally:
            if process.poll() is None:
                subprocess.run([str(TASKKILL), '/PID', str(process.pid), '/T', '/F'], env=ENV,
                               capture_output=True, timeout=15, check=True)
                process.wait(timeout=15)
    deadline = time.monotonic() + 8
    while True:
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', port)) != 0:
                break
        assert time.monotonic() < deadline, 'Isolated child process did not stop'
        time.sleep(0.1)


try:
    prod_port = free_port()
    def production(env):
        state = get(prod_port, '/api/storage')['storage']
        assert state['driver'] == 'sqlite' and Path(state['database']).is_relative_to(RUN)
        assert not get(prod_port, '/api/model')['settings']['hasApiKey']
        with urllib.request.urlopen(f'http://127.0.0.1:{prod_port}') as response:
            assert '<div id="root">' in response.read().decode()
    launch(ROOT / 'start.bat', prod_port, 'production-no-pnpm', production)
    checks.append('start.bat starts the current production build from a foreign CWD without Node or pnpm on PATH')

    with socket.socket() as probe:
        assert probe.connect_ex(('127.0.0.1', 5173)) != 0, 'Development port 5173 is already in use; do not stop another service.'
    dev_port = free_port()
    def development(env):
        deadline = time.monotonic() + 30
        while True:
            try:
                state = get(5173, '/api/storage')['storage']
                break
            except (OSError, urllib.error.URLError):
                assert time.monotonic() < deadline, 'Development frontend timed out'
                time.sleep(0.1)
        assert state['driver'] == 'sqlite' and Path(state['database']).is_relative_to(RUN)
        body = json.dumps({'title': '启动验收独立作品'}).encode('utf-8')
        request = urllib.request.Request('http://127.0.0.1:5173/api/books', body,
                    {'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:5173'}, method='POST')
        with urllib.request.urlopen(request) as response:
            assert json.load(response)['book']['title'] == '启动验收独立作品'
        assert len(get(dev_port, '/api/books')['books']) == 1
        assert not get(dev_port, '/api/model')['settings']['hasApiKey']
    launch(ROOT / 'start-dev.bat', dev_port, 'development-no-pnpm', development)
    checks.append('start-dev.bat starts both source watchers without pnpm on PATH; the real frontend proxy writes only to isolated SQLite')

    # Execute the actual resolver alone: locating the existing cached pnpm must not
    # require installing anything or changing the system/user PATH.
    resolver = r'''
$taskRoot = $env:NOVEL_STARTUP_ROOT
$script:taskPnpmPath = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $taskRoot 'scripts/start.ps1'), [ref]$null, [ref]$null)
$fn = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Require-Pnpm'}, $true)
. ([scriptblock]::Create($fn.Extent.Text))
Require-Pnpm
if (-not $taskPnpmPath) { throw 'Resolver returned no command' }
$version = & $taskPnpmPath --version
if ($version -notmatch '^11\.') { throw 'Wrong pnpm version' }
if (-not (Get-Command pnpm -CommandType Application -ErrorAction SilentlyContinue)) { throw 'Nested build command cannot find pnpm' }
Write-Output 'resolver-ready'
'''
    resolved = subprocess.run([str(PS), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', resolver],
                             env={**ENV, 'NOVEL_STARTUP_ROOT': str(ROOT)}, capture_output=True, timeout=30)
    (RUN / 'resolver.log').write_bytes(resolved.stdout + resolved.stderr)
    assert resolved.returncode == 0 and b'resolver-ready' in resolved.stdout
    checks.append('rebuild resolver finds existing pnpm 11 and exposes it to child build scripts without modifying global settings')
    report = {'passed': True, 'checks': checks, 'run': str(RUN), 'cleanPath': True, 'personalWorkspaceUsed': False,
              'modelRequests': 0}
    (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
except Exception:
    (OUT / 'failure.json').write_text(json.dumps({'checks': checks, 'run': str(RUN)}, ensure_ascii=False, indent=2), encoding='utf-8')
    raise
