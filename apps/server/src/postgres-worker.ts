import { workerData, type MessagePort } from 'node:worker_threads';
import pg from 'pg';
import type { PostgresConfig } from './storage-config.js';

const { port } = workerData as { port: MessagePort };
let client: pg.Client | undefined;
// Counts and identity values share the safe integer contract of SQLite's wrapper.
pg.types.setTypeParser(20, (value: string) => { const number = Number(value); if (!Number.isSafeInteger(number)) throw new Error('INTEGER_RANGE'); return number; });
interface Request { operation: 'open' | 'query' | 'exec' | 'close'; signal: SharedArrayBuffer; sql?: string; params?: unknown[]; config?: PostgresConfig }

function code(error: unknown): string {
  const value = error as { code?: unknown };
  return typeof value?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(value.code) ? value.code : 'DATABASE_ERROR';
}
async function connect(config: PostgresConfig, url = config.url): Promise<pg.Client> {
  const connection = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000,
    statement_timeout: config.statementTimeoutMs, query_timeout: config.statementTimeoutMs + 1000,
    application_name: 'shujian', keepAlive: true });
  connection.on('error', () => { /* A query or a bounded worker request will report a sanitized failure. */ });
  try { await connection.connect(); return connection; } catch (error) { await connection.end().catch(() => undefined); throw error; }
}
async function open(config: PostgresConfig): Promise<void> {
  try { client = await connect(config); }
  catch (error) {
    if (code(error) !== '3D000' || !config.createDatabase) throw error;
    const target = new URL(config.url);
    const database = target.pathname.slice(1);
    target.pathname = `/${config.maintenanceDatabase}`;
    const admin = await connect(config, target.toString());
    try {
      if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) {
        try { await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8'`); }
        catch (createError) { if (code(createError) !== '42P04') throw createError; }
      }
    } finally { await admin.end(); }
    client = await connect(config);
  }
  const lock = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(1936222570, 1) AS acquired');
  if (!lock.rows[0]?.acquired) { await client.end(); client = undefined; throw Object.assign(new Error('DATABASE_IN_USE'), { code: 'DATABASE_IN_USE' }); }
}

port.on('message', async (request: Request) => {
  const signal = new Int32Array(request.signal);
  try {
    let result: unknown;
    if (request.operation === 'open') { await open(request.config!); }
    else if (request.operation === 'close') { await client?.end(); client = undefined; }
    else {
      if (!client) throw new Error('DATABASE_CLOSED');
      if (request.operation === 'exec') await client.query(request.sql!);
      else {
        const query = await client.query(request.sql!, (request.params ?? []).map((value) => value instanceof Uint8Array ? Buffer.from(value) : value));
        result = { rows: query.rows, changes: query.rowCount ?? 0 };
      }
    }
    port.postMessage({ ok: true, result });
  } catch (error) { port.postMessage({ ok: false, code: code(error) }); }
  finally { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); }
});
