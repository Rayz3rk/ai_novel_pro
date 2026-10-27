import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  countWords, documentToText, emptyDocument, textToDocument,
  type Book, type Chapter, type ChapterSummary, type CreateBookInput,
  type DocumentRevision, type ManuscriptDocument, type RevisionSummary, type SaveDraftInput,
  type UpdateBookInput, type WorkspaceBackup, type BackupBook, type JsonValue,
} from '@shujian/contracts';
import { AppError, conflict, notFound } from './errors.js';
import { migrate } from './migrations.js';
import { Sqlite } from './sqlite.js';
import { Postgres } from './postgres.js';
import type { Database } from './database.js';
import type { StorageConfig } from './storage-config.js';
import { document as validateDocument } from './validation.js';
import { documentToMarkdown, markdownHeading } from './markdown.js';
import { withParagraphIds } from './anchors.js';

interface BookRow {
  id: string; title: string; genre: string; premise: string; target_words: number; accent: string;
  created_at: string; updated_at: string; chapter_count: number; word_count: number;
}
interface ChapterRow {
  id: string; book_id: string; position: number; title: string; outline: string; document: string;
  plain_text: string; word_count: number; version: number; finalized_revision_id: string | null;
  created_at: string; updated_at: string; final_title: string | null; final_outline: string | null; final_document: string | null;
}
interface RevisionRow {
  id: string; chapter_id: string; label: string; kind: DocumentRevision['kind']; source_version: number;
  title: string; outline: string; document: string; plain_text: string; word_count: number; created_at: string;
}

const now = (): string => new Date().toISOString();
const BOOK_SELECT = `SELECT b.*, COUNT(c.id) AS chapter_count, COALESCE(SUM(c.word_count),0) AS word_count
  FROM books b LEFT JOIN chapters c ON c.book_id=b.id`;
const CHAPTER_SELECT = `SELECT c.*, r.title AS final_title, r.outline AS final_outline, r.document AS final_document
  FROM chapters c LEFT JOIN document_revisions r ON r.id=c.finalized_revision_id`;

function mapBook(row: BookRow): Book {
  return {
    id: row.id, title: row.title, genre: row.genre, premise: row.premise, targetWords: row.target_words,
    accent: row.accent, createdAt: row.created_at, updatedAt: row.updated_at,
    chapterCount: row.chapter_count, wordCount: row.word_count,
  };
}

