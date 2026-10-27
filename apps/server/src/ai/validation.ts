import type { ApplyAiJobInput, CreateAiJobInput, UpdateModelSettings } from '@shujian/contracts';
import * as v from '../validation.js';
import { parseSkillSelections, strings } from '../creative/validation.js';
import { selection as atlasSelection } from '../atlas/validation.js';

function decimal(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) v.invalid(`${label}超出允许范围。`);
  return value;
}
function money(value: unknown, label: string): number | null { return value === null || value === undefined ? null : decimal(value, label, 0, 1_000_000); }
function ids(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) v.invalid('资料选择格式不正确。');
  return [...new Set(value.map((entry) => v.string(entry, '资料 ID', 128, 1)))];
}
export function modelSettings(value: unknown): UpdateModelSettings {
  const item = v.object(value);
  let url: URL;
  try { url = new URL(v.string(item.baseUrl, '模型地址', 2000, 1)); } catch { return v.invalid('模型地址应为完整的 http 或 https 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) v.invalid('模型地址只支持不带账号、查询参数和片段的 http/https 地址。');
  if (typeof item.stream !== 'boolean') v.invalid('流式输出设置不正确。');
  if (item.clearApiKey !== undefined && typeof item.clearApiKey !== 'boolean') v.invalid('密钥清除设置不正确。');
  if(item.tokenParameter!==undefined&&!['max_tokens','max_completion_tokens'].includes(String(item.tokenParameter)))v.invalid('输出参数不正确。');
  for(const field of ['sendTemperature','includeStreamUsage'])if(item[field]!==undefined&&typeof item[field]!=='boolean')v.invalid('接口兼容设置不正确。');
  return {
    name:item.name===undefined?'自定义连接':v.string(item.name,'连接名称',120,1).trim(),
    tokenParameter:item.tokenParameter==='max_completion_tokens'?'max_completion_tokens':'max_tokens',
    sendTemperature:item.sendTemperature!==false,includeStreamUsage:item.includeStreamUsage!==false,
    baseUrl: url.href.replace(/\/+$/, ''), model: v.string(item.model, '模型名称', 200).trim(),
    stream: item.stream, temperature: decimal(item.temperature, '温度', 0, 2),
    maxOutputTokens: v.integer(item.maxOutputTokens, '输出额度', 32, 65536),
    contextWindow: v.integer(item.contextWindow, '上下文窗口', 512, 2_000_000),
    inputPricePerMillion: money(item.inputPricePerMillion, '输入单价'), outputPricePerMillion: money(item.outputPricePerMillion, '输出单价'),
    taskBudget: money(item.taskBudget, '任务预算'), dailyBudget: money(item.dailyBudget, '每日预算'),
    ...(item.apiKey === undefined ? {} : { apiKey: v.string(item.apiKey, 'API 密钥', 4000).trim() }),
    ...(item.clearApiKey === undefined ? {} : { clearApiKey: item.clearApiKey }),
  };
}
export function createJob(value: unknown): CreateAiJobInput {
  const item = v.object(value);
  const kind = v.string(item.kind, '任务类型', 20);
  if (!['discuss', 'plan', 'draft', 'revise', 'review', 'extract'].includes(kind)) v.invalid('任务类型不支持。');
  let selection: CreateAiJobInput['selection'];
  if (item.selection !== undefined) {
    const s = v.object(item.selection, '选区');
    selection = { from: v.integer(s.from, '选区起点', 0, 2_000_000), to: v.integer(s.to, '选区终点', 1, 2_000_000), text: v.string(s.text, '选区正文', 200_000, 1) };
    if (selection.to <= selection.from) v.invalid('请选中需要修改的文字。');
  }
  if (kind === 'revise' && !selection) v.invalid('局部改稿需要选区。');
  if(item.source!==undefined&&!['draft','final'].includes(String(item.source)))v.invalid('资料来源不正确。');
  return {
    requestId: v.string(item.requestId, '请求标识', 128, 1), kind: kind as CreateAiJobInput['kind'],
    chapterId: v.string(item.chapterId, '章节 ID', 128, 1), expectedVersion: v.integer(item.expectedVersion, '草稿版本', 1),
    instruction: v.string(item.instruction, '创作要求', 20_000, 1),
    ...(item.source===undefined?{}:{source:item.source as 'draft'|'final'}),
    ...(selection ? { selection } : {}),
    ...(item.pov === undefined ? {} : { pov: v.string(item.pov, '视角人物', 200) }),
    ...(item.pinnedEntryIds === undefined ? {} : { pinnedEntryIds: ids(item.pinnedEntryIds) }),
    ...(item.excludedEntryIds === undefined ? {} : { excludedEntryIds: ids(item.excludedEntryIds) }),
    ...(item.skills === undefined ? {} : { skills: parseSkillSelections(item.skills) }),
    ...(item.voiceIds === undefined ? {} : { voiceIds: strings(item.voiceIds, '人物声音', 8) }),
    ...(item.previewFingerprint === undefined ? {} : { previewFingerprint: v.string(item.previewFingerprint, '材料预览指纹', 64, 64) }),
    ...(item.atlas===undefined?{}:{atlas:atlasSelection(item.atlas)}),
  };
}
export function applyJob(value: unknown): ApplyAiJobInput {
  const item = v.object(value);
  if (item.target !== 'document' && item.target !== 'outline') v.invalid('采纳位置不正确。');
  return { expectedVersion: v.integer(item.expectedVersion, '草稿版本', 1), target: item.target, ...(item.text === undefined ? {} : { text: v.string(item.text, '候选稿', 1_000_000, 1) }) };
}
