import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Book, Chapter, ChapterSummary, ChapterReference, WorkspaceBackup, BackupSummary, BackupCatalog, BackupCleanup, ModelSettings } from '@shujian/contracts';
import { storageHarness } from './storage-harness.js';
import { Store } from '../../apps/server/src/store.js';
import { ManuscriptLifecycle } from '../../apps/server/src/manuscript-lifecycle.js';

const harness = storageHarness('optimization');
describe('workspace optimization', () => {
  let dataDir: string;
  let app: ReturnType<typeof harness.createApp>;
  beforeEach(async () => {
    harness.reset();
    dataDir = await mkdtemp(join(tmpdir(), 'shujian-optimization-'));
    app = harness.createApp({ dataDir, credentialDir: join(dataDir, 'credentials') });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('shujian-optimization-')) throw new Error('Unexpected cleanup path');
    await rm(dataDir, { recursive: true, force: true });
  });
  async function success<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object): Promise<T> {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200);
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json<T>();
  }
  async function create(title = '优化验收') {
    const { book } = await success<{book: Book}>('POST', '/api/books', { title });
    const { chapters } = await success<{chapters: ChapterSummary[]}>('GET', `/api/books/${book.id}/chapters`);
    return { book, chapter: (await success<{chapter: Chapter}>('GET', `/api/chapters/${chapters[0]!.id}`)).chapter };
  }
  it('shows exact current and historical reference locations, archives without losing evidence and restores archives', async () => {
    const { book, chapter } = await create();
    const { chapter: saved } = await success<{chapter: Chapter}>('PUT', `/api/chapters/${chapter.id}/draft`, { expectedVersion: 1, title: chapter.title, outline: '', document: {type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'归档也必须保留的正文'}]}]} });
    await success('POST', `/api/chapters/${chapter.id}/finalize`, {expectedVersion:saved.version});
    await success('POST', `/api/books/${book.id}/story`, {kind:'note',authority:'setting',title:'章节关联便签',content:'关联这章',links:{chapterIds:[chapter.id]}});
    const { references } = await success<{references: ChapterReference[]}>('GET', `/api/chapters/${chapter.id}/references`);
    expect(references.some(reference => reference.title.includes('章节关联便签') && reference.path === 'links.chapterIds[0]' && !reference.historical)).toBe(true);
    expect(references.some(reference => reference.historical)).toBe(true);
    expect((await app.inject({ method:'DELETE',url:`/api/chapters/${chapter.id}`,payload:{expectedVersion:saved.version} })).statusCode).toBe(409);
    expect((await app.inject({ method:'PUT',url:`/api/chapters/${chapter.id}/archive`,payload:{expectedVersion:1,archived:true} })).statusCode).toBe(409);
    const archived = (await success<{chapter: Chapter}>('PUT', `/api/chapters/${chapter.id}/archive`, {expectedVersion:saved.version,archived:true})).chapter;
    expect(archived.archivedAt).toBeTruthy();
    expect((await success<{chapters: ChapterSummary[]}>('GET', `/api/books/${book.id}/chapters`)).chapters).toHaveLength(0);
    expect((await success<{chapters: ChapterSummary[]}>('GET', `/api/books/${book.id}/chapters?includeArchived=true`)).chapters).toHaveLength(1);
    expect((await success<{book: Book}>('GET', `/api/books/${book.id}`)).book.wordCount).toBe(0);
    expect((await app.inject({method:'PUT',url:`/api/chapters/${chapter.id}/draft`,payload:{expectedVersion:archived.version,title:chapter.title,outline:'',document:archived.document}})).statusCode).toBe(409);
    const settings = (await success<{settings:ModelSettings}>('GET', '/api/model')).settings;
    await success('PUT', '/api/model', { ...settings, model: 'archive-fixture', baseUrl: 'http://127.0.0.1:1/v1', stream: false });
    expect((await app.inject({method:'POST',url:'/api/jobs',payload:{requestId:'archive-task',kind:'discuss',chapterId:chapter.id,expectedVersion:archived.version,instruction:'归档后不应发起模型调用'}})).statusCode).toBe(409);
    const backup = await success<WorkspaceBackup>('GET', '/api/backup');
    const restored = await success<{books:Book[]}>('POST', '/api/backup/restore', {backup});
    const restoredChapters = (await success<{chapters:ChapterSummary[]}>('GET', `/api/books/${restored.books[0]!.id}/chapters?includeArchived=true`)).chapters;
    expect(restoredChapters[0]?.archivedAt).toBe(archived.archivedAt);
    const restoredChapter = (await success<{chapter:Chapter}>('GET', `/api/chapters/${restoredChapters[0]!.id}`)).chapter;
    expect(restoredChapter.plainText).toBe(saved.plainText);
    expect(restoredChapter.finalizedRevisionId).toBeTruthy();
    const unarchived = (await success<{chapter:Chapter}>('PUT', `/api/chapters/${chapter.id}/archive`, {expectedVersion:archived.version,archived:false})).chapter;
    expect(unarchived.archivedAt).toBeNull();
    expect(unarchived.plainText).toBe(saved.plainText);
  });
  it('upgrades a version-one SQLite library without changing its manuscript or identity', async () => {
    if (harness.storage) return;
    const { book, chapter } = await create('旧版升级');
    await app.close();
    const raw = new DatabaseSync(join(dataDir, 'workspace.sqlite'));
    raw.exec('DROP INDEX chapter_archive; ALTER TABLE chapters DROP COLUMN archived_at; PRAGMA user_version=1');
    raw.close();
    app = harness.createApp({ dataDir, credentialDir: join(dataDir, 'credentials') });
    await app.ready();
    const restored = (await success<{chapter:Chapter}>('GET', `/api/chapters/${chapter.id}`)).chapter;
    expect(restored.bookId).toBe(book.id);
    expect(restored.archivedAt).toBeNull();
    expect(restored.document).toEqual(chapter.document);
    expect(restored.version).toBe(chapter.version);
  });
  it('manages local backups with previews and rejects changed content and path traversal', async () => {
    await create();
    const { backup } = await success<{backup: BackupSummary}>('POST', '/api/backups');
    const catalog = await success<BackupCatalog>('GET', '/api/backups');
    expect(catalog.backups).toHaveLength(1);
    expect(catalog.totalBytes).toBe(backup.bytes);
    expect(catalog.retentionDays).toBe(0);
    expect((await success<{backup:BackupSummary}>('GET', `/api/backups/preview?id=${encodeURIComponent(backup.id)}`)).backup.books[0]?.title).toBe('优化验收');
    const file = join(dataDir,'backups',backup.id);
    await writeFile(file, (await readFile(file,'utf8')) + '\n');
    expect((await app.inject({method:'POST',url:'/api/backups/restore',payload:{id:backup.id,fingerprint:backup.fingerprint}})).statusCode).toBe(409);
    const updated = (await success<{backup:BackupSummary}>('GET', `/api/backups/preview?id=${encodeURIComponent(backup.id)}`)).backup;
    expect((await success<{books:Book[]}>('POST', '/api/backups/restore',{id:updated.id,fingerprint:updated.fingerprint})).books).toHaveLength(1);
    for (const id of ['../workspace.sqlite','managed/../../secret.json','C:/secret.json']) expect((await app.inject({method:'GET',url:`/api/backups/preview?id=${encodeURIComponent(id)}`})).statusCode).toBe(400);
  });
  it('previews retention cleanup, protects unique backups and rejects a changed cleanup plan', async () => {
    const first = await create('第一部');
    const old = await success<WorkspaceBackup>('GET','/api/backup'); old.exportedAt='2000-01-01T00:00:00.000Z';
    const directory=join(dataDir,'backups','managed');await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'old.json'),JSON.stringify(old));
    await success('POST','/api/backups');
    const second=await create('只有唯一备份的作品');
    const unique=await success<WorkspaceBackup>('GET','/api/backup');unique.books=unique.books.filter(entry=>entry.book.id===second.book.id);unique.exportedAt='2001-01-01T00:00:00.000Z';
    await writeFile(join(directory,'unique.json'),JSON.stringify(unique));
    const removedChapter = structuredClone(old);
    const copy = structuredClone(removedChapter.books[0]!.chapters[0]!);
    copy.chapter.id = 'deleted-chapter-only-copy'; copy.chapter.position = 2;
    removedChapter.books[0]!.chapters.push(copy); removedChapter.books[0]!.book.chapterCount = 2;
    removedChapter.exportedAt = '1999-01-01T00:00:00.000Z';
    await writeFile(join(directory,'deleted-chapter.json'),JSON.stringify(removedChapter));
    await writeFile(join(directory,'unrecognized.json'),'{broken');
    await success('PUT','/api/backups/settings',{retentionDays:30});
    let cleanup=await success<BackupCleanup>('GET','/api/backups/cleanup');
    expect(cleanup.ids).toEqual(['managed/old.json']);
    expect(cleanup.protectedCount).toBe(3);
    await writeFile(join(directory,'old.json'),JSON.stringify(old)+'\n');
    expect((await app.inject({method:'POST',url:'/api/backups/cleanup',payload:{fingerprint:cleanup.fingerprint}})).statusCode).toBe(409);
    cleanup=await success<BackupCleanup>('GET','/api/backups/cleanup');
    expect((await success<{deleted:number}>('POST','/api/backups/cleanup',{fingerprint:cleanup.fingerprint})).deleted).toBe(1);
    expect(await readdir(directory)).toContain('unique.json');
    expect(await readdir(directory)).toContain('unrecognized.json');
    expect(await readdir(directory)).toContain('deleted-chapter.json');
    expect((await success<{book:Book}>('GET',`/api/books/${first.book.id}`)).book.title).toBe('第一部');
  });
  it('lets a new module register exact references and ordered cleanup without editing deletion code', () => {
    const store = new Store(join(dataDir, 'registry'));
    try {
      store.db.exec('CREATE TABLE ai_jobs(id TEXT PRIMARY KEY,chapter_id TEXT); CREATE TABLE extension_notes(id TEXT PRIMARY KEY,book_id TEXT REFERENCES books(id),payload TEXT)');
      const book = store.createBook({title:'生命周期扩展'});
      const chapter = store.listChapters(book.id)[0]!;
      const lifecycle = new ManuscriptLifecycle(store);
      lifecycle.register({name:'扩展便签',sources:[{table:'extension_notes',label:'扩展资料'}],bookTables:['extension_notes']});
      store.db.prepare('INSERT INTO extension_notes(id,book_id,payload) VALUES(?,?,?)').run('note',book.id,JSON.stringify({title:'来源便签',chapterId:chapter.id}));
      expect(lifecycle.chapterReferences(chapter.id).map(reference=>reference.module)).toEqual(['扩展便签']);
      lifecycle.deleteRecords(book.id);
      expect(lifecycle.chapterReferences(chapter.id)).toEqual([]);
      expect(store.getChapter(chapter.id).id).toBe(chapter.id);
    } finally { store.close(); }
  });
});
