import { createHash } from 'node:crypto';
import type { SaveStoryEntryInput, StoryEvidence, StoryEntryKind, StoryAuthority, StoryVisibility } from '@shujian/contracts';
import * as v from '../validation.js';
import { attributes, links } from '../atlas/card-validation.js';

export const evidenceHash = (quote: string): string => createHash('sha256').update(quote, 'utf8').digest('hex');
export const kinds: readonly StoryEntryKind[] = ['character', 'rule', 'event', 'item', 'foreshadow', 'plan', 'location', 'organization', 'scene', 'note'];
const authorities: readonly StoryAuthority[] = ['setting', 'fact', 'plan'];
const visibilities: readonly StoryVisibility[] = ['public', 'author', 'characters'];

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) v.invalid(`${label}不正确。`);
  return value as T;
}

export function list(value: unknown, label: string, maximum = 100): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) v.invalid(`${label}应为不超过 ${maximum} 项的列表。`);
  return value;
}

export function names(value: unknown, label: string): string[] {
  return [...new Set(list(value ?? [], label, 50).map((item) => v.string(item, label, 120, 1).trim()))];
}

export function evidence(value: unknown): StoryEvidence[] {
  return list(value ?? [], '原文证据', 30).map((item) => {
    const row = v.object(item, '原文证据');
    const quote = v.string(row.quote, '证据摘录', 5_000, 1);
    const hash = row.hash === undefined || row.hash === '' ? evidenceHash(quote) : v.string(row.hash, '证据 hash', 64, 64);
    if (hash !== evidenceHash(quote)) v.invalid('证据摘录和 hash 不一致。');
    return {
      chapterId: v.string(row.chapterId, '证据章节', 128, 1),
      revisionId: v.string(row.revisionId, '证据版本', 128, 1),
      paragraphId: v.string(row.paragraphId, '段落 ID', 128, 1), quote, hash,
    };
  });
}

export function storyInput(value: unknown): SaveStoryEntryInput {
  const row = v.object(value, '故事资料');
  const kind = oneOf(row.kind, kinds, '资料类型');
  const authority = oneOf(row.authority, authorities, '资料依据');
  if ((kind==='plan'&&authority!=='plan')||(authority==='plan'&&!['plan','scene','note'].includes(kind))) v.invalid('未来规划必须使用计划、场景或便签类型与计划依据。');
  const knownBy = names(row.knownBy, '知情人物');
  const visibility = oneOf(row.visibility ?? 'public', visibilities, '可见范围');
  if (visibility === 'characters' && knownBy.length === 0) v.invalid('限定人物知情时，请填写至少一位知情人物。');
  const sources = evidence(row.evidence);
  if (authority === 'fact' && sources.length === 0) v.invalid('正文事实必须提供已定稿原文的证据。');
  return {
    kind, authority, title: v.string(row.title, '资料标题', 200, 1).trim(),
    content: v.string(row.content, '资料内容', 20_000, 1), aliases: names(row.aliases, '别名'), visibility, knownBy,
    storyTime: v.string(row.storyTime ?? '', '故事时间', 300),
    narrative: oneOf(row.narrative ?? 'unknown', ['normal', 'flashback', 'unknown'] as const, '叙述类型'),
    validFromChapter: v.integer(row.validFromChapter ?? 1, '生效章节', 1, 1_000_000),
    plannedPayoff: row.plannedPayoff === undefined || row.plannedPayoff === null ? null : v.integer(row.plannedPayoff, '计划回收章节', 1, 1_000_000),
    evidence: sources,
    ...(row.status===undefined?{}:{status:oneOf(row.status,['idea','confirmed','withdrawn'] as const,'卡片状态')}),
    ...(row.attributes===undefined?{}:{attributes:attributes(row.attributes)}),
    ...(row.links===undefined?{}:{links:links(row.links)}),
    ...(row.branch===undefined?{}:{branch:v.string(row.branch,'构思方案',80,1)}),
    ...(row.expectedVersion === undefined ? {} : { expectedVersion: v.integer(row.expectedVersion, '资料版本', 1) }),
  };
}

export function parseModelJson(output: string): Record<string, unknown> {
  let text = output.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1] ?? '';
  try { return v.object(JSON.parse(text) as unknown, '模型结果'); }
  catch { v.invalid('模型结果不是约定的 JSON，原始输出已保留。请重试整理或手工录入。'); }
}
