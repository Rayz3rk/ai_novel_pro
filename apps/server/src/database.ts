import type { SQLInputValue } from 'node:sqlite';

export type DatabaseValue = SQLInputValue;
export type Transaction<T> = (() => T) & { deferred: () => T };
export interface Database {
  readonly kind: 'sqlite' | 'postgresql';
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    get: (...params: DatabaseValue[]) => unknown;
    all: (...params: DatabaseValue[]) => unknown[];
    run: (...params: DatabaseValue[]) => { changes: number; lastInsertRowid: number };
  };
  transaction<T>(operation: () => T): Transaction<T>;
  pragma(statement: string, options?: { simple: boolean }): unknown;
}

/** Convert placeholders only outside SQL strings, identifiers and comments. */
export function postgresParameters(sql: string): string {
  let index = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?/g,
    (token) => token === '?' ? `$${++index}` : token);
}

/** Keep the existing insertion-order tie breaker explicit on PostgreSQL. */
export function postgresSchema(sql: string): string {
  return sql.replace(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/g, 'BIGSERIAL PRIMARY KEY')
    .replace(/\bREAL\b/g, 'DOUBLE PRECISION')
    .replace(/(CREATE TABLE(?: IF NOT EXISTS)?\s+[a-z_]+\s*\()/gi, '$1 rowid BIGSERIAL UNIQUE, ');
}
