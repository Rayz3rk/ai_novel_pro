import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Database, Transaction } from './database.js';
import { SqliteWorkspaceLock } from './sqlite-workspace-lock.js';

/** Small synchronous wrapper: explicit transactions, nested savepoints, parameterized statements. */
export class Sqlite implements Database {
  readonly kind = 'sqlite' as const;
  private readonly database: DatabaseSync;
  private readonly workspaceLock?: SqliteWorkspaceLock;
  private depth = 0;
  private savepoint = 0;

  constructor(filename: string) {
    this.workspaceLock = filename && filename !== ':memory:' ? new SqliteWorkspaceLock(filename) : undefined;
    try { this.database = new DatabaseSync(filename); }
    catch (error) { this.workspaceLock?.close(); throw error; }
  }

  exec(sql: string): void { this.database.exec(sql); }
  close(): void { try { this.database.close(); } finally { this.workspaceLock?.close(); } }

  prepare(sql: string): {
    get: (...params: SQLInputValue[]) => unknown;
    all: (...params: SQLInputValue[]) => unknown[];
    run: (...params: SQLInputValue[]) => { changes: number; lastInsertRowid: number };
  } {
    const statement = this.database.prepare(sql);
    return {
      get: (...params) => statement.get(...params),
      all: (...params) => statement.all(...params),
      run: (...params) => {
        const result = statement.run(...params);
        return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
      },
    };
  }

  pragma(statement: string, options?: { simple: boolean }): unknown {
    const result = this.database.prepare(`PRAGMA ${statement}`).get();
    return options?.simple ? Object.values(result ?? {})[0] : result;
  }

  transaction<T>(operation: () => T): Transaction<T> {
    const run = (mode: 'IMMEDIATE' | 'DEFERRED'): T => {
      const nested = this.depth > 0;
      const name = `sp_${++this.savepoint}`;
      this.database.exec(nested ? `SAVEPOINT ${name}` : `BEGIN ${mode}`);
      this.depth++;
      try {
        const result = operation();
        this.database.exec(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
        return result;
      } catch (error) {
        this.database.exec(nested ? `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}` : 'ROLLBACK');
        throw error;
      } finally {
        this.depth--;
      }
    };
    return Object.assign(() => run('IMMEDIATE'), { deferred: () => run('DEFERRED') });
  }
}
