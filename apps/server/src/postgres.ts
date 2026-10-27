import { existsSync } from 'node:fs';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import { AppError } from './errors.js';
import { postgresParameters, postgresSchema, type Database, type DatabaseValue, type Transaction } from './database.js';
import type { PostgresConfig } from './storage-config.js';

interface Result { rows: Record<string, unknown>[]; changes: number }
interface Reply { ok: boolean; result?: Result; code?: string }

/** Native PostgreSQL in a dedicated I/O thread; one connection preserves short transaction boundaries. */
export class Postgres implements Database {
  readonly kind = 'postgresql' as const;
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly timeout: number;
  private closed = false;
  private depth = 0;
  private savepoint = 0;
  constructor(config: PostgresConfig) {
    const channel = new MessageChannel(); this.port = channel.port1;
    const javascript = new URL('./postgres-worker.js', import.meta.url);
    this.worker = new Worker(existsSync(javascript) ? javascript : new URL('./postgres-worker.ts', import.meta.url), {
      workerData: { port: channel.port2 }, transferList: [channel.port2],
    });
    this.worker.on('error', () => { this.closed = true; });
    this.timeout = Math.max(20000, config.statementTimeoutMs + 5000);
    try { this.request({ operation: 'open', config }); } catch (error) { this.port.close(); void this.worker.terminate(); throw error; }
  }
  private request(payload: object): Result | undefined {
    if (this.closed) throw new AppError(503, 'DATABASE_CLOSED', '数据库连接已关闭，请保留当前编辑并重新启动本地服务。');
    const signal = new Int32Array(new SharedArrayBuffer(4));
    this.port.postMessage({ ...payload, signal: signal.buffer });
    if (Atomics.wait(signal, 0, 0, this.timeout) === 'timed-out') {
      this.closed = true; this.port.close(); void this.worker.terminate();
      throw new AppError(503, 'DATABASE_TIMEOUT', '数据库等待超时，当前操作尚未确认；请保留编辑并重启服务后核对。');
    }
    let reply = receiveMessageOnPort(this.port)?.message as Reply | undefined;
    for (let attempt = 0; !reply && attempt < 100; attempt++) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); reply = receiveMessageOnPort(this.port)?.message as Reply | undefined; }
    if (!reply) { this.closed = true; this.port.close(); void this.worker.terminate(); throw new AppError(503, 'DATABASE_PROTOCOL', '数据库连接异常，请保留编辑并重新启动服务。'); }
    if (!reply.ok) {
      const messages: Record<string, string> = {
        '28P01': 'PostgreSQL 验证失败，请检查项目外数据库配置中的账号和密码。',
        '3D000': 'PostgreSQL 数据库不存在，请启用自动建库或检查数据库名称。',
        '42501': 'PostgreSQL 账号权限不足，请确认它具有建库与读写权限。',
        DATABASE_IN_USE: '这个 PostgreSQL 数据库已被另一个书间进程使用，请先关闭该进程。',
        ECONNREFUSED: '无法连接 PostgreSQL，请确认本机数据库服务正在运行。',
      };
      throw new AppError(503, 'DATABASE_ERROR', messages[reply.code ?? ''] ?? 'PostgreSQL 操作未完成，请保留当前编辑并检查数据库连接。');
    }
    return reply.result;
  }
  exec(sql: string): void { this.request({ operation: 'exec', sql: postgresSchema(sql) }); }
  pragma(): never { throw new Error('SQLite pragma cannot be used on PostgreSQL.'); }
  prepare(sql: string): ReturnType<Database['prepare']> {
    const query = postgresParameters(sql);
    const execute = (params: DatabaseValue[], text = query) => this.request({ operation: 'query', sql: text, params })!;
    return {
      get: (...params) => execute(params).rows[0], all: (...params) => execute(params).rows,
      run: (...params) => {
        const identity = /^\s*INSERT INTO ai_events\b/i.test(query) && !/\bRETURNING\b/i.test(query);
        const result = execute(params, identity ? `${query} RETURNING id` : query);
        return { changes: result.changes, lastInsertRowid: identity ? Number(result.rows[0]?.id ?? 0) : 0 };
      },
    };
  }
  transaction<T>(operation: () => T): Transaction<T> {
    const run = (readOnly: boolean): T => {
      const nested = this.depth > 0; const name = `sp_${++this.savepoint}`;
      this.exec(nested ? `SAVEPOINT ${name}` : readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      this.depth++;
      try { const result = operation(); this.exec(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT'); return result; }
      catch (error) { try { this.exec(nested ? `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}` : 'ROLLBACK'); } catch { /* Preserve the original uncertain-operation error. */ } throw error; }
      finally { this.depth--; }
    };
    return Object.assign(() => run(false), { deferred: () => run(true) });
  }
  close(): void {
    try { if (!this.closed) this.request({ operation: 'close' }); }
    finally { this.closed = true; this.port.close(); void this.worker.terminate(); }
  }
}
