import type { Database } from '../database.js';

/** Story data is versioned separately from manuscript migrations. */
export function migrateStory(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_entries (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS story_entries_book ON story_entries(book_id,status);
    CREATE TABLE IF NOT EXISTS story_events (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL REFERENCES story_entries(id), payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS story_events_entry ON story_events(entry_id,created_at);
    CREATE TABLE IF NOT EXISTS story_proposals (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id), job_id TEXT NOT NULL,
      payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS story_proposals_book ON story_proposals(book_id);
    CREATE TABLE IF NOT EXISTS story_reviews (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id), job_id TEXT NOT NULL,
      payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS story_reviews_chapter ON story_reviews(chapter_id,created_at);
    CREATE TABLE IF NOT EXISTS story_dependencies (
      job_id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id), payload TEXT NOT NULL
    );
  `);
}
