import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/server/src/app.js';
import { postgresParameters, postgresSchema } from '../../apps/server/src/database.js';
import { loadStorageConfig, parsePostgresConfig, storageInfo } from '../../apps/server/src/storage-config.js';
import { migrateSqliteToPostgres } from '../../apps/server/src/storage-migration.js';

describe('storage configuration and portable SQL', () => {
  it('refuses a live SQLite source before backing up or connecting to a migration destination', async () => {
    const root=mkdtempSync(join(tmpdir(),'shujian-live-migration-'));
    const options={dataDir:join(root,'data'),credentialDir:join(root,'credentials'),connectionsFile:join(root,'absent.json')};
    const app=createApp(options);await app.ready();
    try {
      const postgres=parsePostgresConfig({url:'postgresql://fixture:fixture@127.0.0.1:1/never_connect'});
      await expect(migrateSqliteToPostgres(join(options.dataDir,'workspace.sqlite'),postgres,options)).rejects.toThrow('另一个书间');
      expect(existsSync(join(options.dataDir,'backups'))).toBe(false);
      expect((await app.inject('/api/books')).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it('releases the migration source lock if opening the source fails', async () => {
    const root=mkdtempSync(join(tmpdir(),'shujian-missing-migration-'));
    const options={dataDir:root,credentialDir:join(root,'credentials'),connectionsFile:join(root,'absent.json')};
    await expect(migrateSqliteToPostgres(join(root,'workspace.sqlite'),parsePostgresConfig({url:'postgresql://fixture:fixture@127.0.0.1:1/never_connect'}),options)).rejects.toThrow();
    const app=createApp(options);await app.ready();await app.close();
  });
  it('numbers bound parameters without changing quoted text or comments', () => {
    expect(postgresParameters("SELECT '?' AS literal, \"?\" FROM books WHERE id=? /* ? */ AND title=? -- ?\n"))
      .toBe("SELECT '?' AS literal, \"?\" FROM books WHERE id=$1 /* ? */ AND title=$2 -- ?\n");
  });
  it('uses explicit identity and insertion order on PostgreSQL', () => {
    expect(postgresSchema('CREATE TABLE IF NOT EXISTS ai_events(id INTEGER PRIMARY KEY AUTOINCREMENT, cost REAL)'))
      .toBe('CREATE TABLE IF NOT EXISTS ai_events( rowid BIGSERIAL UNIQUE, id BIGSERIAL PRIMARY KEY, cost DOUBLE PRECISION)');
  });
  it('validates database identifiers and never includes a password in errors or public state', () => {
    const postgres = parsePostgresConfig({ url: 'postgresql://test:fixture-secret@localhost:5432/test_database' });
    expect(storageInfo({ driver: 'postgresql', postgres })).toEqual({ driver: 'postgresql', database: 'test_database', host: 'localhost', port: 5432 });
    for (const url of ['https://test:fixture-secret@host/db', 'postgresql://test:fixture-secret@host/bad;name']) {
      expect(() => parsePostgresConfig({ url })).toThrow();
      try { parsePostgresConfig({ url }); } catch (error) { expect(String(error)).not.toContain('fixture-secret'); }
    }
  });
  it('keeps sensitive database files outside the workspace', () => {
    expect(() => loadStorageConfig(resolve('.'), resolve('data'), resolve('database.json'))).toThrow('项目目录之外');
  });
  it('stores a next-start preference without switching the live store or exposing credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shujian-storage-config-'));
    const file = join(root, 'database.json');
    writeFileSync(file, JSON.stringify({ driver: 'sqlite', sqlite: { filename: join(root, 'work.sqlite') },
      postgresql: { url: 'postgresql://test:fixture-secret@localhost:5432/test_database' } }));
    const app = createApp({ dataDir: join(root, 'data'), databaseFile: file, credentialDir: join(root, 'credentials') });
    try {
      await app.ready();
      const saved = await app.inject({ method: 'PUT', url: '/api/storage/preference', payload: { driver: 'postgresql' } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().storage).toMatchObject({ driver: 'sqlite', nextDriver: 'postgresql', canSelect: true });
      expect(saved.body).not.toContain('fixture-secret');
      expect(JSON.parse(readFileSync(file, 'utf8')).postgresql.url).toContain('fixture-secret');
      expect((await app.inject('/api/books')).statusCode).toBe(200);
      expect((await app.inject({ method: 'PUT', url: '/api/storage/preference', payload: { driver: 'other' } })).statusCode).toBe(400);
      await app.inject({ method: 'PUT', url: '/api/storage/preference', payload: { driver: 'sqlite' } });
      expect(JSON.parse(readFileSync(file, 'utf8')).driver).toBe('sqlite');
    } finally { await app.close(); }
  });
});
