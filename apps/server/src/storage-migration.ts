import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { DatabaseSync, backup, type SQLInputValue } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { createApp } from './app.js';
import { Postgres } from './postgres.js';
import type { PostgresConfig } from './storage-config.js';
import { SqliteWorkspaceLock } from './sqlite-workspace-lock.js';

// Only application tables, in foreign-key order. Credentials never live in these tables.
const originalTables = ['books', 'chapters', 'document_revisions', 'plans', 'plan_history',
  'story_entries', 'story_events', 'story_proposals', 'story_reviews', 'story_dependencies',
  'ai_settings', 'ai_active', 'ai_config_import', 'ai_jobs', 'ai_events', 'ai_calls'] as const;
export const workspaceTables = [...originalTables, 'creative_skills', 'creative_skill_history', 'creative_profiles', 'creative_profile_history','atlas_relations','atlas_states','atlas_events','atlas_views'] as const;
const quoted = (value: string) => { if (!/^[a-z_]+$/.test(value)) throw new Error('Unsupported database identifier.'); return `"${value}"`; };
const digest = (rows: unknown[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
export interface MigrationReport { source: string; target: string; backup: string; tables: Array<{ name: string; rows: number; identical: boolean }>; preservedIds: true }

/** Offline full-fidelity transfer. Refuses a nonempty destination; all inserts and verification commit together. */
export async function migrateSqliteToPostgres(sourceFile: string, config: PostgresConfig, options: { dataDir: string; credentialDir: string; connectionsFile: string; backupFile?: string }): Promise<MigrationReport> {
  const sourceLock = new SqliteWorkspaceLock(resolve(sourceFile));
  let source: DatabaseSync | undefined;
  let target: Postgres | undefined;
  const backupFile = options.backupFile ?? join(dirname(sourceFile), 'backups', `before-postgresql-${Date.now()}.sqlite`);
  try {
    source = new DatabaseSync(resolve(sourceFile), { readOnly: true });
    await mkdir(dirname(backupFile), { recursive: true });
    await backup(source, backupFile);
    source.exec('BEGIN');
    const names = (source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
    if (originalTables.some((name) => !names.includes(name)) || names.some((name) => !(workspaceTables as readonly string[]).includes(name))) throw new Error('Source schema differs from this application; migration stopped without changing the target.');
    target = new Postgres(config);
    const existing = target.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'").all() as Array<{name:string}>;
    for (const { name } of existing) {
      if (name === 'shujian_schema') continue;
      if (!(workspaceTables as readonly string[]).includes(name)) throw new Error('Destination contains unrelated tables; refusing to initialize it.');
      if ((target.prepare(`SELECT COUNT(*) AS count FROM ${quoted(name)}`).get() as {count:number}).count) throw new Error('Destination contains workspace data; refusing to overwrite it.');
    }
    target.close(); target = undefined;
    const app = createApp({ ...options, storage: { driver: 'postgresql', postgres: config } });
    try { await app.ready(); } finally { await app.close(); }
    target = new Postgres(config);
    const report: MigrationReport = { source: resolve(sourceFile), target: new URL(config.url).pathname.slice(1), backup: resolve(backupFile), tables: [], preservedIds: true };
    const snapshot = source;
    target.transaction(() => {
      for (const table of workspaceTables) {
        const count = target!.prepare(`SELECT COUNT(*) AS count FROM ${quoted(table)}`).get() as { count: number };
        if (count.count) throw new Error('Destination contains workspace data; refusing to overwrite it.');
      }
      // chapters and document_revisions have a deferred circular reference for the final pointer.
      for (const table of workspaceTables) {
        if(!names.includes(table)){report.tables.push({name:table,rows:0,identical:true});continue;}
        const columns = (snapshot.prepare(`PRAGMA table_info(${quoted(table)})`).all() as Array<{ name: string }>).map((row) => row.name);
        const selection = columns.map(quoted).join(',');
        const rows = snapshot.prepare(`SELECT ${selection} FROM ${quoted(table)} ORDER BY rowid`).all() as Record<string, SQLInputValue>[];
        const insert = target!.prepare(`INSERT INTO ${quoted(table)}(${selection}) VALUES(${columns.map(() => '?').join(',')})`);
        for (const row of rows) insert.run(...columns.map((column) => row[column]!));
        const copied = target!.prepare(`SELECT ${selection} FROM ${quoted(table)} ORDER BY rowid`).all();
        const identical = digest(rows) === digest(copied);
        if (!identical) throw new Error(`Migration verification failed for ${table}; the transaction will roll back.`);
        report.tables.push({ name: table, rows: rows.length, identical });
      }
      target!.prepare("SELECT setval(pg_get_serial_sequence('ai_events','id'), COALESCE(MAX(id),1), COUNT(*)>0) FROM ai_events").get();
    })();
    return report;
  } finally { try { source?.close(); target?.close(); } finally { sourceLock.close(); } }
}
