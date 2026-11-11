import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomInt } from 'node:crypto';
import { beforeAll, afterAll } from 'vitest';
import { createApp as application, type AppOptions } from '../../apps/server/src/app.js';
import { Postgres } from '../../apps/server/src/postgres.js';
import { loadStorageConfig, type StorageConfig } from '../../apps/server/src/storage-config.js';

/** The identical API suite runs on SQLite by default or on a disposable real PostgreSQL database. */
export function storageHarness(label: string) {
  const enabled = process.env.NOVEL_TEST_POSTGRES === '1';
  let storage: StorageConfig | undefined;
  if (enabled) {
    const root = resolve(import.meta.dirname, '../..');
    const loaded = loadStorageConfig(root, join(root, 'data'), process.env.NOVEL_TEST_DATABASE_FILE).config;
    if (loaded.driver !== 'postgresql') throw new Error('PostgreSQL test configuration is required.');
    if (!/^[a-z_]+$/.test(label)) throw new Error('Invalid test database label.');
    const database = `shujian_test_${label}_${Date.now()}${randomInt(1_000_000)}`;
    const url = new URL(loaded.postgres.url); url.pathname = `/${database}`;
    storage = { driver: 'postgresql', postgres: { ...loaded.postgres, url: url.toString(), createDatabase: false } };
    const require = createRequire(resolve(root, 'apps/server/package.json'));
    interface MaintenanceClient {
      connect(): Promise<void>;
      query(sql: string, params?: string[]): Promise<{ rowCount: number | null; rows: Array<{ count: number }> }>;
      end(): Promise<void>;
    }
    const { Client } = require('pg') as { Client: new (config: { connectionString: string }) => MaintenanceClient };
    const adminUrl = new URL(loaded.postgres.url); adminUrl.pathname = `/${loaded.postgres.maintenanceDatabase}`;
    let owned = false;
    const maintenance = async (action: (client: MaintenanceClient) => Promise<void>) => {
      const client = new Client({ connectionString: adminUrl.toString() });
      try { await client.connect(); await action(client); } finally { await client.end(); }
    };
    beforeAll(async () => {
      await maintenance(async client => {
        if ((await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) throw new Error('Refusing to reuse an existing test database.');
        await client.query(`CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8'`);
        owned = true;
      });
      appendFileSync(join(root, 'test-results/postgres-test-databases.ndjson'), JSON.stringify({ database, action: 'created' }) + '\n');
    });
    afterAll(async () => {
      if (!owned) return;
      if (!/^shujian_test_[a-z_]+_\d+$/.test(database) || database === new URL(loaded.postgres.url).pathname.slice(1)) throw new Error('Refusing to drop a non-test database.');
      await maintenance(async client => {
        const { rows } = await client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [database]);
        if (rows[0]?.count) throw new Error(`Test connections were not closed; refusing to force-drop ${database}.`);
        await client.query(`DROP DATABASE "${database}"`);
        owned = false;
      });
      appendFileSync(join(root, 'test-results/postgres-test-databases.ndjson'), JSON.stringify({ database, action: 'dropped' }) + '\n');
    });
    mkdirSync(join(root, 'test-results'), { recursive: true });
  }
  return {
    storage,
    createApp: (options: AppOptions = {}) => application({ ...options, ...(storage ? { storage } : {}) }),
    reset: () => {
      if (storage?.driver !== 'postgresql') return;
      const name = new URL(storage.postgres.url).pathname.slice(1);
      if (!/^shujian_test_[a-z_]+_\d+$/.test(name)) throw new Error('Refusing to clear a non-test database.');
      const database = new Postgres(storage.postgres);
      try { database.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); } finally { database.close(); }
    },
  };
}
