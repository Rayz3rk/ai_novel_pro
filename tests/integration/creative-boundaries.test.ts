import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiJob, Book, Chapter, ContextPreview, CreativeProfile, CreativeSkill, ModelSettings, WorkspaceBackup } from '@shujian/contracts';
import { AiService } from '../../apps/server/src/ai/index.js';
import { builtinSkills, skillDefinition } from '../../apps/server/src/creative/definitions.js';
import { storageHarness } from './storage-harness.js';

const harness = storageHarness('creative_boundaries');
describe('creative state and backup boundaries', () => {
  let app: ReturnType<typeof harness.createApp>;
  let fixture: Server;
  beforeEach(async () => {
    harness.reset();
    fixture = createServer(async (request, response) => {
      for await (const _chunk of request) { /* local deterministic fixture */ }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: '隔离测试候选。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    });
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
    const address = fixture.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing');
    const directory = await mkdtemp(join(tmpdir(), 'shujian-creative-boundaries-'));
    app = harness.createApp({ dataDir: join(directory, 'data'), credentialDir: join(directory, 'credentials'), connectionsFile: join(directory, 'connections.json') });
    await app.ready();
    const { settings } = await ok<{ settings: ModelSettings }>('GET', '/api/model');
    await ok('PUT', '/api/model', { ...settings, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'local-boundary-fixture', stream: false, maxOutputTokens: 512, contextWindow: 20000 });
  });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); fixture.closeAllConnections(); await new Promise<void>((done) => fixture.close(() => done())); });
  async function ok<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<T> {
    const result = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect(result.statusCode, result.body).toBeLessThan(300); return result.json<T>();
  }
  async function setup() {
    const { book } = await ok<{ book: Book }>('POST', '/api/books', { title: '创作边界 · 隔离工程样本' });
    const { chapters } = await ok<{ chapters: Chapter[] }>('GET', `/api/books/${book.id}/chapters`);
    const { chapter } = await ok<{ chapter: Chapter }>('GET', `/api/chapters/${chapters[0]!.id}`);
    const { profile } = await ok<{ profile: CreativeProfile }>('GET', `/api/books/${book.id}/creative`);
    return { book, chapter, profile };
  }
  const input = (chapter: Chapter) => ({ requestId: randomUUID(), kind: 'draft' as const, chapterId: chapter.id, expectedVersion: chapter.version, instruction: '只使用给定材料。' });
  async function done(id: string) {
    for (let n = 0; n < 150; n++) { const { job } = await ok<{ job: AiJob }>('GET', `/api/jobs/${id}`); if (!['queued', 'running'].includes(job.status)) return job; await pause(10); }
    throw new Error('Fixture did not finish');
  }
  async function backup() { return ok<WorkspaceBackup>('GET', '/api/backup'); }
  const creative = (value: WorkspaceBackup): { profile: CreativeProfile; profileHistory: CreativeProfile[] } => value.books[0]!.extensions!.creative as unknown as { profile: CreativeProfile; profileHistory: CreativeProfile[] };

  it('can re-enable a builtin and select it as a default in the same profile update', async () => {
    const { book, profile } = await setup(); const skill = builtinSkills[0]!;
    const disabled = await ok<{ profile: CreativeProfile }>('PUT', `/api/books/${book.id}/creative`, { ...profile, expectedVersion: 0, disabledSkillIds: [skill.id] });
    const result = await app.inject({ method: 'PUT', url: `/api/books/${book.id}/creative`, payload: { ...disabled.profile, expectedVersion: disabled.profile.version, disabledSkillIds: [], defaultSkillIds: { draft: [skill.id] } } });
    expect(result.statusCode, result.body).toBe(200);
  });

  it('uses one model-settings snapshot for preview validation and execution even when configuration changes between reads', async () => {
    const { chapter } = await setup(); const request = input(chapter);
    const original = AiService.prototype.settings;
    let phase: 'preview' | 'create' = 'preview'; let reads = 0;
    vi.spyOn(AiService.prototype, 'settings').mockImplementation(function (this: AiService, id?: string) {
      const settings = original.call(this, id);
      return { ...settings, model: phase === 'preview' ? 'preview-model-b' : reads++ === 0 ? 'first-model-a' : 'preview-model-b' };
    });
    const { preview } = await ok<{ preview: ContextPreview }>('POST', '/api/jobs/preview', request);
    phase = 'create'; reads = 0;
    const result = await app.inject({ method: 'POST', url: '/api/jobs', payload: { ...request, previewFingerprint: preview.fingerprint } });
    // A genuine change can be rejected; an accepted request must use the model the author previewed.
    if (result.statusCode === 201) { expect(result.json<{ job: AiJob }>().job.model).toBe(preview.model); await done(result.json<{ job: AiJob }>().job.id); }
    else expect(result.statusCode, result.body).toBe(409);
  });

  it('rejects a restored current profile whose default method cannot perform its task', async () => {
    await setup(); const value = await backup();
    creative(value).profile.defaultSkillIds = { extract: [builtinSkills[0]!.id] };
    const before = (await ok<{ books: Book[] }>('GET', '/api/books')).books.length;
    const result = await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { backup: value } });
    expect(result.statusCode, result.body).toBe(400);
    expect((await ok<{ books: Book[] }>('GET', '/api/books')).books).toHaveLength(before);
  });

  it('rejects a restored confirmed preference without the reason required by the save API', async () => {
    await setup(); const value = await backup();
    creative(value).profile.preferences = [{ id: 'restore-preference', title: '没有作者理由', before: '', after: '', reason: '', condition: '', counterExample: '', status: 'confirmed' }];
    const result = await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { backup: value } });
    expect(result.statusCode, result.body).toBe(400);
  });

  it('rejects restored preference provenance when the job belongs to a different chapter', async () => {
    const { book, chapter } = await setup();
    const second = (await ok<{ chapter: Chapter }>('POST', `/api/books/${book.id}/chapters`, {})).chapter;
    const { job } = await ok<{ job: AiJob }>('POST', '/api/jobs', input(chapter)); await done(job.id);
    const value = await backup();
    creative(value).profile.preferences = [{ id: 'restore-source-mismatch', title: '来源不一致', before: '', after: '', reason: '作者反馈', condition: '', counterExample: '', status: 'pending', sourceJobId: job.id, sourceChapterId: second.id }];
    const result = await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { backup: value } });
    expect(result.statusCode, result.body).toBe(400);
  });

  it('labels final-source context with the final revision version rather than the current working version', async () => {
    const { chapter } = await setup();
    const write = async (current: Chapter, text: string) => (await ok<{ chapter: Chapter }>('PUT', `/api/chapters/${current.id}/draft`, { expectedVersion: current.version, title: current.title, outline: '', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } })).chapter;
    const saved = await write(chapter, '已定稿的原文。');
    const finalized = (await ok<{ chapter: Chapter }>('POST', `/api/chapters/${saved.id}/finalize`, { expectedVersion: saved.version })).chapter;
    const newer = await write(finalized, '后来修改的工作稿。');
    const { preview } = await ok<{ preview: ContextPreview }>('POST', '/api/jobs/preview', { ...input(newer), kind: 'extract', source: 'final' });
    const source = preview.included.find((entry) => entry.id === 'chapter')!;
    expect(source.text).toContain('已定稿的原文'); expect(source.text).not.toContain('后来修改');
    expect(source.label).toContain(`V${finalized.version}`);
    expect(source.label).not.toContain(`V${newer.version}`);
  });

  it('retains valid historical defaults after a custom method changes its supported tasks', async () => {
    const { book, profile } = await setup();
    const definition = skillDefinition(builtinSkills[0]!);
    const { skill } = await ok<{ skill: CreativeSkill }>('POST', `/api/books/${book.id}/skills`, { definition, expectedVersion: 0, enabled: true });
    const previous = await ok<{ profile: CreativeProfile }>('PUT', `/api/books/${book.id}/creative`, { ...profile, expectedVersion: 0, defaultSkillIds: { draft: [skill.id] } });
    await ok('PUT', `/api/books/${book.id}/creative`, { ...previous.profile, expectedVersion: previous.profile.version, defaultSkillIds: {} });
    await ok('PUT', `/api/books/${book.id}/skills/${skill.id}`, { definition: { ...definition, tasks: ['review'] }, expectedVersion: skill.version, enabled: true });
    const value = await backup();
    const restored = await ok<{ books: Book[] }>('POST', '/api/backup/restore', { backup: value });
    const history = await ok<{ profiles: CreativeProfile[] }>('GET', `/api/books/${restored.books[0]!.id}/creative/history`);
    expect(history.profiles).toHaveLength(2);
    expect(history.profiles.find((entry) => entry.version === 1)!.defaultSkillIds.draft).toHaveLength(1);
  });

  it('retries explicit historical methods with their original resources and focus against the current saved draft', async () => {
    const { book, chapter } = await setup();
    const definition = { ...skillDefinition(builtinSkills[0]!), instructions: 'EXPLICIT_METHOD_V1', resources: [{ path: 'references/old.md', text: 'ORIGINAL_SELECTED_RESOURCE' }] };
    const { skill } = await ok<{ skill: CreativeSkill }>('POST', `/api/books/${book.id}/skills`, { definition, expectedVersion: 0, enabled: true });
    const { job } = await ok<{ job: AiJob }>('POST', '/api/jobs', { ...input(chapter), skills: [{ id: skill.id, version: 1, focus: 'ORIGINAL_FOCUS', resourcePaths: ['references/old.md'] }] });
    await done(job.id);
    await ok('PUT', `/api/books/${book.id}/skills/${skill.id}`, { definition: { ...definition, instructions: 'CURRENT_METHOD_V2', resources: [] }, expectedVersion: 1, enabled: true });
    const updated = (await ok<{ chapter: Chapter }>('PUT', `/api/chapters/${chapter.id}/draft`, { expectedVersion: chapter.version, title: chapter.title, outline: '', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '重试时使用的当前保存稿。' }] }] } })).chapter;
    const { job: retried } = await ok<{ job: AiJob }>('POST', `/api/jobs/${job.id}/retry`, {});
    const finished = await done(retried.id);
    expect(finished.status).toBe('succeeded'); expect(finished.inputVersion).toBe(updated.version);
    expect(finished.promptSnapshot!.creativity.skills[0]!.version).toBe(1);
    const messages = JSON.stringify(finished.promptSnapshot!.messages);
    expect(messages).toContain('EXPLICIT_METHOD_V1'); expect(messages).toContain('ORIGINAL_SELECTED_RESOURCE'); expect(messages).toContain('ORIGINAL_FOCUS');
    expect(messages).not.toContain('CURRENT_METHOD_V2'); expect(messages).toContain('重试时使用的当前保存稿');
  });

  it('restores default-method retry bindings independently of changed defaults and respects current disablement', async () => {
    const { book, chapter, profile } = await setup(); const definition = { ...skillDefinition(builtinSkills[0]!), instructions: 'DEFAULT_METHOD_V1' };
    const { skill } = await ok<{ skill: CreativeSkill }>('POST', `/api/books/${book.id}/skills`, { definition, expectedVersion: 0, enabled: true });
    const enabled = await ok<{ profile: CreativeProfile }>('PUT', `/api/books/${book.id}/creative`, { ...profile, expectedVersion: 0, defaultSkillIds: { draft: [skill.id] } });
    const { job } = await ok<{ job: AiJob }>('POST', '/api/jobs', input(chapter)); await done(job.id);
    await ok('PUT', `/api/books/${book.id}/creative`, { ...enabled.profile, expectedVersion: enabled.profile.version, defaultSkillIds: {} });
    await ok('PUT', `/api/books/${book.id}/skills/${skill.id}`, { definition: { ...definition, instructions: 'DEFAULT_METHOD_V2' }, expectedVersion: 1, enabled: true });
    const restored = await ok<{ books: Book[] }>('POST', '/api/backup/restore', { backup: await backup() }); const newBookId = restored.books[0]!.id;
    const { jobs } = await ok<{ jobs: AiJob[] }>('GET', `/api/books/${newBookId}/jobs`); const oldJob = jobs[0]!;
    const { job: retried } = await ok<{ job: AiJob }>('POST', `/api/jobs/${oldJob.id}/retry`, {}); const finished = await done(retried.id);
    expect(finished.status).toBe('succeeded'); expect(finished.promptSnapshot!.creativity.skills).toHaveLength(1);
    expect(finished.promptSnapshot!.creativity.skills[0]!.definition.instructions).toBe('DEFAULT_METHOD_V1');
    const { skills } = await ok<{ skills: CreativeSkill[] }>('GET', `/api/books/${newBookId}/creative`); const current = skills.find((entry) => !entry.builtin)!;
    await ok('PUT', `/api/books/${newBookId}/skills/${current.id}`, { definition: skillDefinition(current), expectedVersion: current.version, enabled: false });
    const blocked = await app.inject({ method: 'POST', url: `/api/jobs/${oldJob.id}/retry`, payload: {} });
    expect(blocked.statusCode, blocked.body).toBe(409); expect(blocked.json().error.code).toBe('SKILL_DISABLED');
  });

  it('rejects restored skill bindings to other record types and rolls back the restore', async () => {
    const { book, chapter } = await setup();
    const { skill } = await ok<{ skill: CreativeSkill }>('POST', `/api/books/${book.id}/skills`, { definition: skillDefinition(builtinSkills[0]!), expectedVersion: 0, enabled: true });
    const { job } = await ok<{ job: AiJob }>('POST', '/api/jobs', { ...input(chapter), skills: [{ id: skill.id, version: 1 }] }); await done(job.id);
    const value = await backup();
    const ai = value.books[0]!.extensions!.ai as unknown as Array<{ job: AiJob }>;
    ai[0]!.job.skillBindings![0]!.skillId = job.id;
    const before = (await ok<{ books: Book[] }>('GET', '/api/books')).books.length;
    const result = await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { backup: value } });
    expect(result.statusCode, result.body).toBe(400);
    expect((await ok<{ books: Book[] }>('GET', '/api/books')).books).toHaveLength(before);
    // Validation covers the full backup, beyond the 200-item history page.
    const records = value.books[0]!.extensions!.ai as unknown as Array<{ job: AiJob; calls: unknown[]; events: unknown[] }>;
    for(let index=0;index<200;index++){
      const copy=structuredClone(records[0]!);copy.job.id=randomUUID();copy.job.createdAt=new Date(Date.UTC(2099,0,1,0,0,index)).toISOString();
      copy.job.skillBindings![0]!.skillId=skill.id;copy.calls=[];copy.events=[];records.push(copy);
    }
    const longHistory=await app.inject({method:'POST',url:'/api/backup/restore',payload:{backup:value}});
    expect(longHistory.statusCode,longHistory.body).toBe(400);
    expect(longHistory.json().error.message).toBe('冻结技能必须关联本作品的创作技能。');
    expect((await ok<{books:Book[]}>('GET','/api/books')).books).toHaveLength(before);
  });
});
