"""Accept the published ZIP itself, with no pnpm, source dependencies or real model.

All writes and process termination are confined to a fresh test-results sandbox.
PostgreSQL credentials are read privately; only the disposable database name is reported.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[2]
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
OUT = ROOT / ('test-results/release-' + VERSION)
OUT.mkdir(exist_ok=True)
RUN = OUT / ('portable ' + uuid.uuid4().hex[:8])
RUN.mkdir()
PORT = 4336
BASE = f'http://127.0.0.1:{PORT}'
PS = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
ENV = {k: v for k, v in os.environ.items() if not k.startswith('NOVEL_')}
ENV.update(PORT=str(PORT), PYTHONIOENCODING='utf-8')
# The launcher must succeed without the developer's pnpm or Node on PATH.
ENV['PATH'] = str(Path(os.environ['SystemRoot']) / 'System32')
CHECKS = []
PROCESSES = []
REPORT = {'checks': CHECKS, 'runDirectory': str(RUN), 'passed': False}


def request(path, method='GET', body=None):
    raw = None if body is None else json.dumps(body).encode('utf-8')
    req = urllib.request.Request(BASE + path, raw, {'Content-Type': 'application/json'}, method=method)
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode('utf-8'))


def backup():
    snapshot = request('/api/backup')
    snapshot.pop('exportedAt', None)
    return snapshot


def launch(app, label):
    log = (RUN / (label + '.log')).open('wb')
    process = subprocess.Popen([str(PS), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                                str(app / 'scripts/start.ps1'), '-Production'], cwd=RUN,
                               env=ENV, stdout=log, stderr=subprocess.STDOUT,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    PROCESSES.append((process, log))
    for _ in range(150):
        if process.poll() is not None:
            raise AssertionError(f'{label} exited: see {label}.log')
        try:
            request('/api/books')
            return process, log
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    raise AssertionError(f'{label} timed out')


def stop(item):
    process, log = item
    if process.poll() is None:
        subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'], env=ENV,
                       capture_output=True, timeout=15, check=True)
        process.wait(timeout=15)
    log.close()
    for _ in range(50):
        try:
            request('/api/books')
            time.sleep(0.1)
        except (OSError, urllib.error.URLError):
            return
    raise AssertionError('Isolated server did not stop')


def move_inside(source, destination):
    # Verify both resolved paths before moving any directory on Windows.
    assert source.resolve().is_relative_to(RUN.resolve())
    assert destination.resolve().is_relative_to(RUN.resolve())
    assert not destination.exists()
    source.rename(destination)


try:
    for port in [PORT, 19091]:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    sums = ROOT / f'artifacts/shujian-{VERSION}-SHA256SUMS.txt'
    for line in sums.read_text().splitlines():
        digest, name = line.split(maxsplit=1)
        assert hashlib.sha256((sums.parent / name.strip()).read_bytes()).hexdigest() == digest
    archive = ROOT / f'artifacts/shujian-{VERSION}-windows-x64.zip'
    REPORT['runtimeArchiveSha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
    with zipfile.ZipFile(archive) as zipped:
        prefix = zipped.namelist()[0].split('/')[0]
        names = {name[len(prefix) + 1:] for name in zipped.namelist()}
        assert not any(name.startswith(('data/', 'novel-private/', 'references/')) or '.audit-build' in name for name in names)
        assert '.portable-profile.json' not in names
        inventory = json.loads(zipped.read(prefix + '/release-manifest.json'))
        assert names == {entry['path'] for entry in inventory['files']} | {'release-manifest.json'}
        for entry in inventory['files']:
            data = zipped.read(prefix + '/' + entry['path'])
            assert len(data) == entry['bytes'] and hashlib.sha256(data).hexdigest() == entry['sha256']
        for name in zipped.namelist():
            assert (RUN / name).resolve().is_relative_to(RUN.resolve())
        zipped.extractall(RUN)
    CHECKS.append('both archive checksums and every runtime file verified; personal data excluded')
    app = RUN / prefix
    fixture_log = (RUN / 'model-fixture.log').open('wb')
    fixture = subprocess.Popen([str(app / '.runtime/node.exe'), str(ROOT / 'tests/fixtures/model-server.mjs')],
                               env=ENV, stdout=fixture_log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    PROCESSES.append((fixture, fixture_log))
    for _ in range(50):
        try:
            with urllib.request.urlopen('http://127.0.0.1:19091/health') as response:
                assert json.load(response)['fixture']
            break
        except OSError:
            time.sleep(0.1)
    item = launch(app, 'fresh-sqlite')
    storage = request('/api/storage')['storage']
    assert storage['driver'] == 'sqlite' and Path(storage['database']).is_relative_to(app)
    assert request('/api/books')['books'] == []
    CHECKS.append('extracted launcher starts with bundled Node and no pnpm on PATH, in a path with spaces')
    # Reuse the real browser acceptance against the extracted application.
    browser_env = {**ENV, 'NOVEL_TEST_URL': BASE}
    chromium = ENV.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
    fallback = Path(os.environ['USERPROFILE']) / 'AppData/Local/ms-playwright/chromium-1148/chrome-win/chrome.exe'
    if chromium or fallback.exists():
        browser_env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] = chromium or str(fallback)
    for script in ['m1_smoke.py', 'session_recovery_smoke.py', 'creative_smoke.py', 'creative_editor_protection_smoke.py', 'atlas_smoke.py']:
        case_env = {**browser_env, 'NOVEL_CREATIVE_TEST_OUTPUT': str(RUN / ('sqlite-' + script.removesuffix('.py'))), 'NOVEL_ATLAS_TEST_OUTPUT': str(RUN / ('sqlite-' + script.removesuffix('.py')))}
        result = subprocess.run([sys.executable, str(ROOT / 'tests/e2e' / script)], env=case_env,
                                capture_output=True, timeout=180)
        (RUN / (script + '.log')).write_bytes(result.stdout + result.stderr)
        assert result.returncode == 0, f'{script}: see isolated log'
    CHECKS.append('packaged SQLite passes writing, multi-tab recovery, creative workflow and creative editor protection browser cases')
    before = backup()
    before_books = request('/api/books')
    stop(item)
    item = launch(app, 'sqlite-restart')
    assert backup() == before
    CHECKS.append('forced process stop and restart preserve the complete workspace backup')
    stop(item)
    moved = RUN / 'renamed app with spaces'
    move_inside(app, moved)
    app = moved
    item = launch(app, 'same-parent-move')
    assert request('/api/books') == before_books
    assert backup() == before
    CHECKS.append('renamed app repairs dependency junctions and reopens the same SQLite data')
    stop(item)
    destination_parent = RUN / 'different parent'
    destination_parent.mkdir()
    moved = destination_parent / 'moved app'
    move_inside(app, moved)
    app = moved
    guarded = subprocess.run([str(PS), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                              str(app / 'scripts/start.ps1'), '-Production'], env=ENV,
                             cwd=RUN, capture_output=True, timeout=30)
    (RUN / 'cross-parent-guard.log').write_bytes(guarded.stdout + guarded.stderr)
    assert guarded.returncode != 0
    assert not (destination_parent / 'novel-private/database.json').exists()
    move_inside(RUN / 'novel-private', destination_parent / 'novel-private')
    item = launch(app, 'cross-parent-config-restored')
    assert backup() == before
    CHECKS.append('cross-parent move refuses an empty fallback, then resumes after moving private configuration')
    stop(item)

    private = destination_parent / 'novel-private'
    original = json.loads((ROOT.parent / 'novel-private/database.json').read_text(encoding='utf-8-sig'))
    pg = original['postgresql'].copy()
    database = 'shujian_test_release_' + uuid.uuid4().hex[:12]
    with (ROOT / 'test-results/postgres-test-databases.ndjson').open('a', encoding='utf-8') as registry:
        registry.write(json.dumps({'database': database}) + '\n')
    url = urllib.parse.urlsplit(pg['url'])
    pg['url'] = urllib.parse.urlunsplit(url._replace(path='/' + database))
    pg['createDatabase'] = True
    config = private / 'database.json'
    config.write_text(json.dumps({'driver': 'postgresql', 'sqlite': {'filename': 'data/workspace.sqlite'},
                                  'postgresql': pg}), encoding='utf-8')
    REPORT['database'] = database
    (OUT / 'portable-environment.json').write_text(json.dumps({'app': str(app), 'private': str(private), 'database': database,
                                                              'port': PORT, 'run': str(RUN)}, indent=2), encoding='utf-8')
    # Foreign CWD and relative arguments must resolve against the packaged application.
    migration = subprocess.run([str(PS), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                                str(app / 'scripts/migrate.ps1'), '--source', 'data/workspace.sqlite',
                                '--database-file', '../novel-private/database.json'], env=ENV,
                               cwd=ROOT, capture_output=True, timeout=90)
    (RUN / 'compiled-migration.log').write_bytes(migration.stdout + migration.stderr)
    assert migration.returncode == 0, 'compiled migration failed; see isolated log'
    migration_report = json.loads((app / 'data/storage-migration-report.json').read_text())
    assert len(migration_report['tables']) == 24 and all(t['identical'] for t in migration_report['tables'])
    CHECKS.append('packaged migration CLI resolves relative paths from a foreign CWD and verifies all 24 tables including graph and creative data')
    item = launch(app, 'migrated-postgres')
    assert request('/api/storage')['storage']['database'] == database
    assert request('/api/books') == before_books
    assert backup() == before
    CHECKS.append('packaged PostgreSQL worker opens the migrated data with original IDs and exact backup')
    for script in ['m1_smoke.py', 'collaboration_smoke.py', 'extended_smoke.py',
                   'finalization_smoke.py', 'storage_smoke.py', 'critical_changes_smoke.py', 'creative_smoke.py', 'creative_editor_protection_smoke.py', 'atlas_smoke.py']:
        case_env = {**browser_env, 'NOVEL_CREATIVE_TEST_OUTPUT': str(RUN / ('pg-' + script.removesuffix('.py'))), 'NOVEL_ATLAS_TEST_OUTPUT': str(RUN / ('pg-' + script.removesuffix('.py')))}
        result = subprocess.run([sys.executable, str(ROOT / 'tests/e2e' / script)], env=case_env,
                                capture_output=True, timeout=240)
        (RUN / ('pg-' + script + '.log')).write_bytes(result.stdout + result.stderr)
        assert result.returncode == 0, f'packaged PostgreSQL {script}: see isolated log'
    CHECKS.append('packaged PostgreSQL passes the original 40 browser cases plus creative workflow and editor protection')
    REPORT['passed'] = True
finally:
    for process, log in reversed(PROCESSES):
        if process.poll() is None:
            subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'], env=ENV, capture_output=True, timeout=15)
            process.wait(timeout=15)
        log.close()
    (OUT / 'portable-release-report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(REPORT, ensure_ascii=False))
