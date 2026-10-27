import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import staticFiles from '@fastify/static';
import type { JsonValue } from '@shujian/contracts';
import { AppError } from './errors.js';
import { Store } from './store.js';
import * as validate from './validation.js';
import { registerAiRoutes } from './ai/index.js';
import { registerStoryRoutes } from './story/index.js';
import { registerPlanningRoutes } from './planning.js';
import { loadStorageConfig, selectStorageDriver, storageState, type StorageConfig } from './storage-config.js';
import { assertLocalRequest } from './local-request-boundary.js';
import { registerCreativeRoutes } from './creative/service.js';
import { registerAtlasRoutes } from './atlas/index.js';

export interface AppOptions {
  dataDir?: string;
  logger?: boolean;
  credentialDir?: string;
  connectionsFile?: string;
  storage?: StorageConfig;
  databaseFile?: string;
}

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

function param(request: FastifyRequest, name: string): string {
  return validate.string(validate.object(request.params, '路径参数')[name], '记录 ID', 128, 1);
}

function versionBody(value: unknown): { item: Record<string, unknown>; expectedVersion: number } {
  const item = validate.object(value);
  return { item, expectedVersion: validate.integer(item.expectedVersion, '草稿版本', 1) };
}

function downloadName(name: string, extension: string): string {
  const safe = name.replace(/[\r\n\\/:*?"<>|]/g, '_').slice(0, 100) || '未命名作品';
  return `attachment; filename="manuscript.${extension}"; filename*=UTF-8''${encodeURIComponent(`${safe}.${extension}`)}`;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  app.addHook('onRequest', async (request) => { assertLocalRequest(request); });
  const dataDir = options.dataDir ?? process.env.NOVEL_DATA_DIR ?? resolve(projectRoot, 'data');
  const configured = options.storage ? { config: options.storage, configFile: options.databaseFile }
    : (options.dataDir !== undefined && !options.databaseFile) || (process.env.NOVEL_DATA_DIR && !options.databaseFile && !process.env.NOVEL_DATABASE_FILE && !process.env.NOVEL_DATABASE_URL)
      ? { config: { driver: 'sqlite' as const, filename: resolve(dataDir, 'workspace.sqlite') }, configFile: undefined }
      : loadStorageConfig(projectRoot, dataDir, options.databaseFile);
  const store = new Store(dataDir, configured.config);
  const story = registerStoryRoutes(app, store);
  const plans = registerPlanningRoutes(app, store);
  const creative = registerCreativeRoutes(app, store);
  const atlas=registerAtlasRoutes(app,store,story,plans,creative);
  creative.beforeProfileSave=(bookId,profile)=>atlas.validateVoices(bookId,profile.voices.map(voice=>voice.id));
  const privateDirectory=resolve(projectRoot,'../novel-private');
  const credentialDirectory=options.credentialDir??process.env.NOVEL_CREDENTIAL_DIR??resolve(privateDirectory,'credentials');
  const connectionsFile=options.connectionsFile??process.env.NOVEL_CONNECTIONS_FILE??resolve(options.credentialDir||process.env.NOVEL_CREDENTIAL_DIR?credentialDirectory:privateDirectory,'connections.json');
  const ai = registerAiRoutes(app, store, { credentialDir:credentialDirectory, connectionsFile, workspaceDirectory: projectRoot });
  ai.hooks.context = (input, chapter) => {const graph=atlas.context(input,chapter);return [...story.getContext(input,chapter,graph.transform,graph.allowedIds),...graph.items,...plans.context(chapter)];};
  ai.hooks.creativity = (input, chapter, replay) => creative.materialize(input, chapter, replay);
  ai.hooks.completed = (job) => store.db.transaction(() => story.onJobComplete(job))();
  store.backupExtensions = {
    exportBook: (bookId) => ({ ai: ai.exportBook(bookId), story: JSON.parse(JSON.stringify(story.exportBook(bookId))) as JsonValue, planning: plans.exportBook(bookId), creative: creative.exportBook(bookId), atlas:atlas.exportBook(bookId) }),
    restoreBook: (entry, newBookId, ids) => {
      const extra = entry.extensions ?? {};
      if (extra.ai !== undefined) ai.prepareRestore(extra.ai, ids);
      story.prepareRestore(extra.story, ids);
      creative.prepareRestore(extra.creative, ids);
      atlas.prepareRestore(extra.atlas,ids);
      if (extra.ai !== undefined) ai.restoreBook(entry.book.id, newBookId, ids, extra.ai);
      plans.restoreBook(entry.book.id, newBookId, ids, extra.planning);
      story.restoreBook(entry.book.id, newBookId, ids, extra.story);
      creative.restoreBook(entry.book.id, newBookId, ids, extra.creative);
      ai.validateRestoredSkillBindings(newBookId);
      atlas.restoreBook(entry.book.id,newBookId,ids,extra.atlas);
    },
  };
  app.addHook('preClose', async () => { await ai.close(); });
  app.addHook('onClose', async () => { store.close(); });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: {
        code: error.code, message: error.message,
        ...(error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}),
      } });
    }
    const details = error as { statusCode?: number; code?: string; message?: string };
    if (details.statusCode === 413) {
      const isBackup = request.routeOptions.url === '/api/backup/restore';
      return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: isBackup ? '备份文件超过 64 MB，当前版本无法恢复。' : '文件超过 20 MB，请分批导入。' } });
    }
    if (details.statusCode === 400) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '请求格式不正确，请检查文件或输入。' } });
    request.log.error(error);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '保存未完成，请保留当前文字并重试。' } });
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/storage', async () => ({ storage: storageState(configured.config, projectRoot, configured.configFile) }));
  app.put('/api/storage/preference', async (request) => {
    const driver = validate.object(request.body).driver;
    if (driver !== 'sqlite' && driver !== 'postgresql') validate.invalid('请选择 SQLite 或 PostgreSQL。');
    selectStorageDriver(driver, projectRoot, dataDir, configured.configFile);
    return { storage: storageState(configured.config, projectRoot, configured.configFile) };
  });
  app.get('/api/books', async () => ({ books: store.listBooks() }));
  app.post('/api/books', async (request, reply) => reply.code(201).send({ book: store.createBook(validate.createBook(request.body)) }));
  app.get('/api/books/:bookId', async (request) => ({ book: store.getBook(param(request, 'bookId')) }));
  app.patch('/api/books/:bookId', async (request) => ({ book: store.updateBook(param(request, 'bookId'), validate.updateBook(request.body)) }));

  app.get('/api/books/:bookId/chapters', async (request) => ({ chapters: store.listChapters(param(request, 'bookId')) }));
  app.post('/api/books/:bookId/chapters', async (request, reply) => {
    const body = validate.object(request.body ?? {});
    const title = body.title === undefined ? undefined : validate.string(body.title, '章节标题', 200);
    const outline = body.outline === undefined ? undefined : validate.string(body.outline, '本章计划', 20_000);
    return reply.code(201).send({ chapter: store.createChapter(param(request, 'bookId'), title, outline) });
  });
  app.get('/api/chapters/:chapterId', async (request) => ({ chapter: store.getChapter(param(request, 'chapterId')) }));
  app.put('/api/chapters/:chapterId/draft', async (request) => ({ chapter: store.saveDraft(param(request, 'chapterId'), validate.saveDraft(request.body)) }));

  app.post('/api/chapters/:chapterId/versions', async (request, reply) => {
    const { item, expectedVersion } = versionBody(request.body);
    const label = item.label === undefined ? undefined : validate.string(item.label, '版本名称', 120);
    return reply.code(201).send({ version: store.checkpoint(param(request, 'chapterId'), expectedVersion, label) });
  });
  app.get('/api/chapters/:chapterId/versions', async (request) => ({ versions: store.listRevisions(param(request, 'chapterId')) }));
  app.get('/api/chapters/:chapterId/versions/:revisionId', async (request) => ({ version: store.getRevision(param(request, 'chapterId'), param(request, 'revisionId')) }));
  app.post('/api/chapters/:chapterId/restore', async (request) => {
    const { item, expectedVersion } = versionBody(request.body);
    return { chapter: store.restoreChapter(param(request, 'chapterId'), expectedVersion, validate.string(item.revisionId, '版本 ID', 128, 1)) };
  });
  app.post('/api/chapters/:chapterId/finalize', async (request) => {
    const { expectedVersion,item } = versionBody(request.body);
    if(item.proposalIds!==undefined&&(!Array.isArray(item.proposalIds)||item.proposalIds.length>60))validate.invalid('一次最多确认 60 条本章资料建议。');
    const proposalIds=(item.proposalIds as unknown[]|undefined??[]).map((id)=>validate.string(id,'候选资料 ID',128,1));
    const id = param(request, 'chapterId');
    const oldRevisionId = store.getChapter(id).finalizedRevisionId;
    const chapter = store.db.transaction(() => {
      const finalized = store.finalize(id, expectedVersion);
      story.onFinalized(finalized, oldRevisionId);
      story.confirmFinalizedProposals(finalized,proposalIds);
      return finalized;
    })();
    return { chapter };
  });

  app.get('/api/books/:bookId/export', async (request, reply) => {
    const query = validate.object(request.query);
    const format = query.format ?? 'txt';
    if (format !== 'txt' && format !== 'md') validate.invalid('导出格式只支持 txt 或 md。');
    const output = store.exportBook(param(request, 'bookId'), format);
    return reply.header('content-type', format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')
      .header('content-disposition', downloadName(output.book.title, format))
      .send(output.text);
  });

  app.get('/api/backup', async (_request, reply) => {
    const serialized = JSON.stringify(store.backup());
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES) throw new AppError(413, 'BACKUP_TOO_LARGE', '工作区备份超过 64 MB，当前版本无法导出可恢复的文件。请先保留原始数据目录。');
    return reply.header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="shujian-backup-${new Date().toISOString().slice(0, 10)}.json"`)
      .send(serialized);
  });
  app.post('/api/backup/restore', { bodyLimit: MAX_BACKUP_BYTES + 1024 }, async (request, reply) => {
    const body = validate.object(request.body);
    const backup = validate.backup(body.backup);
    return reply.code(201).send({ books: store.restoreBackup(backup) });
  });
  app.post('/api/import', async (request, reply) => {
    const body = validate.object(request.body);
    const filename = validate.string(body.filename, '文件名', 500, 1);
    if (!/\.(txt|md|markdown)$/i.test(filename)) validate.invalid('请选择 TXT 或 Markdown 文件。');
    const text = validate.string(body.text, '文件内容', 5_000_000);
    const title = body.title === undefined ? undefined : validate.string(body.title, '作品名', 120, 1);
    return reply.code(201).send(store.importText(filename, text, title));
  });

  const webRoot = resolve(projectRoot, 'apps/web/dist');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    app.register(staticFiles, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在。' } });
      if (request.method === 'GET' && !request.url.split('?')[0]?.includes('.')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '文件不存在。' } });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '内容不存在。' } }));
  }

  return app;
}
