/** Production-process crash check with an isolated local stream fixture; no real API call. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { loadStorageConfig } from '../../apps/server/src/storage-config.js';

const root = resolve(import.meta.dirname, '../..');
await mkdir(join(root, 'test-results'), { recursive: true });
const directory = await mkdtemp(join(root, 'test-results/stream-crash-'));
const credentials = await mkdtemp(join(directory, 'private-'));
const postgres = process.argv.includes('--postgres');
let databaseFile = '';
if (postgres) {
  const loaded = loadStorageConfig(root, join(root, 'data')).config;
  assert(loaded.driver === 'postgresql', 'Configure PostgreSQL before this isolated test.');
  const database = `shujian_test_crash_${Date.now()}`;
  const url = new URL(loaded.postgres.url); url.pathname = `/${database}`;
  databaseFile = join(credentials, 'database.json');
  await writeFile(databaseFile, JSON.stringify({ driver: 'postgresql', postgresql: { ...loaded.postgres, url: url.toString() } }), { mode: 0o600 });
  appendFileSync(join(root, 'test-results/postgres-test-databases.ndjson'), JSON.stringify({ database }) + '\n');
}
const frame = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;
let finishRequests = false;
let requests = 0;
const retriedText = '重试得到的新候选🙂。'.repeat(20);
const fixture = createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume fixture request */ }
  requests++;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (!finishRequests) { response.write(frame('测🙂').repeat(1000)); return; }
  response.end(frame(retriedText) + 'data: [DONE]\n\n');
});
await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
const fixtureAddress = fixture.address();
assert(fixtureAddress && typeof fixtureAddress !== 'string');
const probe = createPortProbe();
await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
const address = probe.address(); assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((done) => probe.close(() => done()));
const base = `http://127.0.0.1:${port}`;
let child: ChildProcess | undefined;
let logs = '';
function start(): void {
  logs = '';
  child = spawn(process.execPath, [join(root, 'apps/server/dist/main.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), NOVEL_DATA_DIR: join(directory, 'data'),
      NOVEL_CREDENTIAL_DIR: credentials, NOVEL_CONNECTIONS_FILE: join(credentials, 'absent.json'),
      NOVEL_DATABASE_FILE: databaseFile, NOVEL_DATABASE_URL: '' },
  });
  const capture = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4000); };
  child.stdout?.on('data', capture); child.stderr?.on('data', capture);
}
async function ready(): Promise<void> {
  for (let index = 0; index < 200; index++) {
    assert(child && child.exitCode === null, `Fixture app exited: ${logs}`);
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* startup */ }
    await pause(50);
  }
  throw new Error(`Fixture app did not start: ${logs}`);
}
async function stopAbruptly(): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
}
async function api(method: string, path: string, body?: object): Promise<Record<string, unknown>> {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}
interface Job { id: string; status: string; output: string; appliedVersion: number | null }
interface Chapter { id: string; version: number; title: string; outline: string; plainText: string; document: object }
let report: object | undefined;
try {
  start(); await ready();
  await api('PUT', '/api/model', { baseUrl: `http://127.0.0.1:${fixtureAddress.port}/v1`, model: 'crash-fixture-only',
    stream: true, temperature: 0.7, maxOutputTokens: 4096, contextWindow: 32768,
    inputPricePerMillion: null, outputPricePerMillion: null, taskBudget: null, dailyBudget: null });
  const { book } = await api('POST', '/api/books', { title: 'Isolated production stream crash fixture' }) as { book: { id: string } };
  const { chapters } = await api('GET', `/api/books/${book.id}/chapters`) as { chapters: Chapter[] };
  const original = '作者已经保存的中文正文🙂。';
  const { chapter } = await api('PUT', `/api/chapters/${chapters[0]!.id}/draft`, { expectedVersion: chapters[0]!.version,
    title: chapters[0]!.title, outline: '', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: original }] }] } }) as { chapter: Chapter };
  const { job } = await api('POST', '/api/jobs', { requestId: randomUUID(), kind: 'draft', chapterId: chapter.id,
    expectedVersion: chapter.version, instruction: 'Isolated crash fixture.' }) as { job: Job };
  const streamController = new AbortController();
  const response = await fetch(`${base}/api/jobs/${job.id}/events`, { signal: AbortSignal.any([streamController.signal, AbortSignal.timeout(20000)]) });
  assert(response.ok && response.body);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let acknowledged = '';
  try {
    while (!acknowledged) {
      const chunk = await reader.read(); assert(!chunk.done, 'Stream closed before a durable partial snapshot');
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const message = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (!message.includes('event: job')) continue;
        const data = message.split('\n').find((line) => line.startsWith('data: '));
        if (!data) continue;
        const snapshot = JSON.parse(data.slice(6)) as { job: Job };
        if (snapshot.job.status === 'running' && snapshot.job.output) { acknowledged = snapshot.job.output; break; }
      }
    }
    await stopAbruptly();
  } finally { streamController.abort(); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  start(); await ready();
  const restored = (await api('GET', `/api/jobs/${job.id}`)).job as Job;
  assert.equal(restored.status, 'interrupted'); assert(restored.output.startsWith(acknowledged));
  const restoredChapter = (await api('GET', `/api/chapters/${chapter.id}`)).chapter as Chapter;
  assert.equal(restoredChapter.plainText, original); assert.equal(restoredChapter.version, chapter.version);
  assert.deepEqual(restoredChapter.document, chapter.document);
  const calls = (await api('GET', `/api/jobs/${job.id}/calls`)).calls as Array<{ status: string }>;
  assert.equal(calls.length, 1); assert.equal(calls[0]!.status, 'interrupted');
  finishRequests = true;
  const retry = (await api('POST', `/api/jobs/${job.id}/retry`, {})).job as Job; assert.notEqual(retry.id, job.id);
  let current = retry;
  for (let index = 0; index < 200 && ['running', 'queued'].includes(current.status); index++) {
    await pause(50); current = (await api('GET', `/api/jobs/${retry.id}`)).job as Job;
  }
  assert.equal(current.status, 'succeeded'); assert.equal(current.output, retriedText); assert.equal(current.appliedVersion, null);
  assert.equal(((await api('GET', `/api/jobs/${job.id}`)).job as Job).output, restored.output);
  assert.equal(((await api('GET', `/api/chapters/${chapter.id}`)).chapter as Chapter).plainText, original);
  assert.equal(requests, 2);
  report = { label: 'isolated production hard-kill fixture; no real API call',
    backend: postgres ? 'postgresql' : 'sqlite',
    acknowledgedUtf16Length: acknowledged.length, restoredUtf16Length: restored.output.length,
    acknowledgedPrefixPreserved: true, originalProseUnchanged: true, interruptedCallPreserved: true,
    retryCreatesIndependentCandidate: true, originalCandidateUnchanged: true, providerRequests: requests };
  await writeFile(join(root, `test-results/stream-crash${postgres ? '-postgresql' : ''}-report.json`), JSON.stringify(report, null, 2));
} finally {
  await stopAbruptly(); fixture.closeAllConnections(); await new Promise<void>((done) => fixture.close(() => done()));
}
console.log(JSON.stringify(report));
