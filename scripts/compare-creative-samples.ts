/** Offline comparison preparation from portable API exports. No database, key or provider. */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AiTaskKind, ContextItem, CreativeEvaluationSample, ModelCall, ModelSettings } from '../packages/contracts/src/index.js';
import { parsePromptMessages, parsePromptSnapshot, taskKinds } from '../apps/server/src/creative/validation.js';
import { cleanManuscript } from '../apps/server/src/creative/clean.js';
import { creativeHash } from '../apps/server/src/creative/definitions.js';
import * as v from '../apps/server/src/validation.js';

const arg = (key: string): string | undefined => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1]; };
const source = arg('--sample'); const baseline = arg('--baseline'); const output = arg('--out');
const root = resolve(import.meta.dirname, '..');
if (!source || !output) throw new Error('离线用法：pnpm compare:creative --sample 样本.json [--baseline 对照样本.json] --out 新目录。请先从创作记录导出冻结评测样本；本工具不读数据库、不调用模型。');
const array = (value: unknown, label: string, maximum: number): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) v.invalid(`${label}格式不正确或数量过多。`);
  return value;
};
const number = (value: unknown, label: string, minimum: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) v.invalid(`${label}不正确。`);
  return value;
};
const boolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') v.invalid(`${label}不正确。`);
  return value;
};
const nullableNumber = (value: unknown, label: string) => value === null ? null : number(value, label, 0, Number.MAX_SAFE_INTEGER);
const statusValues = ['queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'];
const sourceValues = ['instruction', 'chapter', 'outline', 'premise', 'canon', 'history', 'conversation', 'skill', 'style'];

