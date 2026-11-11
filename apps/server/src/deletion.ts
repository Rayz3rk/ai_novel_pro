import { AppError, conflict } from './errors.js';
import type { Store } from './store.js';
import type { ManuscriptLifecycle } from './manuscript-lifecycle.js';
import type { BackupManager } from './backups.js';

/** Delete within one transaction, keeping a restorable local safety copy first. */
export function deleteManuscript(store: Store, services: { lifecycle: ManuscriptLifecycle; backups: BackupManager }, bookId: string, chapterId?: string, expectedVersion?: number): void {
  store.db.transaction(() => {
    store.getBook(bookId);
    if (chapterId) {
      const chapter = store.getChapter(chapterId);
      if (chapter.version !== expectedVersion) conflict(chapter.version);
      if (chapter.bookId !== bookId) throw new AppError(404, 'NOT_FOUND', '章节不存在。');
      const references = services.lifecycle.chapterReferences(chapterId);
      if (references.length) throw new AppError(409, 'CHAPTER_IN_USE', `此章有 ${references.length} 处引用。请查看引用明细；可以归档章节，完整保留原文和出处。`);
    }
    services.backups.create(bookId, 'before-delete');

    const column = chapterId ? 'chapter_id' : 'book_id';
    const id = chapterId ?? bookId;
    // Billing history survives deletion so deleting a book cannot reset today's budget.
    const calls = store.db.prepare(`SELECT id,payload FROM ai_calls WHERE job_id IN (SELECT id FROM ai_jobs WHERE ${column}=?)`).all(id) as { id: string; payload: string }[];
    for (const call of calls) {
      const payload = JSON.parse(call.payload) as Record<string, unknown>;
      payload.jobId = null;
      delete payload.output;
      delete payload.requestMessages;
      delete payload.promptHash;
      store.db.prepare('UPDATE ai_calls SET job_id=NULL,payload=? WHERE id=?').run(JSON.stringify(payload), call.id);
    }
    store.db.prepare(`DELETE FROM ai_events WHERE job_id IN (SELECT id FROM ai_jobs WHERE ${column}=?)`).run(id);
    services.lifecycle.deleteRecords(bookId, chapterId);
    store.db.prepare(`UPDATE chapters SET finalized_revision_id=NULL WHERE ${chapterId ? 'id' : 'book_id'}=?`).run(id);
    store.db.prepare(`DELETE FROM chapters WHERE ${chapterId ? 'id' : 'book_id'}=?`).run(id);
    if (chapterId) store.db.prepare('UPDATE books SET updated_at=? WHERE id=?').run(new Date().toISOString(), bookId);
    else store.db.prepare('DELETE FROM books WHERE id=?').run(bookId);
  })();
}
