import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  Book,
  Chapter,
  ChapterSummary,
  DocumentRevision,
  ManuscriptDocument,
  RevisionSummary,
  SaveDraftInput,
  WorkspaceBackup,
} from '../../packages/contracts/src/index.js';
import { storageHarness } from './storage-harness.js';
const harness = storageHarness('workspace');
const createApp = harness.createApp;

type App = Awaited<ReturnType<typeof createApp>>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

const firstDocument: ManuscriptDocument = {
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { uid: 'rain-1' }, content: [{ type: 'text', text: '雨落青石。🕯️' }] },
    {
      type: 'paragraph',
      attrs: { uid: 'rain-2' },
      content: [{ type: 'text', text: '她说：“等我回来。”', marks: [{ type: 'bold' }] }],
    },
  ],
};

const secondDocument: ManuscriptDocument = {
  type: 'doc',
  content: [{ type: 'paragraph', attrs: { uid: 'rain-1' }, content: [{ type: 'text', text: '雨停了，信却没有送到。' }] }],
};

function oneParagraph(text: string): ManuscriptDocument {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

describe('M1 reliable manuscript workspace', () => {
  let app: App;
  let dataDir: string;

  beforeEach(async () => {
    harness.reset();
    dataDir = await mkdtemp(join(tmpdir(), 'shujian-m1-'));
    app = await createApp({ dataDir, credentialDir: join(dataDir, 'credentials'), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    const safeDir = resolve(dataDir);
    if (dirname(safeDir) !== resolve(tmpdir()) || !basename(safeDir).startsWith('shujian-m1-')) {
      throw new Error(`Refusing to clean an unexpected test directory: ${safeDir}`);
    }
    await rm(safeDir, { recursive: true, force: true });
  });

  async function success<T>(method: Method, url: string, payload?: object): Promise<T> {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBeGreaterThanOrEqual(200);
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBeLessThan(300);
    return response.json<T>();
  }

  async function createBook(title = '雾港来信'): Promise<{ book: Book; chapter: Chapter }> {
    const { book } = await success<{ book: Book }>('POST', '/api/books', {
      title,
      genre: '悬疑',
      premise: '一封没有收件人的信，改变了小城的冬天。',
      targetWords: 120_000,
      accent: '#163c36',
    });
    const { chapters } = await success<{ chapters: ChapterSummary[] }>('GET', `/api/books/${book.id}/chapters`);
    expect(chapters).toHaveLength(1);
    const first = chapters[0];
    if (!first) throw new Error('Creating a book must create its first chapter');
    const { chapter } = await success<{ chapter: Chapter }>('GET', `/api/chapters/${first.id}`);
    return { book, chapter };
  }

  async function save(chapter: Chapter, document: ManuscriptDocument, title = chapter.title, outline = chapter.outline) {
    const payload: SaveDraftInput = { expectedVersion: chapter.version, title, outline, document };
    return (await success<{ chapter: Chapter }>('PUT', `/api/chapters/${chapter.id}/draft`, payload)).chapter;
  }

  async function getChapter(id: string) {
    return (await success<{ chapter: Chapter }>('GET', `/api/chapters/${id}`)).chapter;
  }

  async function versions(id: string) {
    return (await success<{ versions: RevisionSummary[] }>('GET', `/api/chapters/${id}/versions`)).versions;
  }

  async function revision(chapterId: string, revisionId: string) {
    return (await success<{ version: DocumentRevision }>('GET', `/api/chapters/${chapterId}/versions/${revisionId}`)).version;
  }

  it('starts empty and creates a real first chapter with the book', async () => {
    expect(await success('GET', '/api/health')).toMatchObject({ ok: true });
    expect((await success<{ books: Book[] }>('GET', '/api/books')).books).toEqual([]);

    const { book, chapter } = await createBook();
    expect(book.title).toBe('雾港来信');
    expect(book.chapterCount).toBe(1);
    expect(book.wordCount).toBe(0);
    expect(chapter).toMatchObject({ bookId: book.id, position: 1, status: 'draft', wordCount: 0 });
    expect(chapter.document.type).toBe('doc');
    expect(Number.isInteger(chapter.version)).toBe(true);
  });

  it('preserves Chinese, emoji, formatting, title and outline across a real database restart', async () => {
    const { book, chapter } = await createBook();
    const saved = await save(chapter, firstDocument, '第一章 雨声', '她决定留下，等待那封信。');
    expect(saved.version).toBe(chapter.version + 1);
    expect(saved.wordCount).toBe(10);
    expect(saved.plainText).toBe('雨落青石。🕯️\n\n她说：“等我回来。”');

    await app.close();
    app = await createApp({ dataDir, credentialDir: join(dataDir, 'credentials'), logger: false });
    await app.ready();
    const restored = await getChapter(chapter.id);
    expect(restored).toMatchObject({
      version: saved.version,
      title: '第一章 雨声',
      outline: '她决定留下，等待那封信。',
      document: firstDocument,
      wordCount: 10,
    });
    const { book: reloadedBook } = await success<{ book: Book }>('GET', `/api/books/${book.id}`);
    expect(reloadedBook.wordCount).toBe(10);
  });

  it('rejects stale saves without overwriting newer title, outline or manuscript', async () => {
    const { chapter } = await createBook();
    const latest = await save(chapter, firstDocument, '新的章名', '已确认的新章纲');
    const response = await app.inject({
      method: 'PUT',
      url: `/api/chapters/${chapter.id}/draft`,
      payload: { expectedVersion: chapter.version, title: '旧章名', outline: '旧章纲', document: secondDocument },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<ApiErrorBody>().error.code).toBe('VERSION_CONFLICT');
    expect(await getChapter(chapter.id)).toMatchObject({
      version: latest.version,
      title: '新的章名',
      outline: '已确认的新章纲',
      document: firstDocument,
    });
  });

  it('allows exactly one of two competing saves based on the same version', async () => {
    const { chapter } = await createBook();
    const payload = { expectedVersion: chapter.version, title: chapter.title, outline: chapter.outline };
    const responses = await Promise.all([
      app.inject({ method: 'PUT', url: `/api/chapters/${chapter.id}/draft`, payload: { ...payload, document: firstDocument } }),
      app.inject({ method: 'PUT', url: `/api/chapters/${chapter.id}/draft`, payload: { ...payload, document: secondDocument } }),
    ]);
    expect(responses.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.find((result) => result.statusCode === 200);
    if (!winner) throw new Error('Expected one committed save');
    const committed = winner.json<{ chapter: Chapter }>().chapter;
    expect((await getChapter(chapter.id)).document).toEqual(committed.document);
    expect(committed.version).toBe(chapter.version + 1);
  });

  it('keeps immutable checkpoints and saves the current draft before restoring an old version', async () => {
    const { chapter } = await createBook();
    const original = await save(chapter, firstDocument, '第一章 雨声', '最初的章纲');
    const { version: checkpoint } = await success<{ version: DocumentRevision }>('POST', `/api/chapters/${chapter.id}/versions`, {
      expectedVersion: original.version,
      label: '分岔前',
    });
    const changed = await save(original, secondDocument, '第一章 雨后', '重新写过的章纲');
    expect((await revision(chapter.id, checkpoint.id)).document).toEqual(firstDocument);

    const { chapter: restored } = await success<{ chapter: Chapter }>('POST', `/api/chapters/${chapter.id}/restore`, {
      expectedVersion: changed.version,
      revisionId: checkpoint.id,
    });
    expect(restored.version).toBeGreaterThan(changed.version);
    expect(restored).toMatchObject({ title: original.title, outline: original.outline, document: firstDocument });
    const history = await versions(chapter.id);
    expect(history.some((item) => item.id === checkpoint.id)).toBe(true);
    const beforeRestore = history.find((item) => item.kind === 'before_restore');
    expect(beforeRestore).toBeDefined();
    if (!beforeRestore) throw new Error('The overwritten working draft must remain recoverable');
    expect(await revision(chapter.id, beforeRestore.id)).toMatchObject({
      title: changed.title,
      outline: changed.outline,
      document: secondDocument,
    });
    expect((await revision(chapter.id, checkpoint.id)).document).toEqual(firstDocument);
  });

  it('refuses a stale restore and leaves both the new draft and version history untouched', async () => {
    const { chapter } = await createBook();
    const original = await save(chapter, firstDocument);
    const { version: checkpoint } = await success<{ version: DocumentRevision }>('POST', `/api/chapters/${chapter.id}/versions`, {
      expectedVersion: original.version,
    });
    const latest = await save(original, secondDocument);
    const historyBefore = await versions(chapter.id);
    const response = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapter.id}/restore`,
      payload: { expectedVersion: original.version, revisionId: checkpoint.id },
    });
    expect(response.statusCode).toBe(409);
    expect((await getChapter(chapter.id)).document).toEqual(latest.document);
    expect(await versions(chapter.id)).toEqual(historyBefore);
  });

  it('cannot restore another chapter\'s valid revision into the target chapter', async () => {
    const { book, chapter } = await createBook();
    const target = await save(chapter, firstDocument);
    const { chapter: sibling } = await success<{ chapter: Chapter }>('POST', `/api/books/${book.id}/chapters`, { title: '第二章' });
    const savedSibling = await save(sibling, secondDocument);
    const { version: foreignRevision } = await success<{ version: DocumentRevision }>('POST', `/api/chapters/${sibling.id}/versions`, {
      expectedVersion: savedSibling.version,
    });
    const historyBefore = await versions(target.id);
    const response = await app.inject({
      method: 'POST',
      url: `/api/chapters/${target.id}/restore`,
      payload: { expectedVersion: target.version, revisionId: foreignRevision.id },
    });
    expect(response.statusCode).toBe(404);
    expect(await getChapter(target.id)).toMatchObject({ version: target.version, document: firstDocument });
    expect(await versions(target.id)).toEqual(historyBefore);
    expect((await revision(sibling.id, foreignRevision.id)).document).toEqual(secondDocument);
  });

  it('rejects empty finalization, deduplicates retries and distinguishes revised drafts from the final', async () => {
    const { chapter } = await createBook();
    const emptyResponse = await app.inject({ method: 'POST', url: `/api/chapters/${chapter.id}/finalize`, payload: { expectedVersion: chapter.version } });
    expect(emptyResponse.statusCode).toBe(422);
    expect(await versions(chapter.id)).toHaveLength(0);

    const draft = await save(chapter, firstDocument);
    const { chapter: final } = await success<{ chapter: Chapter }>('POST', `/api/chapters/${chapter.id}/finalize`, { expectedVersion: draft.version });
    const { chapter: retry } = await success<{ chapter: Chapter }>('POST', `/api/chapters/${chapter.id}/finalize`, { expectedVersion: draft.version });
    expect(final.status).toBe('final');
    expect(final.finalizedRevisionId).toBeTruthy();
    expect(retry.finalizedRevisionId).toBe(final.finalizedRevisionId);
    expect((await versions(chapter.id)).filter((item) => item.kind === 'final')).toHaveLength(1);

    const revised = await save(final, secondDocument);
    expect(revised.status).toBe('revising');
    expect(revised.finalizedRevisionId).toBe(final.finalizedRevisionId);
    const { chapter: newFinal } = await success<{ chapter: Chapter }>('POST', `/api/chapters/${chapter.id}/finalize`, { expectedVersion: revised.version });
    expect(newFinal.status).toBe('final');
    expect(newFinal.finalizedRevisionId).not.toBe(final.finalizedRevisionId);
    expect((await versions(chapter.id)).filter((item) => item.kind === 'final')).toHaveLength(2);
  });

  it('exports and restores an empty workspace without creating placeholder books', async () => {
    const backup = await success<WorkspaceBackup>('GET', '/api/backup');
    expect(backup).toMatchObject({ format: 'shujian-backup', version: 1, books: [] });
    expect((await success<{ books: Book[] }>('POST', '/api/backup/restore', { backup })).books).toEqual([]);
    expect((await success<{ books: Book[] }>('GET', '/api/books')).books).toEqual([]);
  });

  it('restores a complete backup as new books, remapping identities while preserving drafts, finals and history', async () => {
    const { book, chapter } = await createBook('雾港来信');
    const first = await save(chapter, firstDocument, '第一章 雨声', '等待');
    await success('POST', `/api/chapters/${chapter.id}/versions`, { expectedVersion: first.version, label: '最初的开头' });
    const second = await save(first, secondDocument, '第一章 雨后', '决定离开');
    const { chapter: final } = await success<{ chapter: Chapter }>('POST', `/api/chapters/${chapter.id}/finalize`, { expectedVersion: second.version });
    const current = await save(final, oneParagraph('她重新拿起那封信。'), '第一章 雨后', '尚未定稿的新结尾');
    const { chapter: next } = await success<{ chapter: Chapter }>('POST', `/api/books/${book.id}/chapters`, { title: '第二章 来客', outline: '新角色到来' });
    await save(next, oneParagraph('来客带来了北方的消息。'));
    const other = await createBook('另一部长篇');
    await save(other.chapter, oneParagraph('另一个故事，不应与雾港混在一起。'));

    const backup = await success<WorkspaceBackup>('GET', '/api/backup');
    expect(backup.books).toHaveLength(2);
    const { books: importedBooks } = await success<{ books: Book[] }>('POST', '/api/backup/restore', { backup });
    expect(importedBooks).toHaveLength(2);
    expect((await success<{ books: Book[] }>('GET', '/api/books')).books).toHaveLength(4);
    const importedBook = importedBooks.find((candidate) => candidate.title.startsWith(book.title));
    if (!importedBook) throw new Error('Expected a restored copy of the original book');
    expect(importedBook.id).not.toBe(book.id);
    expect(importedBook).toMatchObject({ genre: book.genre, premise: book.premise, targetWords: book.targetWords, accent: book.accent, chapterCount: 2 });
    const { chapters } = await success<{ chapters: ChapterSummary[] }>('GET', `/api/books/${importedBook.id}/chapters`);
    const firstImported = chapters.find((candidate) => candidate.position === 1);
    if (!firstImported) throw new Error('Restored chapter order was lost');
    expect(firstImported.id).not.toBe(chapter.id);
    const restoredDraft = await getChapter(firstImported.id);
    expect(restoredDraft).toMatchObject({
      title: current.title,
      outline: current.outline,
      document: current.document,
      version: current.version,
      status: 'revising',
    });
    expect(restoredDraft.finalizedRevisionId).toBeTruthy();
    expect(restoredDraft.finalizedRevisionId).not.toBe(current.finalizedRevisionId);
    if (!restoredDraft.finalizedRevisionId) throw new Error('Finalized revision pointer was not restored');
    expect((await revision(firstImported.id, restoredDraft.finalizedRevisionId)).document).toEqual(secondDocument);
    const restoredVersions = await versions(firstImported.id);
    expect(restoredVersions).toHaveLength((await versions(chapter.id)).length);
    expect(restoredVersions.map((item) => item.kind).sort()).toEqual((await versions(chapter.id)).map((item) => item.kind).sort());
    expect(restoredVersions.some((item) => item.label === '最初的开头')).toBe(true);
    expect((await getChapter(chapter.id)).document).toEqual(current.document);
  });

  it('validates a whole backup before import, leaving no partial books after an invalid later entry', async () => {
    const first = await createBook('第一部');
    await save(first.chapter, firstDocument);
    await createBook('第二部');
    const backup = await success<WorkspaceBackup>('GET', '/api/backup');
    const invalid = structuredClone(backup);
    const laterChapter = invalid.books[1]?.chapters[0]?.chapter;
    if (!laterChapter) throw new Error('Test requires two complete source books');
    laterChapter.finalizedRevisionId = 'missing-revision-reference';
    const before = (await success<{ books: Book[] }>('GET', '/api/books')).books;
    const response = await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { backup: invalid } });
    expect([400, 422]).toContain(response.statusCode);
    expect((await success<{ books: Book[] }>('GET', '/api/books')).books).toEqual(before);
    expect((await getChapter(first.chapter.id)).document).toEqual(firstDocument);
  });

  it('can repeatedly back up and restore a maximum-length title without changing titles or overwriting existing books', async () => {
    const title = '雨'.repeat(120);
    const { book, chapter } = await createBook(title);
    const saved = await save(chapter, firstDocument);

    const firstBackup = await success<WorkspaceBackup>('GET', '/api/backup');
    expect(firstBackup.books).toHaveLength(1);
    const { books: firstCopies } = await success<{ books: Book[] }>('POST', '/api/backup/restore', { backup: firstBackup });
    expect(firstCopies).toHaveLength(1);
    expect(firstCopies[0]).toMatchObject({ title });
    expect(firstCopies[0]?.id).not.toBe(book.id);

    const secondBackup = await success<WorkspaceBackup>('GET', '/api/backup');
    expect(secondBackup.books).toHaveLength(2);
    expect(secondBackup.books.every((entry) => entry.book.title === title)).toBe(true);
    const existingIds = new Set(secondBackup.books.map((entry) => entry.book.id));
    const { books: secondCopies } = await success<{ books: Book[] }>('POST', '/api/backup/restore', { backup: secondBackup });
    expect(secondCopies).toHaveLength(2);
    expect(secondCopies.every((copy) => copy.title === title && !existingIds.has(copy.id))).toBe(true);

    const allBooks = (await success<{ books: Book[] }>('GET', '/api/books')).books;
    expect(allBooks).toHaveLength(4);
    expect(new Set(allBooks.map((entry) => entry.id)).size).toBe(4);
    expect(allBooks.every((entry) => entry.title === title)).toBe(true);
    expect((await success<{ book: Book }>('GET', `/api/books/${book.id}`)).book.title).toBe(title);
    expect(await getChapter(chapter.id)).toMatchObject({ version: saved.version, document: firstDocument });
    for (const copy of [...firstCopies, ...secondCopies]) {
      const { chapters } = await success<{ chapters: ChapterSummary[] }>('GET', `/api/books/${copy.id}/chapters`);
      expect(chapters).toHaveLength(1);
      const copiedChapter = chapters[0];
      if (!copiedChapter) throw new Error('A restored book lost its manuscript');
      expect(copiedChapter.id).not.toBe(chapter.id);
      expect((await getChapter(copiedChapter.id)).document).toEqual(firstDocument);
    }
  });

  it('rejects an unsupported backup schema without changing existing books', async () => {
    await createBook('保留现有作品');
    const backup = await success<WorkspaceBackup>('GET', '/api/backup');
    const before = (await success<{ books: Book[] }>('GET', '/api/books')).books;
    const response = await app.inject({
      method: 'POST', url: '/api/backup/restore', payload: { backup: { ...backup, version: 999 } },
    });
    expect([400, 422]).toContain(response.statusCode);
    expect((await success<{ books: Book[] }>('GET', '/api/books')).books).toEqual(before);
  });

  it('rejects a backup final pointer to a valid revision belonging to another chapter', async () => {
    const { book, chapter } = await createBook();
    const first = await save(chapter, firstDocument);
    await success('POST', `/api/chapters/${first.id}/finalize`, { expectedVersion: first.version });
    const { chapter: sibling } = await success<{ chapter: Chapter }>('POST', `/api/books/${book.id}/chapters`, { title: '第二章' });
    const second = await save(sibling, secondDocument);
    const { chapter: siblingFinal } = await success<{ chapter: Chapter }>('POST', `/api/chapters/${second.id}/finalize`, { expectedVersion: second.version });
    const backup = await success<WorkspaceBackup>('GET', '/api/backup');
    const invalid = structuredClone(backup);
    const firstEntry = invalid.books[0]?.chapters.find((item) => item.chapter.id === first.id);
    if (!firstEntry || !siblingFinal.finalizedRevisionId) throw new Error('Test requires two finalized chapters');
    firstEntry.chapter.finalizedRevisionId = siblingFinal.finalizedRevisionId;
    const before = (await success<{ books: Book[] }>('GET', '/api/books')).books;
    const response = await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { backup: invalid } });
    expect([400, 422]).toContain(response.statusCode);
    expect((await success<{ books: Book[] }>('GET', '/api/books')).books).toEqual(before);
    expect((await getChapter(first.id)).document).toEqual(firstDocument);
  });

  it('exports current working text and imports Chinese TXT / Markdown chapters without losing prose', async () => {
    const { book, chapter } = await createBook();
    const draft = await save(chapter, firstDocument, '第一章 雨声');
    for (const format of ['txt', 'md']) {
      const response = await app.inject({ method: 'GET', url: `/api/books/${book.id}/export?format=${format}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.body).toContain(book.title);
      expect(response.body).toContain(draft.title);
      expect(response.body).toContain('雨落青石。🕯️');
      expect(response.body).toContain('她说：“等我回来。”');
    }

    for (const [filename, text] of [
      ['雨港.txt', '第一章 雨声\r\n\r\n雨打在旧邮局的玻璃上。\r\n\r\n第二章 来客\r\n\r\n她推门进来。🕯️'],
      ['雨港.md', '# 第一章 雨声\n\n雨打在旧邮局的玻璃上。\n\n# 第二章 来客\n\n她推门进来。🕯️'],
    ] as const) {
      const imported = await success<{ book: Book; chapters: ChapterSummary[] }>('POST', '/api/import', { filename, text });
      expect(imported.chapters).toHaveLength(2);
      expect(imported.book.id).not.toBe(book.id);
      const importedText = (await Promise.all(imported.chapters.map((item) => getChapter(item.id)))).map((item) => item.plainText).join('\n');
      expect(importedText).toContain('雨打在旧邮局的玻璃上。');
      expect(importedText).toContain('她推门进来。🕯️');
    }
  });

  it('rejects unsupported document nodes without changing the saved chapter version', async () => {
    const { chapter } = await createBook();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/chapters/${chapter.id}/draft`,
      payload: {
        expectedVersion: chapter.version,
        title: chapter.title,
        outline: '',
        document: { type: 'doc', content: [{ type: 'script', text: '<script>unexpected</script>' }] },
      },
    });
    expect([400, 422]).toContain(response.statusCode);
    expect((await getChapter(chapter.id)).version).toBe(chapter.version);
    expect((await getChapter(chapter.id)).plainText).toBe(chapter.plainText);
  });

  it.each([
    {
      description: 'block nodes nested inside a paragraph',
      document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'paragraph', content: [{ type: 'text', text: '不能丢失的稿子' }] }] }] },
    },
    {
      description: 'plain text directly inside a list',
      document: { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'text', text: '必须先有列表项' }] }] },
    },
  ])('rejects $description instead of storing a document the editor cannot load', async ({ document }) => {
    const { chapter } = await createBook();
    const saved = await save(chapter, firstDocument);
    const response = await app.inject({
      method: 'PUT', url: `/api/chapters/${chapter.id}/draft`,
      payload: { expectedVersion: saved.version, title: saved.title, outline: saved.outline, document },
    });
    expect([400, 422]).toContain(response.statusCode);
    expect(await getChapter(chapter.id)).toMatchObject({ version: saved.version, document: firstDocument });
  });

  it('keeps list item boundaries in saved plain text and TXT exports', async () => {
    const { book, chapter } = await createBook();
    const document: ManuscriptDocument = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '灯在门边。' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '信在抽屉。' }] }] },
          ],
        },
      ],
    };
    const saved = await save(chapter, document);
    expect(saved.plainText).toContain('灯在门边。\n信在抽屉。');
    const response = await app.inject({ method: 'GET', url: `/api/books/${book.id}/export?format=txt` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('灯在门边。\n信在抽屉。');
  });
});
