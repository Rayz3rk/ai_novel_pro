import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiJob, Book, Chapter, ContextPreview, CreativeProfile, CreativeSkill, ModelSettings, SkillDefinition, WorkspaceBackup } from '../../packages/contracts/src/index.js';
import { storageHarness } from './storage-harness.js';
import { builtinSkills, creativeHash, skillDefinition } from '../../apps/server/src/creative/definitions.js';
import { importSkill, parsePromptSnapshot } from '../../apps/server/src/creative/validation.js';
import { cleanManuscript } from '../../apps/server/src/creative/clean.js';

const harness = storageHarness('creative');
describe('versioned creative methods and author profiles', () => {
  let app: ReturnType<typeof harness.createApp>;
  let fixture: Server;
  let calls: Array<{ messages: Array<{ role: string; content: string }> }>;
  let settings: Omit<ModelSettings, 'id' | 'hasApiKey'>;
  let repair: boolean;
  beforeEach(async () => {
    harness.reset(); calls = []; repair = false;
    fixture = createServer(async (req, res) => {
      let body = ''; for await (const part of req) body += part;
      calls.push(JSON.parse(body) as typeof calls[number]);
      res.setHeader('content-type', 'application/json');
      const output = repair ? calls.length === 1 ? '{invalid-json' : '{"issues":[]}' : '这是隔离模型的候选。';
      res.end(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 15 } }));
    });
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
    const address = fixture.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
    const directory = await mkdtemp(join(tmpdir(), 'shujian-creative-'));
    app = harness.createApp({ dataDir: join(directory, 'data'), credentialDir: join(directory, 'credentials'), connectionsFile: join(directory, 'connections.json') });
    await app.ready();
    settings = { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'local-creative-fixture', stream: false, temperature: 0.7, maxOutputTokens: 512, contextWindow: 20000, inputPricePerMillion: 1, outputPricePerMillion: 2, taskBudget: null, dailyBudget: null };
    await ok('PUT', '/api/model', settings);
  });
  afterEach(async () => { await app.close(); fixture.closeAllConnections(); await new Promise<void>((done) => fixture.close(() => done())); });
  async function ok<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode, response.body).toBeLessThan(300); return response.json<T>();
  }
  async function setup() {
    const { book } = await ok<{ book: Book }>('POST', '/api/books', { title: '创作方法 · 隔离测试' });
    const { chapters } = await ok<{ chapters: Chapter[] }>('GET', `/api/books/${book.id}/chapters`);
    return { book, chapter: (await ok<{ chapter: Chapter }>('GET', `/api/chapters/${chapters[0]!.id}`)).chapter };
  }
  const definition = (instructions = '只使用给定信息，保留人物选择。'): SkillDefinition => ({ ...skillDefinition(builtinSkills[0]!), name: 'custom-method', title: '自定义方法', instructions });
  const createSkill = async (bookId: string, value = definition()) => (await ok<{ skill: CreativeSkill }>('POST', `/api/books/${bookId}/skills`, { definition: value, expectedVersion: 0, enabled: true })).skill;
  const profile = async (bookId: string) => (await ok<{ profile: CreativeProfile }>('GET', `/api/books/${bookId}/creative`)).profile;
  const putProfile = async (bookId: string, value: CreativeProfile) => (await ok<{ profile: CreativeProfile }>('PUT', `/api/books/${bookId}/creative`, { ...value, expectedVersion: value.version })).profile;
  const input = (chapter: Chapter) => ({ requestId: randomUUID(), kind: 'draft' as const, chapterId: chapter.id, expectedVersion: chapter.version, instruction: '只在给定材料中写一个候选。' });
  const preview = async (value: object) => (await ok<{ preview: ContextPreview }>('POST', '/api/jobs/preview', value)).preview;
  async function finish(id: string): Promise<AiJob> {
    for (let n = 0; n < 150; n++) { const { job } = await ok<{ job: AiJob }>('GET', `/api/jobs/${id}`); if (!['queued', 'running'].includes(job.status)) return job; await pause(10); }
    throw new Error('Fixture did not finish');
  }
  const stableBackup = async () => { const backup = await ok<WorkspaceBackup>('GET', '/api/backup'); return backup.books; };

  it('provides six original, read-only methods and keeps custom revisions with CAS', async () => {
    const { book } = await setup(); const { skills } = await ok<{ skills: CreativeSkill[] }>('GET', `/api/books/${book.id}/creative`);
    expect(skills).toHaveLength(6); expect(skills.every((skill) => skill.hash === creativeHash(skillDefinition(skill)))).toBe(true);
    const skill = await createSkill(book.id);
    const changed = await ok<{ skill: CreativeSkill }>('PUT', `/api/books/${book.id}/skills/${skill.id}`, { definition: definition('第二版明确的方法。'), expectedVersion: 1, enabled: false });
    expect(changed.skill.version).toBe(2); expect(changed.skill.enabled).toBe(false);
    const history = await ok<{ skills: CreativeSkill[] }>('GET', `/api/books/${book.id}/skills/${skill.id}/history`);
    expect(history.skills.map((entry) => entry.version)).toEqual([2, 1]); expect(history.skills[1]!.instructions).toBe(skill.instructions);
    expect((await app.inject({ method: 'PUT', url: `/api/books/${book.id}/skills/${skill.id}`, payload: { definition: definition(), expectedVersion: 1, enabled: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: `/api/books/${book.id}/skills/${skills[0]!.id}`, payload: { definition: definition(), expectedVersion: 1, enabled: true } })).statusCode).toBe(409);
    const other = await setup(); expect((await app.inject({ method: 'GET', url: `/api/books/${other.book.id}/skills/${skill.id}/history` })).statusCode).toBe(404);
  });
  it('imports declarative Markdown and packaged resources while rejecting tools and escaping references', async () => {
    const markdown = '---\nname: natural-dialogue\ndescription: >\n  写自然的对白\n  保留人物差异\nlicense: MIT\n---\n按[示例](references/example.md)检查对白。';
    const parsed = importSkill({ markdown, resources: [{ path: 'references/example.md', text: '只保留与当前人物有关的表达示例。' }] });
    expect(parsed.description).toBe('写自然的对白 保留人物差异'); expect(parsed.resources).toHaveLength(1);
    expect(() => importSkill({ markdown })).toThrow('未包含');
    expect(() => importSkill({ markdown: markdown.replace('license: MIT', 'allowed-tools: Bash\nlicense: MIT') })).toThrow('工具权限');
    for (const path of ['../escape.md', '/absolute.md', 'https://example.com/a.md', 'scripts/run.py']) expect(() => importSkill({ definition: { ...definition(), resources: [{ path, text: 'x' }] } })).toThrow();
    expect(() => importSkill({ definition: { ...definition(), scripts: ['run.js'] } })).toThrow('不支持');
    const { book } = await setup(); const result = await ok<{ skill: CreativeSkill }>('POST', `/api/books/${book.id}/skills/import`, { definition: parsed });
    const exported = await ok<{ definition: SkillDefinition }>('GET', `/api/books/${book.id}/skills/${result.skill.id}/export`); expect(exported.definition).toEqual(parsed);
  });
  it('previews final materials without tasks, checkpoints, provider calls or workspace mutations', async () => {
    const { book, chapter } = await setup(); const skill = await createSkill(book.id);
    const before = await stableBackup(); const value = await preview({ ...input(chapter), skills: [{ id: skill.id, version: 1 }] });
    expect(value.blocked).toBeNull(); expect(value.prompt.creativity.skills[0]!.hash).toBe(skill.hash);
    expect(value.included.some((entry) => entry.source === 'skill')).toBe(true);
    expect(value.estimatedCost).toBeGreaterThan(0); expect(value.inputTokens + value.outputTokens).toBeLessThan(value.contextWindow);
    expect(await stableBackup()).toEqual(before); expect(calls).toHaveLength(0);
    expect(parsePromptSnapshot(value.prompt)).toEqual(value.prompt);
  });
  it('uses only selected voice cards and confirmed preferences, with profile history and conflict checks', async () => {
    const { book, chapter } = await setup(); let p = await profile(book.id);
    p.style.tone = '轻松自然，不替人物解释所有心事。';
    p.voices = [{ id: 'voice-a', name: '甲', aliases: [], traits: '简短克制', example: '我来处理。' }, { id: 'voice-b', name: '乙', aliases: [], traits: 'SECRET_UNSELECTED', example: '' }];
    p.preferences = [{ id: 'pref-a', title: '先有动作', before: '', after: '', reason: '让动作承载情绪', condition: '紧张对话', counterExample: '允许直接表达', status: 'pending' }];
    p = await putProfile(book.id, p);
    const value = await preview({ ...input(chapter), voiceIds: ['voice-a'] }); const text = JSON.stringify(value.prompt.messages);
    expect(text).toContain('简短克制'); expect(text).not.toContain('SECRET_UNSELECTED'); expect(text).not.toContain('让动作承载情绪');
    const stale = structuredClone(p); p.preferences[0]!.status = 'confirmed'; p = await putProfile(book.id, p);
    expect(JSON.stringify((await preview(input(chapter))).prompt.messages)).toContain('让动作承载情绪');
    expect((await app.inject({ method: 'PUT', url: `/api/books/${book.id}/creative`, payload: { ...stale, expectedVersion: stale.version } })).statusCode).toBe(409);
    p.preferences[0]!.status = 'withdrawn'; await putProfile(book.id, p);
    expect(JSON.stringify((await preview(input(chapter))).prompt.messages)).not.toContain('让动作承载情绪');
    expect((await ok<{ profiles: CreativeProfile[] }>('GET', `/api/books/${book.id}/creative/history`)).profiles).toHaveLength(3);
  });
  it('rejects stale previews before creating checkpoints or making a model request', async () => {
    const { book, chapter } = await setup(); const skill = await createSkill(book.id); const req = { ...input(chapter), skills: [{ id: skill.id, version: 1 }] };
    const value = await preview(req); let p = await profile(book.id); p.style.tone = '更新后的风格'; p = await putProfile(book.id, p);
    const before = await stableBackup();
    const response = await app.inject({ method: 'POST', url: '/api/jobs', payload: { ...req, previewFingerprint: value.fingerprint } });
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('PREVIEW_CHANGED');
    expect(await stableBackup()).toEqual(before); expect(calls).toHaveLength(0);
    await ok('PUT', `/api/books/${book.id}/skills/${skill.id}`, { definition: definition('更新后的方法'), expectedVersion: 1, enabled: true });
    expect((await app.inject({ method: 'POST', url: '/api/jobs/preview', payload: req })).statusCode).toBe(409);
  });
  it('executes the exact frozen prompt and preserves its skill revision after later edits', async () => {
    const { book, chapter } = await setup(); const skill = await createSkill(book.id); const req = { ...input(chapter), skills: [{ id: skill.id, version: 1, focus: '保留停顿' }] };
    const value = await preview(req);
    const { job } = await ok<{ job: AiJob }>('POST', '/api/jobs', { ...req, previewFingerprint: value.fingerprint });
    const done = await finish(job.id); expect(done.status).toBe('succeeded');
    expect(calls[0]!.messages).toEqual(value.prompt.messages);
    await ok('PUT', `/api/books/${book.id}/skills/${skill.id}`, { definition: definition('这是下一版方法'), expectedVersion: 1, enabled: true });
    const saved = (await ok<{ job: AiJob }>('GET', `/api/jobs/${job.id}`)).job;
    expect(saved.promptSnapshot).toEqual(value.prompt); expect(saved.promptSnapshot!.creativity.skills[0]!.version).toBe(1);
    expect((await ok<{ chapter: Chapter }>('GET', `/api/chapters/${chapter.id}`)).chapter.version).toBe(chapter.version);
  });
  it('explains optional material omissions and refuses oversized required methods without calls', async () => {
    const { book, chapter } = await setup(); const p = await profile(book.id);
    p.preferences = Array.from({ length: 5 }, (_, i) => ({ id: `p-${i}`, title: `偏好${i}`, before: '原句'.repeat(150), after: '', reason: '偏好'.repeat(150), condition: '', counterExample: '', status: 'confirmed' }));
    await putProfile(book.id, p); await ok('PUT', '/api/model', { ...settings, contextWindow: 1800 });
    const value = await preview(input(chapter)); expect(value.omitted.length).toBeGreaterThan(0); expect(value.omitted.every((entry) => entry.reason.includes('预算'))).toBe(true);
    const skill = await createSkill(book.id, definition('长方法'.repeat(3000)));
    const blocked = await preview({ ...input(chapter), skills: [{ id: skill.id, version: 1 }] }); expect(blocked.blocked?.code).toBe('CONTEXT_BUDGET');
    expect(calls).toHaveLength(0);
  });
  it('applies disabled and default methods per book without granting a task outside the declared scope', async () => {
    const { book, chapter } = await setup(); const p = await profile(book.id); const skill = builtinSkills[0]!;
    p.defaultSkillIds.draft = [skill.id]; await putProfile(book.id, p);
    expect((await preview(input(chapter))).prompt.creativity.skills.map((entry) => entry.id)).toEqual([skill.id]);
    const updated = await profile(book.id); updated.disabledSkillIds = [skill.id]; updated.defaultSkillIds = {}; await putProfile(book.id, updated);
    expect((await app.inject({ method: 'POST', url: '/api/jobs/preview', payload: { ...input(chapter), skills: [{ id: skill.id, version: 1 }] } })).statusCode).toBe(409);
    const clean = builtinSkills.find((entry) => entry.name === 'manuscript-clean')!;
    expect((await app.inject({ method: 'POST', url: '/api/jobs/preview', payload: { ...input(chapter), skills: [{ id: clean.id, version: 1 }] } })).statusCode).toBe(400);
  });
  it('restores custom skills, profiles, histories and immutable prompts with references remapped', async () => {
    const { book, chapter } = await setup(); const skill = await createSkill(book.id); const p = await profile(book.id);
    p.voices = [{ id: 'voice-a', name: '甲', aliases: [], traits: '简短', example: '' }]; p.defaultSkillIds.draft = [skill.id]; await putProfile(book.id, p);
    const { job } = await ok<{ job: AiJob }>('POST', '/api/jobs', { ...input(chapter), voiceIds: ['voice-a'] }); await finish(job.id);
    const backup = await ok<WorkspaceBackup>('GET', '/api/backup');
    const restored = await ok<{ books: Book[] }>('POST', '/api/backup/restore', { backup }); const newBook = restored.books[0]!;
    const data = await ok<{ profile: CreativeProfile; skills: CreativeSkill[] }>('GET', `/api/books/${newBook.id}/creative`);
    const custom = data.skills.find((entry) => !entry.builtin)!; expect(custom.id).not.toBe(skill.id); expect(custom.hash).toBe(skill.hash);
    expect(data.profile.defaultSkillIds.draft).toEqual([custom.id]); expect(data.profile.voices[0]!.id).not.toBe('voice-a');
    const jobs = await ok<{ jobs: AiJob[] }>('GET', `/api/books/${newBook.id}/jobs`); expect(jobs.jobs[0]!.promptSnapshot).toEqual((await finish(job.id)).promptSnapshot);
    const before = (await ok<{ books: Book[] }>('GET', '/api/books')).books.length;
    const corrupted = structuredClone(backup); const extra = corrupted.books[0]!.extensions!.ai as unknown as Array<{ job: AiJob }>;
    extra[0]!.job.promptSnapshot!.messages[0]!.content += '篡改';
    expect((await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { backup: corrupted } })).statusCode).toBe(400);
    expect((await ok<{ books: Book[] }>('GET', '/api/books')).books).toHaveLength(before);
  });
  it('accepts a legacy backup with no creative extension or prompt snapshot', async () => {
    const { chapter } = await setup(); const { job } = await ok<{ job: AiJob }>('POST', '/api/jobs', input(chapter)); await finish(job.id);
    const backup = await ok<WorkspaceBackup>('GET', '/api/backup'); delete backup.books[0]!.extensions!.creative;
    const ai = backup.books[0]!.extensions!.ai as unknown as Array<{ job: AiJob; calls: Array<{ requestMessages?: unknown; promptHash?: string }> }>;
    delete ai[0]!.job.promptSnapshot; for (const call of ai[0]!.calls) { delete call.requestMessages; delete call.promptHash; }
    const restored = await ok<{ books: Book[] }>('POST', '/api/backup/restore', { backup });
    expect((await profile(restored.books[0]!.id)).version).toBe(0);
    expect((await ok<{ jobs: AiJob[] }>('GET', `/api/books/${restored.books[0]!.id}/jobs`)).jobs[0]!.promptSnapshot).toBeUndefined();
  });
  it('persists the actual prompt of each format-repair call and rejects a corrupted call transcript', async () => {
    repair = true; const { chapter } = await setup();
    const { job } = await ok<{ job: AiJob }>('POST', '/api/jobs', { ...input(chapter), kind: 'review' });
    const done = await finish(job.id); expect(done.status).toBe('succeeded'); expect(calls).toHaveLength(2);
    const record = await ok<{ calls: Array<{ requestMessages: unknown; promptHash: string }> }>('GET', `/api/jobs/${job.id}/calls`);
    expect(record.calls[0]!.requestMessages).toEqual(calls[0]!.messages); expect(record.calls[1]!.requestMessages).toEqual(calls[1]!.messages);
    expect(record.calls[1]!.requestMessages).not.toEqual(record.calls[0]!.requestMessages);
    for (const call of record.calls) expect(call.promptHash).toBe(creativeHash(call.requestMessages));
    const backup = await ok<WorkspaceBackup>('GET', '/api/backup');
    const ai = backup.books[0]!.extensions!.ai as unknown as Array<{ calls: Array<{ requestMessages: Array<{ content: string }> }> }>;
    ai[0]!.calls[1]!.requestMessages[0]!.content += '篡改';
    expect((await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { backup } })).statusCode).toBe(400);
  });
  it('exports reproducible evaluation material without credentials, and runs clean checks without a model', async () => {
    const { chapter } = await setup(); const { job } = await ok<{ job: AiJob }>('POST', '/api/jobs', input(chapter)); await finish(job.id);
    const sample = await ok<{ format: string; prompt: unknown }>('GET', `/api/jobs/${job.id}/evaluation-sample`); expect(sample.format).toBe('shujian-creative-evaluation');
    expect(sample.prompt).toEqual((await finish(job.id)).promptSnapshot); expect(JSON.stringify(sample)).not.toContain('apiKey');
    const count = calls.length; const check = await ok<{ findings: unknown[]; modelCalled: boolean }>('GET', `/api/chapters/${chapter.id}/clean-check`);
    expect(check.modelCalled).toBe(false); expect(calls).toHaveLength(count);
    const findings = cleanManuscript('【作者本次要求】\n这是一整段重复的测试正文。\n\n这是一整段重复的测试正文。\n[待补正文]');
    expect(findings.map((entry) => entry.rule)).toEqual(expect.arrayContaining(['instruction-residue', 'adjacent-repeat', 'placeholder-or-encoding']));
    expect(cleanManuscript('“AI 是我们的讨论课题。”她说。\nHello, Lin.')).toEqual([]);
  });
});
