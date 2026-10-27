import { createStore, set } from 'idb-keyval';
import { documentToText, type ManuscriptDocument } from '@shujian/contracts';

export interface RecoveryDraft {
  chapterId: string;
  sessionId: string;
  revision: number;
  legacy?: boolean;
  baseVersion: number;
  title: string;
  outline: string;
  document: ManuscriptDocument;
  updatedAt: string;
}

const store = createStore('shujian-drafts', 'recovery');
const key = (chapterId: string, sessionId: string) => `draft:${chapterId}:${sessionId}`;

/** Emergency exports preserve every editable text field, including outline-only changes. */
export function formatRecoveryText(draft: Pick<RecoveryDraft, 'title' | 'outline' | 'document'>): string {
  return `【章节名称】\n${draft.title}\n\n【本章意图】\n${draft.outline}\n\n【正文】\n${documentToText(draft.document)}\n`;
}

function isDraft(value: unknown, chapterId: string): value is RecoveryDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<RecoveryDraft>;
  return draft.chapterId === chapterId && typeof draft.title === 'string' && typeof draft.outline === 'string'
    && typeof draft.updatedAt === 'string' && typeof draft.baseVersion === 'number' && draft.document?.type === 'doc'
    && Array.isArray(draft.document.content);
}

/** Migrate the old chapter-only key and list every session in one transaction. */
export function loadRecoveries(chapterId: string): Promise<RecoveryDraft[]> {
  return store('readwrite', (records) => new Promise<RecoveryDraft[]>((resolve, reject) => {
    let result: RecoveryDraft[] = [];
    const transaction = records.transaction;
    transaction.oncomplete = () => resolve(result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('本机副本读取失败。'));
    const legacy = records.get(chapterId);
    legacy.onsuccess = () => {
      if (legacy.result !== undefined) {
        if (!isDraft(legacy.result, chapterId)) { transaction.abort(); return; }
        const migrated: RecoveryDraft = { ...legacy.result, sessionId: `legacy-${crypto.randomUUID()}`, revision: 0, legacy: true };
        records.put(migrated, key(chapterId, migrated.sessionId));
        records.delete(chapterId);
      }
      const prefix = key(chapterId, '');
      const all = records.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      all.onsuccess = () => { result = (all.result as unknown[]).filter((value): value is RecoveryDraft =>
        isDraft(value, chapterId) && typeof value.sessionId === 'string' && Number.isSafeInteger(value.revision)); };
    };
  }));
}

export const storeRecovery = (draft: RecoveryDraft) => set(key(draft.chapterId, draft.sessionId), draft, store);

/** An ACK may remove only this session's acknowledged edits, never a newer edit. */
export function clearRecovery(chapterId: string, sessionId: string, acknowledgedRevision: number): Promise<boolean> {
  return removeRecovery(chapterId, sessionId, (draft) => draft.revision <= acknowledgedRevision);
}

/** Export/discard must not remove a different revision created meanwhile in another tab. */
export function discardRecovery(snapshot: RecoveryDraft): Promise<boolean> {
  return removeRecovery(snapshot.chapterId, snapshot.sessionId,
    (draft) => draft.revision === snapshot.revision && draft.updatedAt === snapshot.updatedAt);
}

function removeRecovery(chapterId: string, sessionId: string, matches: (draft: RecoveryDraft) => boolean): Promise<boolean> {
  return store('readwrite', (records) => new Promise<boolean>((resolve, reject) => {
    let removed = false;
    const transaction = records.transaction;
    transaction.oncomplete = () => resolve(removed);
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('本机副本更新失败。'));
    const request = records.get(key(chapterId, sessionId));
    request.onsuccess = () => {
      const draft: unknown = request.result;
      if (draft === undefined) { removed = true; return; }
      if (isDraft(draft, chapterId) && draft.sessionId === sessionId && matches(draft)) {
        records.delete(key(chapterId, sessionId)); removed = true;
      }
    };
  }));
}