function parseParameters(value: unknown): CreativeEvaluationSample['parameters'] {
  if (value === null || value === undefined) return null;
  const p = v.object(value, '模型参数');
  const allowed = ['id', 'name', 'baseUrl', 'model', 'stream', 'temperature', 'maxOutputTokens', 'contextWindow', 'inputPricePerMillion', 'outputPricePerMillion', 'taskBudget', 'dailyBudget', 'tokenParameter', 'sendTemperature', 'includeStreamUsage'];
  if (Object.keys(p).some((key) => !allowed.includes(key))) v.invalid('样本模型参数包含不支持或敏感字段，请重新导出。');
  const baseUrl = v.string(p.baseUrl, '平台地址', 2000, 1); let url: URL;
  try { url = new URL(baseUrl); } catch { return v.invalid('样本平台地址不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) v.invalid('样本平台地址不得包含账号、密码或查询参数。');
  if (p.tokenParameter !== undefined && !['max_tokens', 'max_completion_tokens'].includes(String(p.tokenParameter))) v.invalid('样本输出参数不支持。');
  return { id: v.string(p.id, '连接 ID', 128, 1), baseUrl, model: v.string(p.model, '模型', 200, 1), stream: boolean(p.stream, '流式设置'),
    temperature: number(p.temperature, '温度', 0, 2), maxOutputTokens: v.integer(p.maxOutputTokens, '输出额度', 32, 65536), contextWindow: v.integer(p.contextWindow, '上下文窗口', 512, 2_000_000),
    inputPricePerMillion: nullableNumber(p.inputPricePerMillion, '输入单价'), outputPricePerMillion: nullableNumber(p.outputPricePerMillion, '输出单价'),
    taskBudget: nullableNumber(p.taskBudget, '任务预算'), dailyBudget: nullableNumber(p.dailyBudget, '日预算'),
    ...(p.name === undefined ? {} : { name: v.string(p.name, '连接名', 120) }),
    ...(p.tokenParameter === undefined ? {} : { tokenParameter: p.tokenParameter as ModelSettings['tokenParameter'] }),
    ...(p.sendTemperature === undefined ? {} : { sendTemperature: boolean(p.sendTemperature, '温度兼容设置') }),
    ...(p.includeStreamUsage === undefined ? {} : { includeStreamUsage: boolean(p.includeStreamUsage, '用量兼容设置') }) };
}
async function sample(path: string): Promise<CreativeEvaluationSample> {
  const file = resolve(root, path);
  if ((await stat(file)).size > 64 * 1024 * 1024) throw new Error('评测样本超过 64 MB，请缩小场景后重新导出。');
  const raw = v.object(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')), '评测样本');
  if (raw.format !== 'shujian-creative-evaluation' || raw.version !== 1) v.invalid('样本版本不支持，请从书间重新导出。');
  const kind = v.string(raw.task, '任务', 20) as AiTaskKind;
  if (!taskKinds.includes(kind) || !statusValues.includes(String(raw.status))) v.invalid('样本任务或状态不正确。');
  const input = v.object(raw.input, '任务输入');
  if (input.kind !== kind) v.invalid('样本任务与输入不一致。');
  v.string(input.chapterId, '输入章节', 128, 1); v.integer(input.expectedVersion, '输入版本', 1);
  v.string(input.instruction, '作者要求', 20000, 1);
  const context: ContextItem[] = array(raw.context, '冻结材料', 100000).map((value) => {
    const entry = v.object(value, '材料'); if (!sourceValues.includes(String(entry.source))) v.invalid('样本材料来源不支持。');
    const item: ContextItem = { id: v.string(entry.id, '材料 ID', 500, 1), label: v.string(entry.label, '材料标题', 500),
      source: entry.source as ContextItem['source'], text: v.string(entry.text, '材料正文', 2_000_000), required: boolean(entry.required, '必需材料标记') };
    for (const key of ['chapterId', 'revisionId', 'entryId'] as const) if (entry[key] !== undefined) item[key] = v.string(entry[key], '材料引用', 128, 1);
    return item;
  });
  const sourceJobId = v.string(raw.sourceJobId, '来源任务', 128, 1);
  const prompt = raw.prompt == null ? null : parsePromptSnapshot(raw.prompt);
  if (prompt) {
    const rendered = context.map((entry) => `【${entry.label}】\n${entry.text}`).join('\n\n');
    if (prompt.messages.length !== 2 || prompt.messages[0]?.role !== 'system' || prompt.messages[1]?.role !== 'user' || prompt.messages[1].content !== rendered) v.invalid('样本材料与冻结的实际提示不一致，请重新导出。');
  }
  const model = v.string(raw.model, '模型名', 200, 1);
  const calls: ModelCall[] = array(raw.calls ?? [], '调用记录', 100).map((value) => {
    const c = v.object(value, '调用');
    if (c.jobId !== sourceJobId || !statusValues.slice(1).includes(String(c.status)) || c.model !== model) v.invalid('样本调用关联或状态不正确。');
    const call: ModelCall = { id: v.string(c.id, '调用 ID', 128, 1), jobId: sourceJobId, attempt: v.integer(c.attempt, '调用序号', 1, 100), model,
      status: c.status as ModelCall['status'], inputTokens: c.inputTokens === null ? null : v.integer(c.inputTokens, '输入用量', 0),
      outputTokens: c.outputTokens === null ? null : v.integer(c.outputTokens, '输出用量', 0), estimatedCost: nullableNumber(c.estimatedCost, '调用费用'),
      error: c.error === null ? null : v.string(c.error, '调用错误', 5000), createdAt: v.string(c.createdAt, '调用时间', 40, 1), updatedAt: v.string(c.updatedAt, '调用时间', 40, 1),
      ...(c.output === undefined ? {} : { output: v.string(c.output, '调用输出', 1_000_000) }) };
    if (c.requestMessages !== undefined) {
      call.requestMessages = parsePromptMessages(c.requestMessages); call.promptHash = v.string(c.promptHash, '调用提示哈希', 64, 64);
      if (creativeHash(call.requestMessages) !== call.promptHash) v.invalid('样本调用提示与哈希不一致。');
    } else if (c.promptHash !== undefined) v.invalid('样本调用缺少对应提示。');
    return call;
  });
  if (new Set(calls.map((entry) => entry.id)).size !== calls.length) v.invalid('样本调用 ID 重复。');
  const parameters = parseParameters(raw.parameters);
  if (parameters && parameters.model !== model) v.invalid('模型参数与任务模型不一致。');
  if (prompt && calls[0]?.requestMessages && creativeHash(calls[0].requestMessages) !== creativeHash(prompt.messages)) v.invalid('首个调用与初次提示快照不一致。');
  const output = v.string(raw.output, '模型输出', 1_000_000);
  const last = calls.at(-1);
  if (raw.status === 'succeeded' && last && (last.status !== 'succeeded' || (last.output !== undefined && last.output !== output))) v.invalid('样本完成状态或输出与最后调用不一致。');
  return { format: 'shujian-creative-evaluation', version: 1, exportedAt: v.string(raw.exportedAt, '导出时间', 40, 1),
    sourceJobId, task: kind, input: input as unknown as CreativeEvaluationSample['input'], prompt, context, output, model,
    inputVersion: v.integer(raw.inputVersion, '正文版本', 1), parameters, status: raw.status as CreativeEvaluationSample['status'], calls };
}
const a = await sample(source); const b = baseline ? await sample(baseline) : null;
const directory = resolve(root, output); if (existsSync(directory)) throw new Error('输出目录已存在，请使用新目录以保留原始评测和身份对应。');
const relevant = (item: CreativeEvaluationSample) => item.context.filter((entry) => entry.source !== 'skill').map((entry) => ({ label: entry.label, source: entry.source, text: entry.text, required: entry.required }));
const parameters = (item: CreativeEvaluationSample) => { if (!item.parameters) return null; const p = item.parameters; return { baseUrl: p.baseUrl, model: p.model, stream: p.stream, temperature: p.temperature, maxOutputTokens: p.maxOutputTokens, contextWindow: p.contextWindow, tokenParameter: p.tokenParameter, sendTemperature: p.sendTemperature, includeStreamUsage: p.includeStreamUsage }; };
if (b && (a.status !== 'succeeded' || b.status !== 'succeeded' || !a.output.trim() || !b.output.trim())) throw new Error('匿名比较需要两份已完成、非空的实际模型输出。');
if (b && (!a.prompt || !b.prompt || !a.calls.length || !b.calls.length || [...a.calls, ...b.calls].some((call) => !call.requestMessages) || a.sourceJobId === b.sourceJobId)) throw new Error('同条件比较需要两个独立任务的完整提示和实际调用快照。旧任务仍可单独导出分析。');
if (b && a.prompt?.messages[0]?.content !== b.prompt?.messages[0]?.content) throw new Error('两份样本的系统任务规则不同，不能标记为仅比较 Skill 的同条件对照。');
if (b && (a.task !== b.task || a.inputVersion !== b.inputVersion || a.model !== b.model || !parameters(a) || !parameters(b) || creativeHash(parameters(a)) !== creativeHash(parameters(b)) || creativeHash(relevant(a)) !== creativeHash(relevant(b)))) throw new Error('两份样本的任务、模型参数或非技能材料不同，不能标记为同条件 Skill 对照。请先核对来源。');
await mkdir(resolve(directory, '..'), { recursive: true });
await mkdir(directory); // Exclusive final directory creation also closes a concurrent overwrite race.
const report = { format: 'shujian-creative-sample-report', version: 1, modelRequests: 0, measuresLiteraryQuality: false,
  samples: [a, ...(b ? [b] : [])].map((entry) => ({ sourceJobId: entry.sourceJobId, model: entry.model, task: entry.task, promptHash: entry.prompt?.hash ?? null,
    skillVersions: entry.prompt?.creativity.skills.map((skill) => ({ title: skill.definition.title, version: skill.version, hash: skill.hash })) ?? [],
    inputCharacters: entry.context.reduce((sum, value) => sum + value.text.length, 0), outputCharacters: entry.output.length,
    sampleHash: creativeHash(entry), calls: entry.calls.map((call) => ({ attempt: call.attempt, status: call.status, promptHash: call.promptHash ?? null, estimatedCost: call.estimatedCost })),
    cleanFindings: cleanManuscript(entry.output) })) };
await writeFile(join(directory, 'evaluation.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
if (b) await writeFile(join(directory, 'comparison.json'), JSON.stringify({ format: 'shujian-quality-comparison', version: 1, status: 'succeeded', createdAt: new Date().toISOString(), model: a.model,
  method: '实际模型输出的同条件 Skill 比较；本工具仅离线整理，不调用模型，不自动给出文学质量结论。',
  sharedBrief: relevant(a).map((entry) => `【${entry.label}】\n${entry.text}`).join('\n\n'),
  parameters: parameters(a),
  samples: [a, b].map((entry) => ({ source: `${entry.sourceJobId} · ${entry.prompt?.creativity.skills.map((skill) => `${skill.definition.title} V${skill.version}`).join('、') || '基础任务'}`, text: entry.output })) }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ directory, samples: b ? 2 : 1, modelRequests: 0, anonymousReviewReady: !!b }));
