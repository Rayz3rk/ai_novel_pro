import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiJob, Book, Chapter, ChapterReview, CreateAiJobInput, ModelSettings, PlanNode, StoryEntry, StoryEvidence, StoryProposal, WorkspaceBackup } from '../../packages/contracts/src/index.js';
import { storageHarness } from './storage-harness.js';
const harness = storageHarness('collaboration');
const createApp = harness.createApp;

describe('author-led collaboration and evidence boundaries', () => {
  let app: ReturnType<typeof createApp>;
  let server: Server;
  let directory: string;
  let baseUrl: string;
  let output: string;
  let mode: 'normal' | 'slow' | 'disconnect' | 'error';
  let calls: number;
  let captured: Array<{ authorization: string | undefined; body: Record<string, unknown> }>;
  const paragraph = (text: string, uid = 'p-first') => ({ type: 'doc' as const, content: [{ type: 'paragraph', attrs: { uid }, content: [{ type: 'text', text }] }] });
  const model = (): Omit<ModelSettings, 'id' | 'hasApiKey'> => ({ baseUrl, model: 'fixture-test-only', stream: true, temperature: 0.7, maxOutputTokens: 1024, contextWindow: 32768, inputPricePerMillion: 1, outputPricePerMillion: 2, taskBudget: null, dailyBudget: null });

  beforeEach(async () => {
    harness.reset();
    directory = await mkdtemp(join(tmpdir(), 'shujian-collab-'));
    output = '雨敲窗棂。她没有拆开信。'; mode = 'normal'; calls = 0; captured = [];
    server = createServer(async (request, response) => {
      if(request.url==='/v1/models'){response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{id:'fixture-a'},{id:'fixture-b'}]}));return;}
      calls++;
      let raw = ''; for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw) as { stream: boolean };
      captured.push({authorization:request.headers.authorization,body:JSON.parse(raw) as Record<string,unknown>});
      if (mode === 'error') { response.writeHead(503); response.end('SECRET_PROVIDER_RESPONSE_MUST_NOT_LEAK'); return; }
      const usage = { prompt_tokens: 100, completion_tokens: 50 };
      if (!payload.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'stop' }], usage })); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const text of output.match(/[\s\S]{1,4}/gu) ?? []) {
        if (response.destroyed) return;
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        await pause(mode === 'slow' ? 70 : 1);
      }
      if (mode === 'disconnect') { response.destroy(); return; }
      response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
    app = createApp({ dataDir: join(directory, 'data'), credentialDir: join(directory, 'credentials') });
    await app.ready();
    await ok('PUT', '/api/model', model());
  });
  afterEach(async () => {
    await app.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    const safe = resolve(directory);
    if (dirname(safe) !== resolve(tmpdir()) || !basename(safe).startsWith('shujian-collab-')) throw new Error('unsafe cleanup');
    await rm(safe, { recursive: true, force: true });
  });
  async function ok<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<T> {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBeLessThan(300);
    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    return response.json<T>();
  }
  async function book(): Promise<{ book: Book; chapter: Chapter }> {
    const { book } = await ok<{ book: Book }>('POST', '/api/books', { title: '工程验收 · 雾港', premise: '林砚在雨夜寻找一封来信。' });
    const { chapters } = await ok<{ chapters: Chapter[] }>('GET', `/api/books/${book.id}/chapters`);
    const { chapter } = await ok<{ chapter: Chapter }>('GET', `/api/chapters/${chapters[0]!.id}`);
    return { book, chapter };
  }
  const saved = async (chapter: Chapter, text: string) => (await ok<{ chapter: Chapter }>('PUT', `/api/chapters/${chapter.id}/draft`, { expectedVersion: chapter.version, title: chapter.title, outline: chapter.outline, document: paragraph(text) })).chapter;
  const getChapter = async (id: string) => (await ok<{ chapter: Chapter }>('GET', `/api/chapters/${id}`)).chapter;
  const final = async (chapter: Chapter) => (await ok<{ chapter: Chapter }>('POST', `/api/chapters/${chapter.id}/finalize`, { expectedVersion: chapter.version })).chapter;
  const input = (chapter: Chapter, kind: AiJob['kind'] = 'draft'): CreateAiJobInput => ({ requestId: randomUUID(), kind, chapterId: chapter.id, expectedVersion: chapter.version, instruction: '根据当前本章意图完成任务。' });
  const start = async (chapter: Chapter, kind: AiJob['kind'] = 'draft', extra: Partial<CreateAiJobInput> = {}) => (await ok<{ job: AiJob }>('POST', '/api/jobs', { ...input(chapter, kind), ...extra })).job;
  async function finished(id: string): Promise<AiJob> {
    for (let i = 0; i < 350; i++) {
      const { job } = await ok<{ job: AiJob }>('GET', `/api/jobs/${id}`);
      if (!['queued', 'running'].includes(job.status)) return job;
      await pause(10);
    }
    throw new Error(`job did not finish: ${id}`);
  }
  const entry = async (bookId: string, payload: object) => (await ok<{ entry: StoryEntry }>('POST', `/api/books/${bookId}/story`, payload)).entry;
  async function evidence(chapter: Chapter): Promise<StoryEvidence> {
    const result = await ok<{ revisionId: string; paragraphs: Array<{ paragraphId: string; text: string; hash: string }> }>('GET', `/api/chapters/${chapter.id}/evidence`);
    const p = result.paragraphs[0]!;
    return { chapterId: chapter.id, revisionId: result.revisionId, paragraphId: p.paragraphId, quote: p.text, hash: p.hash };
  }

  it('keeps credentials outside the database and backup, with explicit preserve and clear', async () => {
    const secret = 'test-only-key-' + randomUUID();
    const result = await ok<{ settings: ModelSettings }>('PUT', '/api/model', { ...model(), apiKey: secret });
    expect(result.settings.hasApiKey).toBe(true); expect(JSON.stringify(result)).not.toContain(secret);
    expect((await ok<{ settings: ModelSettings }>('PUT', '/api/model', model())).settings.hasApiKey).toBe(true);
    expect((await readFile(join(directory, 'credentials/model-key.json'), 'utf8'))).toContain(secret);
    for (const filename of await readdir(join(directory, 'data'))) expect((await readFile(join(directory, 'data', filename))).includes(Buffer.from(secret))).toBe(false);
    expect((await app.inject('/api/backup')).body).not.toContain(secret);
    expect((await ok<{ settings: ModelSettings }>('PUT', '/api/model', { ...model(), clearApiKey: true })).settings.hasApiKey).toBe(false);
  });

  it('streams a durable candidate without changing prose; adoption is atomic, versioned and idempotent', async () => {
    const { chapter } = await book(); const draft = await saved(chapter, '作者原稿。');
    const request = input(draft); const first = await ok<{ job: AiJob }>('POST', '/api/jobs', request);
    const duplicate = await ok<{ job: AiJob }>('POST', '/api/jobs', request); expect(duplicate.job.id).toBe(first.job.id);
    const job = await finished(first.job.id); expect(job.status, job.error ?? '').toBe('succeeded'); expect(job.output).toBe(output);
    expect(job.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, estimatedCost: 0.0002, attempts: 1 });
    expect((await getChapter(draft.id)).plainText).toBe('作者原稿。');
    const adopted = await ok<{ chapter: Chapter; alreadyApplied: boolean }>('POST', `/api/jobs/${job.id}/apply`, { expectedVersion: draft.version, target: 'document' });
    expect(adopted.chapter.plainText).toBe(output); expect(adopted.chapter.version).toBe(draft.version + 1);
    const again = await ok<{ chapter: Chapter; alreadyApplied: boolean }>('POST', `/api/jobs/${job.id}/apply`, { expectedVersion: draft.version, target: 'document' });
    expect(again.alreadyApplied).toBe(true); expect(again.chapter.version).toBe(adopted.chapter.version);
    const history = await ok<{ versions: Array<{ label: string }> }>('GET', `/api/chapters/${draft.id}/versions`);
    expect(history.versions.some((version) => version.label === '采纳 AI 前自动留稿')).toBe(true);
  });

  it('supports nonstreaming and reports unknown usage prices honestly', async () => {
    await ok('PUT', '/api/model', { ...model(), stream: false, inputPricePerMillion: null, outputPricePerMillion: null });
    const { chapter } = await book(); const job = await finished((await start(chapter, 'discuss')).id);
    expect(job.status).toBe('succeeded'); expect(job.usage.estimatedCost).toBeNull(); expect(job.usage.inputTokens).toBe(100);
  });

  it('stores multiple platforms and independent keys, keeps in-flight retries on the original connection', async () => {
    await ok('PUT','/api/model',{...model(),name:'平台一',apiKey:'fixture-key-one'});
    const added=await ok<{settings:ModelSettings}>('POST','/api/models',{...model(),name:'平台二',apiKey:'fixture-key-two'});
    expect(added.settings.id).not.toBe('default');
    await ok('POST','/api/models/default/activate',{});
    const {chapter}=await book();mode='error';const job=await start(chapter);
    for(let i=0;i<100&&calls===0;i++)await pause(5);
    await ok('POST',`/api/models/${added.settings.id}/activate`,{}); mode='normal';
    const result=await finished(job.id);expect(result.status,result.error??'').toBe('succeeded');
    expect(captured).toHaveLength(2);expect(captured.every((call)=>call.authorization==='Bearer fixture-key-one')).toBe(true);
    const other=await book();await finished((await start(other.chapter)).id);
    expect(captured.at(-1)?.authorization).toBe('Bearer fixture-key-two');
    expect((await ok<{connections:ModelSettings[]}>('GET','/api/models')).connections).toHaveLength(2);
    const catalog=await ok<{models:string[]}>('GET',`/api/models/${added.settings.id}/catalog`);expect(catalog.models).toEqual(['fixture-a','fixture-b']);
    const backup=await app.inject('/api/backup');expect(backup.body).not.toContain('fixture-key-');
  });

  it('loads and hot-reloads local connection files without returning or backing up credentials', async () => {
    const path=join(directory,'credentials','connections.json');await mkdir(join(directory,'credentials'),{recursive:true});
    const config={activeConnection:'omgt',connections:[{id:'omgt',name:'Omgt API',baseUrl,model:'file-model-one',apiKey:'local-file-only-secret',stream:true}]};
    await writeFile(path,JSON.stringify(config));
    const first=await ok<{settings:ModelSettings}>('GET','/api/model');expect(first.settings.id).toBe('omgt');expect(first.settings.model).toBe('file-model-one');expect(first.settings.hasApiKey).toBe(true);expect(JSON.stringify(first)).not.toContain('local-file-only-secret');
    config.connections[0]!.model='file-model-two';await writeFile(path,JSON.stringify(config));
    expect((await ok<{settings:ModelSettings}>('GET','/api/model')).settings.model).toBe('file-model-two');
    const {chapter}=await book();await finished((await start(chapter)).id);expect(captured.at(-1)?.authorization).toBe('Bearer local-file-only-secret');
    expect((await app.inject('/api/backup')).body).not.toContain('local-file-only-secret');
  });

  it('adapts optional token, temperature and stream-usage request fields for compatible platforms', async () => {
    await ok('PUT','/api/model',{...model(),tokenParameter:'max_completion_tokens',sendTemperature:false,includeStreamUsage:false});
    const {chapter}=await book();expect((await finished((await start(chapter)).id)).status).toBe('succeeded');
    expect(captured[0]?.body.max_completion_tokens).toBe(1024);expect(captured[0]?.body).not.toHaveProperty('max_tokens');expect(captured[0]?.body).not.toHaveProperty('temperature');expect(captured[0]?.body).not.toHaveProperty('stream_options');
  });

  it('rejects stale and forged selections while preserving unselected rich text and emoji', async () => {
    const { chapter } = await book();
    const doc = { type: 'doc', content: [{ type: 'paragraph', attrs: { uid: 'one' }, content: [{ type: 'text', text: '前文🕯️。', marks: [{ type: 'bold' }] }] }, { type: 'paragraph', attrs: { uid: 'two' }, content: [{ type: 'text', text: '需要修改。' }] }, { type: 'paragraph', attrs: { uid: 'three' }, content: [{ type: 'text', text: '后文保持。', marks: [{ type: 'italic' }] }] }] };
    const draft = (await ok<{ chapter: Chapter }>('PUT', `/api/chapters/${chapter.id}/draft`, { expectedVersion: chapter.version, title: chapter.title, outline: '', document: doc })).chapter;
    const from = '前文🕯️。'.length + 3; const to = from + '需要修改。'.length;
    const forged = await app.inject({ method: 'POST', url: '/api/jobs', payload: { ...input(draft, 'revise'), selection: { from, to, text: '伪造' } } });
    expect(forged.statusCode).toBe(409);
    output = '改过的句子。'; const job = await finished((await start(draft, 'revise', { selection: { from, to, text: '需要修改。' } })).id);
    expect(job.status, job.error ?? '').toBe('succeeded');
    const { chapter: result } = await ok<{ chapter: Chapter }>('POST', `/api/jobs/${job.id}/apply`, { expectedVersion: draft.version, target: 'document' });
    expect(result.document.content[0]).toEqual(doc.content[0]); expect(result.document.content[2]).toEqual(doc.content[2]);
    expect(result.plainText).toContain('改过的句子。');
    const late = await finished((await start(result)).id); const newer = await saved(result, '作者继续修改。');
    const rejected = await app.inject({ method: 'POST', url: `/api/jobs/${late.id}/apply`, payload: { expectedVersion: newer.version, target: 'document' } });
    expect(rejected.statusCode).toBe(409); expect((await getChapter(result.id)).plainText).toBe('作者继续修改。');
  });

  it('cancels partial output, prevents late writes and retries as a separate candidate', async () => {
    mode = 'slow'; output = '已经收到的文字会保留。模型仍在写作，但作者要停止。';
    const { chapter } = await book(); const job = await start(chapter);
    await pause(110); const cancel = await ok<{ job: AiJob }>('POST', `/api/jobs/${job.id}/cancel`, {});
    expect(cancel.job.status).toBe('cancelled'); expect(cancel.job.output.length).toBeGreaterThan(0);
    await pause(160); expect((await finished(job.id)).output).toBe(cancel.job.output);
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/apply`, payload: { expectedVersion: chapter.version, target: 'document' } })).statusCode).toBe(409);
    mode = 'normal'; const retry = await ok<{ job: AiJob }>('POST', `/api/jobs/${job.id}/retry`, {}); expect(retry.job.id).not.toBe(job.id);
    expect((await finished(retry.job.id)).status).toBe('succeeded');
  });

  it('keeps partial disconnects and uses bounded transport retries without leaking provider errors', async () => {
    const { chapter } = await book(); mode = 'disconnect';
    const partial = await finished((await start(chapter)).id); expect(partial.status).toBe('failed'); expect(partial.output).toBe(output); expect(partial.usage.attempts).toBe(1);
    mode = 'error'; calls = 0; const failure = await finished((await start(chapter)).id);
    expect(failure.status).toBe('failed'); expect(calls).toBe(2); expect(JSON.stringify(failure)).not.toContain('SECRET_PROVIDER_RESPONSE');
    expect((await getChapter(chapter.id)).plainText).toBe('');
  });

  it('marks live tasks interrupted on restart and preserves manuscript, partial output and call records', async () => {
    mode = 'slow'; output = '这是进程重启前已经开始接收的长段落，不会自动覆盖稿件。';
    const { chapter } = await book(); const draft = await saved(chapter, '已保存的手稿🕯️。'); const job = await start(draft);
    await pause(120); await app.close();
    app = createApp({ dataDir: join(directory, 'data'), credentialDir: join(directory, 'credentials') }); await app.ready();
    const interrupted = await finished(job.id); expect(interrupted.status).toBe('interrupted'); expect(interrupted.output.length).toBeGreaterThan(0);
    expect((await getChapter(chapter.id)).plainText).toBe('已保存的手稿🕯️。');
    expect((await ok<{ calls: unknown[] }>('GET', `/api/jobs/${job.id}/calls`)).calls).toHaveLength(1);
  });

  it('refuses mandatory context overflow and task/day budgets before calling the model', async () => {
    const { chapter } = await book(); const draft = await saved(chapter, '中文正文。'.repeat(700));
    await ok('PUT', '/api/model', { ...model(), contextWindow: 2048 });
    expect((await app.inject({ method: 'POST', url: '/api/jobs', payload: input(draft) })).statusCode).toBe(422); expect(calls).toBe(0);
    await ok('PUT', '/api/model', { ...model(), taskBudget: 0.000001 });
    expect((await app.inject({ method: 'POST', url: '/api/jobs', payload: input(draft) })).statusCode).toBe(422); expect(calls).toBe(0);
    await ok('PUT', '/api/model', { ...model(), dailyBudget: 0.000001 });
    expect((await app.inject({ method: 'POST', url: '/api/jobs', payload: input(draft) })).statusCode).toBe(422); expect(calls).toBe(0);
  });

  it('filters author secrets, future knowledge and withdrawn entries; plans stay labeled as plans', async () => {
    const { book: b, chapter } = await book();
    const secret = await entry(b.id, { kind: 'character', authority: 'setting', title: '许衡的秘密', content: '许衡才是写信人。', visibility: 'author' });
    const privateEntry = await entry(b.id, { kind: 'character', authority: 'setting', title: '林砚尚未知情', content: '陈舟独自知道暗号。', visibility: 'characters', knownBy: ['陈舟'] });
    const future = await entry(b.id, { kind: 'character', authority: 'setting', title: '未来身份', content: '林砚在第八章得知真相。', validFromChapter: 8 });
    const plan = await entry(b.id, { kind: 'plan', authority: 'plan', title: '第八章回收', content: '计划第八章揭示写信人，尚未发生。', plannedPayoff: 8 });
    const withdrawn = await entry(b.id, { kind: 'rule', authority: 'setting', title: '放弃的规则', content: '钟会使时间倒流。' });
    await ok('POST', `/api/story/${withdrawn.id}/withdraw`, { expectedVersion: withdrawn.version });
    const job = await finished((await start(chapter, 'draft', { pov: '林砚', pinnedEntryIds: [secret.id] })).id);
    const ids = job.context.map((item) => item.entryId); expect(ids).not.toContain(secret.id); expect(ids).not.toContain(privateEntry.id); expect(ids).not.toContain(future.id); expect(ids).not.toContain(withdrawn.id);
    expect(job.context.find((item) => item.entryId === plan.id)?.label).toContain('尚未发生');
    const discussion = await finished((await start(chapter, 'discuss')).id); expect(discussion.context.some((item) => item.entryId === secret.id)).toBe(true);
    const { entries } = await ok<{ entries: StoryEntry[] }>('GET', `/api/books/${b.id}/story?q=${encodeURIComponent('许衡')}`); expect(entries.some((item) => item.id === secret.id)).toBe(true);
  });

  it('filters private evidence paragraphs from continuity context as well as the canon records', async () => {
    const {book:b,chapter}=await book();const official=await final(await saved(chapter,'只有陈舟知道写信人是许衡。'));
    const fact=await entry(b.id,{kind:'event',authority:'fact',title:'写信人的身份',content:'陈舟得知写信人的身份。',visibility:'characters',knownBy:['陈舟'],storyTime:'当天深夜',narrative:'normal',evidence:[await evidence(official)]});
    const next=(await ok<{chapter:Chapter}>('POST',`/api/books/${b.id}/chapters`,{})).chapter;
    const unknown=await finished((await start(next,'draft',{pov:'林砚'})).id);expect(unknown.context.some((item)=>item.entryId===fact.id)).toBe(false);expect(unknown.context.some((item)=>item.text.includes('只有陈舟知道写信人是许衡'))).toBe(false);
    const known=await finished((await start(next,'draft',{pov:'陈舟'})).id);expect(known.context.some((item)=>item.entryId===fact.id)).toBe(true);expect(known.context.some((item)=>item.source==='history'&&item.text.includes('只有陈舟知道写信人是许衡'))).toBe(true);
    const sources=await ok<{sources:Array<{chapterId:string;paragraphId:string}>}>('GET',`/api/books/${b.id}/sources?q=${encodeURIComponent('陈舟')}`);expect(sources.sources[0]?.chapterId).toBe(chapter.id);expect(sources.sources[0]?.paragraphId).toBe('p-first');
  });

  it('requires real same-book final evidence and keeps old canon valid until re-finalizing', async () => {
    const { book: b, chapter } = await book(); let draft = await final(await saved(chapter, '林砚把铜钥匙交给陈舟。'));
    const source = await evidence(draft); const fact = await entry(b.id, { kind: 'item', authority: 'fact', title: '铜钥匙', content: '陈舟持有铜钥匙。', aliases: ['钥匙'], evidence: [source] });
    expect((await ok<{ entries: StoryEntry[] }>('GET', `/api/books/${b.id}/story?q=${encodeURIComponent('钥匙')}`)).entries[0]?.id).toBe(fact.id);
    const other = await book();
    expect((await app.inject({ method: 'POST', url: `/api/books/${other.book.id}/story`, payload: { kind: 'event', authority: 'fact', title: '不应跨书', content: '交接', evidence: [source] } })).statusCode).toBe(400);
    draft = await saved(draft, '林砚把铜钥匙交给许衡。');
    expect((await ok<{ entry: StoryEntry }>('GET', `/api/story/${fact.id}`)).entry.needsReview).toBe(false);
    await final(draft); expect((await ok<{ entry: StoryEntry }>('GET', `/api/story/${fact.id}`)).entry.needsReview).toBe(true);
    expect((await ok<{ events: unknown[] }>('GET', `/api/story/${fact.id}/history`)).events).toHaveLength(2);
  });

  it('reports direct prose dependencies even when the old chapter has no confirmed fact entries', async()=>{
    const {book:b,chapter}=await book();const official=await final(await saved(chapter,'林砚等到码头熄灯。'));
    const next=(await ok<{chapter:Chapter}>('POST',`/api/books/${b.id}/chapters`,{})).chapter;
    const job=await finished((await start(next)).id);expect(job.context.some((item)=>item.revisionId===official.finalizedRevisionId)).toBe(true);
    await final(await saved(official,'林砚在天亮时到了码头。'));
    const result=await ok<{impacts:Array<{entryId:string;chapterIds:string[]}>}>('GET',`/api/books/${b.id}/impacts`);expect(result.impacts.some((item)=>item.entryId===`revision:${official.finalizedRevisionId}`&&item.chapterIds.includes(next.id))).toBe(true);
  });

  it('extracts only from final prose, isolates candidates, and rejects stale proposals', async () => {
    const { book: b, chapter } = await book(); const draft = await final(await saved(chapter, '林砚把铜钥匙交给陈舟。'));
    output = JSON.stringify({ entries: [{ kind: 'item', authority: 'fact', title: '铜钥匙', content: '陈舟获得铜钥匙。', visibility: 'public', evidence: [{ paragraphId: 'p-first', quote: '林砚把铜钥匙交给陈舟。' }] }] });
    const job = await finished((await start(draft, 'extract')).id); expect(job.status, job.error ?? '').toBe('succeeded');
    expect((await ok<{ entries: StoryEntry[] }>('GET', `/api/books/${b.id}/story`)).entries).toHaveLength(0);
    const proposals = (await ok<{ proposals: StoryProposal[] }>('GET', `/api/books/${b.id}/proposals`)).proposals; expect(proposals).toHaveLength(1);
    const decision = await ok<{ proposal: StoryProposal }>('POST', `/api/proposals/${proposals[0]!.id}/accept`, {}); expect(decision.proposal.entryId).toBeTruthy();
    await ok('POST', `/api/proposals/${proposals[0]!.id}/accept`, {}); expect((await ok<{ entries: StoryEntry[] }>('GET', `/api/books/${b.id}/story`)).entries).toHaveLength(1);
    const second = await finished((await start(draft, 'extract')).id); expect(second.status).toBe('succeeded');
    const pending = (await ok<{ proposals: StoryProposal[] }>('GET', `/api/books/${b.id}/proposals`)).proposals.find((p) => p.state === 'pending')!;
    await final(await saved(draft, '钥匙留在林砚手里。'));
    expect((await app.inject({ method: 'POST', url: `/api/proposals/${pending.id}/accept`, payload: {} })).statusCode).toBe(409);
  });

  it('extracts an unchanged official version even when the working draft is being revised', async () => {
    const { chapter } = await book(); const official = await final(await saved(chapter, '旧定稿的事实。'));
    const revising = await saved(official, '新草稿尚未定稿。');
    output = JSON.stringify({ entries: [{ kind: 'event', authority: 'fact', title: '旧定稿事件', content: '只从定稿提取。', evidence: [{ paragraphId: 'p-first', quote: '旧定稿的事实。' }] }] });
    const job = await finished((await start(revising, 'extract')).id); expect(job.status, job.error ?? '').toBe('succeeded'); expect(job.inputVersion).toBe(official.version);
    expect(JSON.stringify(job.inputDocument)).not.toContain('新草稿');
  });

  it('atomically finalizes a frozen draft and chosen evidence proposals, including rollback and retry', async () => {
    const {book:b,chapter}=await book();const draft=await saved(chapter,'林砚把钥匙交给陈舟。');
    output=JSON.stringify({entries:[{kind:'item',authority:'fact',title:'钥匙交接',content:'陈舟获得钥匙。',evidence:[{paragraphId:'p-first',quote:'林砚把钥匙交给陈舟。'}]}]});
    const job=await finished((await start(draft,'extract',{source:'draft'})).id);expect(job.status,job.error??'').toBe('succeeded');
    const proposals=(await ok<{proposals:StoryProposal[]}>('GET',`/api/books/${b.id}/proposals`)).proposals;
    const proposal=proposals[0]!;expect(proposal.requiresFinalization).toBe(true);expect(proposal.stale).toBe(false);
    expect((await app.inject({method:'POST',url:`/api/proposals/${proposal.id}/accept`,payload:{}})).statusCode).toBe(409);
    const bad=await app.inject({method:'POST',url:`/api/chapters/${draft.id}/finalize`,payload:{expectedVersion:draft.version,proposalIds:[proposal.id,'missing-proposal']}});expect(bad.statusCode).toBe(404);
    expect((await getChapter(draft.id)).finalizedRevisionId).toBeNull();expect((await ok<{entries:StoryEntry[]}>('GET',`/api/books/${b.id}/story`)).entries).toHaveLength(0);
    const first=await ok<{chapter:Chapter}>('POST',`/api/chapters/${draft.id}/finalize`,{expectedVersion:draft.version,proposalIds:[proposal.id,proposal.id]});
    const facts=(await ok<{entries:StoryEntry[]}>('GET',`/api/books/${b.id}/story`)).entries;expect(facts).toHaveLength(1);expect(facts[0]!.evidence[0]!.revisionId).toBe(first.chapter.finalizedRevisionId);
    await ok('POST',`/api/chapters/${draft.id}/finalize`,{expectedVersion:draft.version,proposalIds:[proposal.id]});expect((await ok<{entries:StoryEntry[]}>('GET',`/api/books/${b.id}/story`)).entries).toHaveLength(1);
    const source=job.context.find((item)=>item.source==='chapter')!;expect(source.revisionId).not.toBe(first.chapter.finalizedRevisionId);
    const backup=await ok<WorkspaceBackup>('GET','/api/backup');await ok('POST','/api/backup/restore',{backup});
  });

  it('rejects stale draft facts without undoing saved text or replacing the previous official revision', async () => {
    const {book:b,chapter}=await book();const official=await final(await saved(chapter,'钥匙原在林砚手里。'));const draft=await saved(official,'林砚把钥匙交给陈舟。');
    output=JSON.stringify({entries:[{kind:'item',authority:'fact',title:'钥匙交接',content:'陈舟持有。',evidence:[{paragraphId:'p-first',quote:'林砚把钥匙交给陈舟。'}]}]});
    expect((await finished((await start(draft,'extract',{source:'draft'})).id)).status).toBe('succeeded');
    const proposal=(await ok<{proposals:StoryProposal[]}>('GET',`/api/books/${b.id}/proposals`)).proposals[0]!;
    const newer=await saved(draft,'林砚决定继续保管钥匙。');
    expect((await app.inject({method:'POST',url:`/api/chapters/${newer.id}/finalize`,payload:{expectedVersion:newer.version,proposalIds:[proposal.id]}})).statusCode).toBe(409);
    const still=await getChapter(newer.id);expect(still.plainText).toBe(newer.plainText);expect(still.finalizedRevisionId).toBe(official.finalizedRevisionId);
    const backup=await ok<WorkspaceBackup>('GET','/api/backup');await ok('POST','/api/backup/restore',{backup});
  });

  it('binds reviews to snapshots, expires them after edits, and refuses invented quotations', async () => {
    const { chapter } = await book(); const draft = await saved(chapter, '她站在雨里。');
    output = JSON.stringify({ issues: [{ severity: 'suggestion', message: '可以补充她等待的具体目标。', quote: '她站在雨里。', entryIds: [] }] });
    const job = await finished((await start(draft, 'review')).id); expect(job.status).toBe('succeeded');
    let reviews = (await ok<{ reviews: ChapterReview[] }>('GET', `/api/chapters/${draft.id}/reviews`)).reviews; expect(reviews[0]?.stale).toBe(false);
    const newer = await saved(draft, '她站在雨里等船。'); reviews = (await ok<{ reviews: ChapterReview[] }>('GET', `/api/chapters/${draft.id}/reviews`)).reviews; expect(reviews[0]?.stale).toBe(true);
    output = JSON.stringify({ issues: [{ severity: 'warning', message: '伪造引用', quote: '正文没有这句话', entryIds: [] }] });
    expect((await finished((await start(newer, 'review')).id)).status).toBe('failed');
  });

  it('preserves malformed model output with at most one JSON repair, without declaring a clean review', async () => {
    const { chapter } = await book(); const draft = await saved(chapter, '雨没有停。'); output = '{not json';
    const job = await finished((await start(draft, 'review')).id); expect(job.status).toBe('failed'); expect(job.output).toBe(output); expect(job.usage.attempts).toBe(2);
    expect((await ok<{ reviews: ChapterReview[] }>('GET', `/api/chapters/${draft.id}/reviews`)).reviews).toHaveLength(0);
    const records=await ok<{calls:Array<{output:string}>}>('GET',`/api/jobs/${job.id}/calls`);expect(records.calls.map((record)=>record.output)).toEqual([output,output]);
  });

  it('restores canon, proposals, reviews, jobs, calls and links atomically to independent IDs', async () => {
    const { book: b, chapter } = await book(); const draft = await final(await saved(chapter, '钥匙交给陈舟。'));
    const fact = await entry(b.id, { kind: 'item', authority: 'fact', title: '铜钥匙', content: '陈舟持有。', evidence: [await evidence(draft)] });
    output = JSON.stringify({ issues: [] }); const review = await finished((await start(draft, 'review')).id); expect(review.status).toBe('succeeded');
    const backup = await ok<WorkspaceBackup>('GET', '/api/backup');
    const restored = await ok<{ books: Book[] }>('POST', '/api/backup/restore', { backup }); const copy = restored.books[0]!;
    expect(copy.id).not.toBe(b.id);
    const facts = await ok<{ entries: StoryEntry[] }>('GET', `/api/books/${copy.id}/story`); expect(facts.entries).toHaveLength(1); expect(facts.entries[0]?.id).not.toBe(fact.id); expect(facts.entries[0]?.needsReview).toBe(false);
    const jobs = await ok<{ jobs: AiJob[] }>('GET', `/api/books/${copy.id}/jobs`); expect(jobs.jobs).toHaveLength(1); expect(jobs.jobs[0]?.id).not.toBe(review.id); expect(jobs.jobs[0]?.context.some((item) => item.entryId === facts.entries[0]!.id)).toBe(true);
    const canonical = await ok<WorkspaceBackup>('GET', '/api/backup'); const corrupt = structuredClone(canonical); corrupt.books[0]!.extensions!.story = { version: 1, entries: [], events: [], proposals: [], reviews: [], dependencies: [{ jobId: 'missing', bookId: 'x', chapterId: 'missing', entryIds: [], revisionIds: [] }] };
    expect((await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { backup: corrupt } })).statusCode).toBe(400);
    expect((await ok<{ books: Book[] }>('GET', '/api/books')).books).toHaveLength(2);
  });

  it('keeps optional book/arc/chapter/scene planning separate from facts and restores the hierarchy', async () => {
    const {book:b,chapter}=await book();
    const plan=async(title:string,level:PlanNode['level'],parentId:string|null,chapterId:string|null)=>(await ok<{plan:PlanNode}>('POST',`/api/books/${b.id}/plans`,{title,level,parentId,chapterId,content:'未来安排，尚未发生。',position:1})).plan;
    const direction=await plan('全书方向','book',null,null);const arc=await plan('雾港篇','arc',direction.id,null);const chapterPlan=await plan('本章冲突','chapter',arc.id,chapter.id);const scene=await plan('渡口场景','scene',chapterPlan.id,chapter.id);
    const job=await finished((await start(chapter)).id);expect(job.context.some((item)=>item.id.startsWith(`plan:${scene.id}:`))).toBe(true);expect(job.context.filter((item)=>item.id.startsWith('plan:')).every((item)=>item.label.includes('尚未发生'))).toBe(true);
    expect((await ok<{entries:StoryEntry[]}>('GET',`/api/books/${b.id}/story`)).entries).toHaveLength(0);
    expect((await app.inject({method:'POST',url:`/api/books/${b.id}/plans`,payload:{title:'错误层级',level:'scene',parentId:direction.id,chapterId:chapter.id,content:'',position:1}})).statusCode).toBe(400);
    const backup=await ok<WorkspaceBackup>('GET','/api/backup');const restored=await ok<{books:Book[]}>('POST','/api/backup/restore',{backup});
    const copied=(await ok<{plans:PlanNode[]}>('GET',`/api/books/${restored.books[0]!.id}/plans`)).plans;expect(copied).toHaveLength(4);
    const newScene=copied.find((node)=>node.level==='scene')!;expect(newScene.parentId).toBe(copied.find((node)=>node.level==='chapter')!.id);expect(newScene.id).not.toBe(scene.id);
  });
});