function mapChapter(row: ChapterRow): Chapter {
  const status = row.finalized_revision_id === null ? 'draft'
    : row.title === row.final_title && row.outline === row.final_outline && row.document === row.final_document ? 'final' : 'revising';
  return {
    id: row.id, bookId: row.book_id, position: row.position, title: row.title, outline: row.outline,
    document: JSON.parse(row.document) as ManuscriptDocument, plainText: row.plain_text,
    wordCount: row.word_count, version: row.version, finalizedRevisionId: row.finalized_revision_id,
    status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapRevision(row: RevisionRow): DocumentRevision {
  return {
    id: row.id, chapterId: row.chapter_id, label: row.label, kind: row.kind, sourceVersion: row.source_version,
    title: row.title, outline: row.outline, document: JSON.parse(row.document) as ManuscriptDocument,
    plainText: row.plain_text, wordCount: row.word_count, createdAt: row.created_at,
  };
}

function chapterSummary(chapter: Chapter): ChapterSummary {
  const { document: _document, plainText: _plainText, createdAt: _createdAt, ...summary } = chapter;
  return summary;
}

export class Store {
  readonly db: Database;
  backupExtensions?: {
    exportBook: (bookId: string) => Record<string, JsonValue>;
    restoreBook: (entry: BackupBook, newBookId: string, ids: Record<string, string>) => void;
  };

  constructor(dataDir: string, storage: StorageConfig = { driver: 'sqlite', filename: join(dataDir, 'workspace.sqlite') }) {
    mkdirSync(dataDir, { recursive: true });
    if (storage.driver === 'sqlite') mkdirSync(dirname(storage.filename), { recursive: true });
    this.db = storage.driver === 'postgresql' ? new Postgres(storage.postgres) : new Sqlite(storage.filename);
    try {
      if (this.db.kind === 'sqlite') {
        this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
        this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
      }
      migrate(this.db);
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  private insertBookRow(row: Omit<Book, 'chapterCount' | 'wordCount'>): void {
    this.db.prepare('INSERT INTO books(id,title,genre,premise,target_words,accent,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(
      row.id, row.title, row.genre, row.premise, row.targetWords, row.accent, row.createdAt, row.updatedAt,
    );
  }

  private insertChapterRow(row: Omit<Chapter, 'status' | 'document'> & { document: string }): void {
    this.db.prepare('INSERT INTO chapters(id,book_id,position,title,outline,document,plain_text,word_count,version,finalized_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      row.id, row.bookId, row.position, row.title, row.outline, row.document, row.plainText,
      row.wordCount, row.version, row.finalizedRevisionId, row.createdAt, row.updatedAt,
    );
  }

  private insertRevisionRow(row: Omit<DocumentRevision, 'document'> & { document: string }): void {
    this.db.prepare('INSERT INTO document_revisions(id,chapter_id,label,kind,source_version,title,outline,document,plain_text,word_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      row.id, row.chapterId, row.label, row.kind, row.sourceVersion, row.title, row.outline,
      row.document, row.plainText, row.wordCount, row.createdAt,
    );
  }

  listBooks(): Book[] {
    return (this.db.prepare(`${BOOK_SELECT} GROUP BY b.id ORDER BY b.updated_at DESC, b.id`).all() as BookRow[]).map(mapBook);
  }

  getBook(id: string): Book {
    const row = this.db.prepare(`${BOOK_SELECT} WHERE b.id=? GROUP BY b.id`).get(id) as BookRow | undefined;
    return row ? mapBook(row) : notFound('作品');
  }

  createBook(input: CreateBookInput): Book {
    return this.db.transaction(() => {
      const id = randomUUID();
      const time = now();
      this.insertBookRow({
        id, title: input.title, genre: input.genre ?? '', premise: input.premise ?? '',
        targetWords: input.targetWords ?? 100_000, accent: input.accent ?? '#244a42', createdAt: time, updatedAt: time,
      });
      this.insertChapter(id, 1, '第一章', '', emptyDocument());
      return this.getBook(id);
    })();
  }

  updateBook(id: string, input: UpdateBookInput): Book {
    const previous = this.getBook(id);
    this.db.prepare('UPDATE books SET title=?,genre=?,premise=?,target_words=?,accent=?,updated_at=? WHERE id=?').run(
      input.title ?? previous.title, input.genre ?? previous.genre, input.premise ?? previous.premise,
      input.targetWords ?? previous.targetWords, input.accent ?? previous.accent, now(), id,
    );
    return this.getBook(id);
  }

  listChapters(bookId: string): ChapterSummary[] {
    this.getBook(bookId);
    return (this.db.prepare(`${CHAPTER_SELECT} WHERE c.book_id=? ORDER BY c.position`).all(bookId) as ChapterRow[]).map((row) => chapterSummary(mapChapter(row)));
  }

  getChapter(id: string): Chapter {
    const row = this.db.prepare(`${CHAPTER_SELECT} WHERE c.id=?`).get(id) as ChapterRow | undefined;
    return row ? mapChapter(row) : notFound('章节');
  }

  createChapter(bookId: string, title?: string, outline?: string): Chapter {
    return this.db.transaction(() => {
      this.getBook(bookId);
      const count = this.db.prepare('SELECT COALESCE(MAX(position),0) AS last FROM chapters WHERE book_id=?').get(bookId) as { last: number };
      const chapter = this.insertChapter(bookId, count.last + 1, title ?? `第${count.last + 1}章`, outline ?? '', emptyDocument());
      this.touchBook(bookId);
      return chapter;
    })();
  }

  private insertChapter(bookId: string, position: number, title: string, outline: string, document: ManuscriptDocument): Chapter {
    document = withParagraphIds(document);
    const id = randomUUID();
    const time = now();
    const text = documentToText(document);
    this.insertChapterRow({
      id, bookId, position, title, outline, document: JSON.stringify(document), plainText: text,
      wordCount: countWords(text), version: 1, finalizedRevisionId: null, createdAt: time, updatedAt: time,
    });
    return this.getChapter(id);
  }

  private touchBook(bookId: string): void {
    this.db.prepare('UPDATE books SET updated_at=? WHERE id=?').run(now(), bookId);
  }

  private expected(id: string, expectedVersion: number): Chapter {
    const chapter = this.getChapter(id);
    if (chapter.version !== expectedVersion) conflict(chapter.version);
    return chapter;
  }

  saveDraft(id: string, input: SaveDraftInput): Chapter {
    return this.db.transaction(() => {
      const chapter = this.expected(id, input.expectedVersion);
      const document = withParagraphIds(input.document);
      const text = documentToText(document);
      const result = this.db.prepare(`UPDATE chapters SET title=?,outline=?,document=?,plain_text=?,word_count=?,version=version+1,updated_at=? WHERE id=? AND version=?`).run(
        input.title, input.outline, JSON.stringify(document), text, countWords(text), now(), id, input.expectedVersion,
      );
      if (result.changes !== 1) conflict(this.getChapter(id).version);
      this.touchBook(chapter.bookId);
      return this.getChapter(id);
    })();
  }

  private insertRevision(chapter: Chapter, kind: DocumentRevision['kind'], label: string): DocumentRevision {
    const id = randomUUID();
    this.insertRevisionRow({
      id, chapterId: chapter.id, label, kind, sourceVersion: chapter.version,
      title: chapter.title, outline: chapter.outline, document: JSON.stringify(chapter.document), plainText: chapter.plainText,
      wordCount: chapter.wordCount, createdAt: now(),
    });
    return this.getRevision(chapter.id, id);
  }

  checkpoint(id: string, expectedVersion: number, label?: string): DocumentRevision {
    return this.db.transaction(() => this.insertRevision(this.expected(id, expectedVersion), 'checkpoint', label?.trim() || '手动存档'))();
  }

  listRevisions(chapterId: string): RevisionSummary[] {
    this.getChapter(chapterId);
    return (this.db.prepare('SELECT * FROM document_revisions WHERE chapter_id=? ORDER BY created_at DESC, rowid DESC').all(chapterId) as RevisionRow[]).map((row) => {
      const { title: _title, outline: _outline, document: _document, plainText: _text, ...summary } = mapRevision(row);
      return summary;
    });
  }

  getRevision(chapterId: string, id: string): DocumentRevision {
    const row = this.db.prepare('SELECT * FROM document_revisions WHERE id=? AND chapter_id=?').get(id, chapterId) as RevisionRow | undefined;
    return row ? mapRevision(row) : notFound('历史版本');
  }

  restoreChapter(id: string, expectedVersion: number, revisionId: string): Chapter {
    return this.db.transaction(() => {
      const chapter = this.expected(id, expectedVersion);
      const revision = this.getRevision(id, revisionId);
      this.insertRevision(chapter, 'before_restore', '恢复前自动存档');
      return this.saveDraft(id, { expectedVersion, title: revision.title, outline: revision.outline, document: revision.document });
    })();
  }

  finalize(id: string, expectedVersion: number): Chapter {
    return this.db.transaction(() => {
      const chapter = this.expected(id, expectedVersion);
      if (!chapter.plainText.trim()) throw new AppError(422, 'EMPTY_CHAPTER', '先写下正文，再为这一章定稿。');
      const previous = this.db.prepare("SELECT id FROM document_revisions WHERE chapter_id=? AND source_version=? AND kind='final'").get(id, expectedVersion) as { id: string } | undefined;
      if (previous && chapter.finalizedRevisionId === previous.id) return chapter;
      const revisionId = previous?.id ?? this.insertRevision(chapter, 'final', '作者定稿').id;
      this.db.prepare('UPDATE chapters SET finalized_revision_id=?,updated_at=? WHERE id=?').run(revisionId, now(), id);
      this.touchBook(chapter.bookId);
      return this.getChapter(id);
    })();
  }

  exportBook(id: string, format: 'txt' | 'md'): { book: Book; text: string } {
    return this.db.transaction(() => {
      const book = this.getBook(id);
      const chapters = this.listChapters(id).map((chapter) => this.getChapter(chapter.id));
      const heading = format === 'md' ? `# ${markdownHeading(book.title)}` : book.title;
      const body = chapters.map((chapter) => format === 'md'
        ? `## ${markdownHeading(chapter.title)}\n\n${documentToMarkdown(chapter.document)}`
        : `${chapter.title}\n\n${chapter.plainText}`).join('\n\n\n');
      return { book, text: `${heading}\n\n${body}\n` };
    }).deferred();
  }

  backup(): WorkspaceBackup {
    return this.db.transaction((): WorkspaceBackup => ({
      format: 'shujian-backup', version: 1, exportedAt: now(),
      books: this.listBooks().map((book) => ({
        book,
        ...(this.backupExtensions ? { extensions: this.backupExtensions.exportBook(book.id) } : {}),
        chapters: this.listChapters(book.id).map((chapter) => ({
          chapter: this.getChapter(chapter.id), revisions: this.listRevisions(chapter.id).map((revision) => this.getRevision(chapter.id, revision.id)),
        })),
      })),
    })).deferred();
  }

  restoreBackup(backup: WorkspaceBackup): Book[] {
    return this.db.transaction(() => {
      const imported: Book[] = [];
      for (const entry of backup.books) {
        const bookId = randomUUID();
        const ids: Record<string, string> = Object.create(null) as Record<string, string>;
        ids[entry.book.id] = bookId;
        const book = entry.book;
        this.insertBookRow({
          id: bookId, title: book.title, genre: book.genre, premise: book.premise,
          targetWords: book.targetWords, accent: book.accent, createdAt: book.createdAt, updatedAt: now(),
        });
        for (const chapterEntry of entry.chapters) {
          const chapter = chapterEntry.chapter;
          const chapterId = randomUUID();
          ids[chapter.id] = chapterId;
          const revisionIds = new Map(chapterEntry.revisions.map((revision) => [revision.id, randomUUID()]));
          for (const [oldId, newId] of revisionIds) ids[oldId] = newId;
          this.insertChapterRow({
            id: chapterId, bookId, position: chapter.position, title: chapter.title, outline: chapter.outline,
            document: JSON.stringify(chapter.document), plainText: chapter.plainText, wordCount: chapter.wordCount,
            version: chapter.version, finalizedRevisionId: null, createdAt: chapter.createdAt, updatedAt: chapter.updatedAt,
          });
          for (const revision of chapterEntry.revisions) {
            this.insertRevisionRow({
              id: revisionIds.get(revision.id)!, chapterId, label: revision.label, kind: revision.kind,
              sourceVersion: revision.sourceVersion, title: revision.title, outline: revision.outline,
              document: JSON.stringify(revision.document), plainText: revision.plainText, wordCount: revision.wordCount, createdAt: revision.createdAt,
            });
          }
          if (chapter.finalizedRevisionId !== null) {
            this.db.prepare('UPDATE chapters SET finalized_revision_id=? WHERE id=?').run(revisionIds.get(chapter.finalizedRevisionId)!, chapterId);
          }
        }
        this.backupExtensions?.restoreBook(entry, bookId, ids);
        imported.push(this.getBook(bookId));
      }
      return imported;
    })();
  }

  importText(filename: string, text: string, title?: string): { book: Book; chapters: ChapterSummary[] } {
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!normalized.trim()) throw new AppError(422, 'EMPTY_IMPORT', '文件里还没有正文。');
    const parts: Array<{ title: string; text: string }> = [];
    let current = { title: '序章', text: '' };
    for (const line of normalized.split('\n')) {
      const heading = /^(?:#{1,3}\s+(.+)|\s*(第[零〇一二三四五六七八九十百千万两\d]+[章节卷回][^\n]{0,100}))\s*$/.exec(line);
      if (heading) {
        if (current.text.trim() || current.title !== '序章') parts.push(current);
        current = { title: (heading[1] ?? heading[2] ?? '').trim().slice(0, 200), text: '' };
      } else {
        current.text += `${current.text ? '\n' : ''}${line}`;
      }
    }
    if (current.text.trim() || current.title !== '序章') parts.push(current);
    if (parts.length > 1_000) throw new AppError(400, 'VALIDATION_ERROR', '一次最多导入 1000 个章节。');
    const documents = parts.map((part) => validateDocument(textToDocument(part.text)));
    return this.db.transaction(() => {
      const bookId = randomUUID();
      const time = now();
      const fallbackTitle = filename.replace(/\.(txt|md|markdown)$/i, '').split(/[\\/]/).pop()?.slice(0, 120) || '导入的作品';
      this.insertBookRow({
        id: bookId, title: title?.trim() || fallbackTitle, genre: '', premise: '', targetWords: 100_000,
        accent: '#6a6051', createdAt: time, updatedAt: time,
      });
      for (const [index, part] of parts.entries()) this.insertChapter(bookId, index + 1, parts.length === 1 && part.title === '序章' ? '第一章' : part.title, '', documents[index]!);
      return { book: this.getBook(bookId), chapters: this.listChapters(bookId) };
    })();
  }
}
