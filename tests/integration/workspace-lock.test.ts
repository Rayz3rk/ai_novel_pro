import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Sqlite } from '../../apps/server/src/sqlite.js';
import { SqliteWorkspaceLock } from '../../apps/server/src/sqlite-workspace-lock.js';

describe('native SQLite workspace process lock', () => {
  it('rejects a second owner before it can mutate the workspace, and releases on close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shujian-workspace-lock-'));
    const filename = join(directory, 'workspace.sqlite');
    let first: Sqlite | undefined;
    let reopened: Sqlite | undefined;
    try {
      first = new Sqlite(filename);
      first.exec('CREATE TABLE sample(value TEXT); INSERT INTO sample(value) VALUES(\'original\')');
      expect(() => new Sqlite(filename)).toThrow('另一个书间进程');
      expect(first.prepare('SELECT value FROM sample').get()).toEqual({ value: 'original' });
      first.close(); first = undefined;
      reopened = new Sqlite(filename);
      expect(reopened.prepare('SELECT value FROM sample').get()).toEqual({ value: 'original' });
      expect(existsSync(`${filename}.instance-lock.sqlite`)).toBe(true);
    } finally {
      first?.close(); reopened?.close();
      const safe = resolve(directory);
      if (dirname(safe) !== resolve(tmpdir()) || !basename(safe).startsWith('shujian-workspace-lock-')) throw new Error('Unsafe test cleanup');
      await rm(safe, { recursive: true, force: true });
    }
  });

  it('exposes the same lock for offline migrations and does not lock independent in-memory stores', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shujian-workspace-lock-'));
    const filename = join(directory, 'workspace.sqlite');
    const migrationLock = new SqliteWorkspaceLock(filename);
    const memoryA = new Sqlite(':memory:'); const memoryB = new Sqlite(':memory:');
    let workspace: Sqlite | undefined;
    try {
      expect(() => new Sqlite(filename)).toThrow('另一个书间进程');
      migrationLock.close();
      workspace = new Sqlite(filename);
      expect(() => new SqliteWorkspaceLock(filename)).toThrow('另一个书间进程');
    } finally {
      workspace?.close(); migrationLock.close(); memoryA.close(); memoryB.close();
      const safe = resolve(directory);
      if (dirname(safe) !== resolve(tmpdir()) || !basename(safe).startsWith('shujian-workspace-lock-')) throw new Error('Unsafe test cleanup');
      await rm(safe, { recursive: true, force: true });
    }
  });
});
