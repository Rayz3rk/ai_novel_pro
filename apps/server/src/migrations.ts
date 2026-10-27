import type { Database } from './database.js';

/** Explicit, ordered SQL migrations applied atomically using SQLite user_version. */
const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE books (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, genre TEXT NOT NULL, premise TEXT NOT NULL,
      target_words INTEGER NOT NULL CHECK(target_words >= 0), accent TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position > 0), title TEXT NOT NULL, outline TEXT NOT NULL,
      document TEXT NOT NULL, plain_text TEXT NOT NULL, word_count INTEGER NOT NULL CHECK(word_count >= 0),
      version INTEGER NOT NULL CHECK(version >= 1),
      finalized_revision_id TEXT REFERENCES document_revisions(id) DEFERRABLE INITIALLY DEFERRED,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(book_id, position)
    );
    CREATE TABLE document_revisions (
      id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      label TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('checkpoint','final','before_restore')),
      source_version INTEGER NOT NULL CHECK(source_version >= 1),
      title TEXT NOT NULL, outline TEXT NOT NULL, document TEXT NOT NULL, plain_text TEXT NOT NULL,
      word_count INTEGER NOT NULL CHECK(word_count >= 0), created_at TEXT NOT NULL
    );
    CREATE INDEX chapter_book_order ON chapters(book_id, position);
    CREATE INDEX revision_chapter_time ON document_revisions(chapter_id, created_at DESC);
    CREATE UNIQUE INDEX final_revision_once ON document_revisions(chapter_id, source_version) WHERE kind='final';
  `,
}];

export function migrate(db: Database): void {
  if (db.kind === 'postgresql') db.exec('CREATE TABLE IF NOT EXISTS shujian_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL)');
  const current = db.kind === 'sqlite' ? db.pragma('user_version', { simple: true }) as number
    : (db.prepare('SELECT version FROM shujian_schema WHERE singleton=1').get() as {version:number}|undefined)?.version ?? 0;
  if (current > migrations.length) throw new Error('数据库由较新版本创建，请使用对应版本的书间。');
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      const sql = db.kind === 'postgresql' ? migration.sql.replace('finalized_revision_id TEXT REFERENCES document_revisions(id) DEFERRABLE INITIALLY DEFERRED', 'finalized_revision_id TEXT') : migration.sql;
      db.exec(sql);
      if (db.kind === 'sqlite') db.pragma(`user_version = ${migration.version}`);
      else {
        if (migration.version === 1) db.exec('ALTER TABLE chapters ADD CONSTRAINT chapters_finalized_revision_fk FOREIGN KEY(finalized_revision_id) REFERENCES document_revisions(id) DEFERRABLE INITIALLY DEFERRED');
        db.prepare('INSERT INTO shujian_schema(singleton,version) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version').run(migration.version);
      }
    })();
  }
}
