/** Deterministic, isolated evaluations. No author workspace or network model. */
import { readFile, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { AiTaskKind, Book, Chapter, ContextPreview, CreativeProfile, CreativeSkill } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/server/src/app.js';
import { builtinSkills, skillDefinition } from '../apps/server/src/creative/definitions.js';
import { importSkill, taskKinds } from '../apps/server/src/creative/validation.js';
import { cleanManuscript } from '../apps/server/src/creative/clean.js';

type Case = { id: string; kind: 'skill' | 'clean' | 'import' | 'preview'; skill?: string; task?: AiTaskKind; accepted?: boolean;
  text?: string; rules?: string[]; markdown?: string; resources?: Array<{ path: string; text: string }>; scenario?: string };
const root = resolve(import.meta.dirname, '..');
const value = (flag: string, fallback: string) => { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1] ?? fallback; };
const destination = resolve(root, value('--out', join(root, 'test-results/creative-evaluation/report.json')));
const fixturePath = resolve(root, value('--cases', join(root, 'tests/fixtures/creative-evaluation.json')));
assert((await stat(fixturePath)).size <= 2 * 1024 * 1024, '离线案例文件超过 2 MB。');
const rawFixture: unknown = JSON.parse((await readFile(fixturePath, 'utf8')).replace(/^\uFEFF/, ''));
assert(rawFixture && typeof rawFixture === 'object' && !Array.isArray(rawFixture), '案例集格式不正确。');
const fixture = rawFixture as { format: string; version: number; cases: Case[] };
assert.equal(fixture.format, 'shujian-creative-evaluation-cases'); assert.equal(fixture.version, 1);
assert(Array.isArray(fixture.cases) && fixture.cases.length > 0 && fixture.cases.length <= 500, '案例应为 1–500 项。');
const caseIds = new Set<string>();
for (const item of fixture.cases) {
  assert(item && typeof item === 'object' && typeof item.id === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(item.id), '案例 ID 不正确。');
  assert(!caseIds.has(item.id), '案例 ID 重复。'); caseIds.add(item.id);
  assert(['skill', 'clean', 'import', 'preview'].includes(item.kind), '案例类型不支持。');
  if (item.kind === 'skill') assert(typeof item.skill === 'string' && item.skill.length <= 128 && taskKinds.includes(item.task!) && typeof item.accepted === 'boolean', '技能案例需要 ID、任务及预期接受状态。');
  if (item.kind === 'clean') assert(typeof item.text === 'string' && item.text.length <= 100000 && Array.isArray(item.rules) && item.rules.every((rule) => ['instruction-residue', 'placeholder-or-encoding', 'adjacent-repeat'].includes(rule)), '清洁案例需要正文与支持的规则列表。');
  if (item.kind === 'import') assert(typeof item.markdown === 'string' && item.markdown.length <= 30000 && typeof item.accepted === 'boolean', '导入案例需要 Markdown 和预期接受状态。');
  if (item.kind === 'preview') assert(['voices', 'pending', 'secret', 'disabled', 'resources', 'read-only'].includes(item.scenario!), '预览案例场景不支持。');
}
const directory = await mkdtemp(join(tmpdir(), 'shujian-creative-eval-'));
const app = createApp({ dataDir: join(directory, 'data'), credentialDir: join(directory, 'credentials'), connectionsFile: join(directory, 'connections.json'), storage: { driver: 'sqlite', filename: ':memory:' } });
const originalFetch = globalThis.fetch;
let forbiddenRequests = 0;
globalThis.fetch = async () => { forbiddenRequests++; throw new Error('Offline creative evaluation prohibits network requests.'); };
const results: Array<{ id: string; passed: boolean; error?: string }> = [];
async function api<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<T> {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) }); assert(response.statusCode < 300, response.body); return response.json<T>();
}
try {
  await app.ready();
  const { settings } = await api<{ settings: Record<string, unknown> }>('GET', '/api/model');
  await api('PUT', '/api/model', { ...settings, baseUrl: 'http://127.0.0.1:9/v1', model: 'offline-no-provider', maxOutputTokens: 512, contextWindow: 20000 });
  for (const item of fixture.cases) {
    try {
      if (item.kind === 'clean') assert.deepEqual([...new Set(cleanManuscript(item.text ?? '').map((entry) => entry.rule))].sort(), [...(item.rules ?? [])].sort());
      else if (item.kind === 'import') {
        let accepted = false; try { importSkill({ markdown: item.markdown, resources: item.resources ?? [] }); accepted = true; } catch { /* expected rejection cases */ }
        assert.equal(accepted, item.accepted);
      } else {
        const { book } = await api<{ book: Book }>('POST', '/api/books', { title: `离线评测 · ${item.id}` });
        const { chapters } = await api<{ chapters: Chapter[] }>('GET', `/api/books/${book.id}/chapters`); const chapter = chapters[0]!;
        const input = { requestId: randomUUID(), kind: item.task ?? 'draft', chapterId: chapter.id, expectedVersion: chapter.version, instruction: '离线材料选择评估，不发起模型调用。', skills: [] as Array<{ id: string; version: number; resourcePaths?: string[] }>, voiceIds: [] as string[] };
        let profile = (await api<{ profile: CreativeProfile }>('GET', `/api/books/${book.id}/creative`)).profile;
        if (item.kind === 'skill') {
          input.skills = [{ id: item.skill!, version: 1 }];
          // Extraction requires a final source; this evaluates the current saved draft instead.
          const response = await app.inject({ method: 'POST', url: '/api/jobs/preview', payload: { ...input, ...(input.kind === 'extract' ? { source: 'draft' } : {}) } });
          assert.equal(response.statusCode < 300, item.accepted); if (item.accepted) assert.equal(response.json<{ preview: ContextPreview }>().preview.prompt.creativity.skills[0]!.id, item.skill);
        } else {
          if (item.scenario === 'voices') { profile.voices = [{ id: 'a', name: '甲', aliases: [], traits: 'SELECTED_VOICE', example: '' }, { id: 'b', name: '乙', aliases: [], traits: 'UNSELECTED_VOICE', example: '' }]; input.voiceIds = ['a']; }
          if (item.scenario === 'pending') profile.preferences = [{ id: 'p', title: '待确认', before: '', after: '', reason: 'PENDING_PREFERENCE', condition: '', counterExample: '', status: 'pending' }];
          if (item.scenario === 'disabled') { profile.disabledSkillIds = [builtinSkills[0]!.id]; input.skills = [{ id: builtinSkills[0]!.id, version: 1 }]; }
          if (item.scenario === 'secret') await api('POST', `/api/books/${book.id}/story`, { kind: 'rule', authority: 'setting', title: '作者秘密', content: 'SECRET_FUTURE_REVEAL', visibility: 'author', validFromChapter: 1 });
          if (item.scenario === 'resources') { const definition = { ...skillDefinition(builtinSkills[0]!), resources: [{ path: 'references/a.md', text: 'SELECTED_RESOURCE' }, { path: 'references/b.md', text: 'UNSELECTED_RESOURCE' }] };
            const { skill } = await api<{ skill: CreativeSkill }>('POST', `/api/books/${book.id}/skills`, { definition, expectedVersion: 0, enabled: true }); input.skills = [{ id: skill.id, version: 1, resourcePaths: ['references/a.md'] }]; }
          if (['voices', 'pending', 'disabled'].includes(item.scenario!)) profile = (await api<{ profile: CreativeProfile }>('PUT', `/api/books/${book.id}/creative`, { ...profile, expectedVersion: profile.version })).profile;
          const before = (await api<{ books: unknown[] }>('GET', '/api/backup')).books;
          const response = await app.inject({ method: 'POST', url: '/api/jobs/preview', payload: input });
          if (item.scenario === 'disabled') assert.equal(response.statusCode, 409);
          else {
            assert.equal(response.statusCode, 200); const { preview } = response.json<{ preview: ContextPreview }>(); const messages = JSON.stringify(preview.prompt.messages);
            if (item.scenario === 'voices') { assert(messages.includes('SELECTED_VOICE')); assert(!messages.includes('UNSELECTED_VOICE')); }
            if (item.scenario === 'pending') assert(!messages.includes('PENDING_PREFERENCE'));
            if (item.scenario === 'secret') assert(!messages.includes('SECRET_FUTURE_REVEAL'));
            if (item.scenario === 'resources') { assert(messages.includes('SELECTED_RESOURCE')); assert(!messages.includes('UNSELECTED_RESOURCE')); }
          }
          assert.deepEqual((await api<{ books: unknown[] }>('GET', '/api/backup')).books, before);
        }
      }
      results.push({ id: item.id, passed: true });
    } catch (error) { results.push({ id: item.id, passed: false, error: error instanceof Error ? error.message : 'Evaluation failed' }); }
  }
} finally { try { await app.close(); } finally { globalThis.fetch = originalFetch; } }
const report = { format: 'shujian-creative-offline-report', version: 1, passed: results.every((entry) => entry.passed) && forbiddenRequests === 0,
  modelRequests: forbiddenRequests, measuresLiteraryQuality: false, cases: results, total: results.length, scope: '技能适用、受限导入、材料隔离、只读预览与稿件清洁；不评价文笔。' };
await mkdir(resolve(destination, '..'), { recursive: true }); await writeFile(destination, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, total: report.total, failed: results.filter((entry) => !entry.passed), modelRequests: forbiddenRequests, report: destination }));
if (!report.passed) process.exitCode = 1;
