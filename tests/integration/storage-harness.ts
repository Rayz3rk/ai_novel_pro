import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
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
    const database = `shujian_test_${label}_${process.pid}`;
    const url = new URL(loaded.postgres.url); url.pathname = `/${database}`;
    storage = { driver: 'postgresql', postgres: { ...loaded.postgres, url: url.toString(), createDatabase: true } };
    mkdirSync(join(root, 'test-results'), { recursive: true });
    appendFileSync(join(root, 'test-results/postgres-test-databases.ndjson'), JSON.stringify({ database }) + '\n');
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
