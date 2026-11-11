import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { createApp, projectRoot } from '../apps/server/src/app.js';
import { Store } from '../apps/server/src/store.js';
import { StoryService } from '../apps/server/src/story/service.js';
import { loadStorageConfig } from '../apps/server/src/storage-config.js';
import { convertLegacyBook, type LegacyProject, type LegacyChapter, type LegacyVersion } from '../apps/server/src/legacy-import.js';
import { backup as validateBackup } from '../apps/server/src/validation.js';
import type { StoryEntryKind, WorkspaceBackup } from '@shujian/contracts';
import type { Pool as PoolType } from 'pg';

const source = resolve(process.argv.slice(2).find(argument => argument !== '--') ?? resolve(projectRoot, '../ai_novel'));
const require = createRequire(resolve(projectRoot, 'apps/server/package.json'));
const { Pool } = require('pg') as { Pool: typeof PoolType };
const env = readFileSync(join(source, '.env'), 'utf8');
const url = env.match(/^DATABASE_URL\s*=\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? 'postgresql://postgres:postgres@localhost:5432/novel';
const pool = new Pool({ connectionString: url });
const dataDir = resolve(process.env.NOVEL_DATA_DIR ?? join(projectRoot, 'data'));
const backupDir = join(dataDir, 'backups', `legacy-import-${Date.now()}`);
mkdirSync(backupDir, { recursive: true });
let store: Store | undefined;
try {
  const client = await pool.connect();
  const tables: Record<string, Record<string, unknown>[]> = {};
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const name of ['projects', 'chapters', 'chapter_versions', 'settings', 'foreshadows', 'reports', 'io_logs', 'generation_sessions', 'story_state_events']) {
      tables[name] = (await client.query(`SELECT * FROM ${name}`)).rows as Record<string, unknown>[];
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  // JSON also normalizes PostgreSQL timestamps to ISO strings.
  writeFileSync(join(backupDir, 'legacy-source.json'), JSON.stringify(tables, null, 2), { mode: 0o600 });
  const normalized = JSON.parse(JSON.stringify(tables)) as typeof tables;
  const books = (normalized.projects as unknown as LegacyProject[]).map(project => convertLegacyBook(project,
    (normalized.chapters as unknown as LegacyChapter[]).filter(chapter => chapter.project_id === project.id),
    normalized.chapter_versions as unknown as LegacyVersion[]));
  const backup: WorkspaceBackup = validateBackup({ format: 'shujian-backup', version: 1, exportedAt: new Date().toISOString(), books });
  const app = createApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/backup' });
    if (response.statusCode !== 200) throw new Error('无法备份当前作品库，导入已停止。');
    writeFileSync(join(backupDir, 'workspace-before.json'), response.body, { mode: 0o600 });
  } finally { await app.close(); }
  const config = process.env.NOVEL_DATA_DIR && !process.env.NOVEL_DATABASE_FILE && !process.env.NOVEL_DATABASE_URL
    ? { driver: 'sqlite' as const, filename: join(dataDir, 'workspace.sqlite') } : loadStorageConfig(projectRoot, dataDir).config;
  store = new Store(dataDir, config);
  const story = new StoryService(store);
  store.db.exec('CREATE TABLE IF NOT EXISTS legacy_imports(source TEXT NOT NULL,project_id TEXT NOT NULL,book_id TEXT NOT NULL,PRIMARY KEY(source,project_id))');
  const report = store.db.transaction(() => backup.books.map(entry => {
    const previous = store!.db.prepare('SELECT l.book_id FROM legacy_imports l JOIN books b ON b.id=l.book_id WHERE l.source=? AND l.project_id=?').get(source, entry.book.id) as { book_id: string } | undefined;
    if (previous) return { title: entry.book.title, skipped: true, bookId: previous.book_id };
    const book = store!.restoreBackup({ ...backup, books: [entry] })[0]!;
    const kinds: Record<string, StoryEntryKind> = { character: 'character', location: 'location', item: 'item', organization: 'organization', world: 'rule', rule: 'rule' };
    for (const row of normalized.settings!.filter(row => row.project_id === entry.book.id)) {
      story.saveEntry(book.id, { kind: kinds[String(row.type)] ?? 'note', authority: 'setting', title: String(row.name),
        content: [row.summary, row.traits && `特征：${row.traits}`, row.rules && `规则：${row.rules}`].filter(Boolean).join('\n'), status: 'confirmed' });
    }
    for (const row of normalized.foreshadows!.filter(row => row.project_id === entry.book.id)) {
      story.saveEntry(book.id, { kind: 'foreshadow', authority: 'setting', title: String(row.content).slice(0, 160) || '旧项目伏笔',
        content: ['content', 'planted_chapter', 'expected_payoff', 'related', 'status', 'warning'].map(key => `${key}：${row[key] ?? ''}`).join('\n'), status: 'idea' });
    }
    store!.db.prepare('INSERT INTO legacy_imports(source,project_id,book_id) VALUES(?,?,?) ON CONFLICT(source,project_id) DO UPDATE SET book_id=excluded.book_id').run(source, entry.book.id, book.id);
    return { title: book.title, chapters: book.chapterCount, words: book.wordCount, bookId: book.id };
  }))();
  writeFileSync(join(backupDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ backupDir, books: report }, null, 2));
} finally { store?.close(); await pool.end(); }
