import type { AiTaskKind, CharacterVoice, CreativeContextNeed, CreativeProfile, CreativeSnapshot, PreferenceExample, PromptSnapshot, SaveCreativeProfile, SkillDefinition, SkillResource, SkillSelection, SkillSnapshot } from '@shujian/contracts';
import * as v from '../validation.js';
import { creativeHash } from './definitions.js';

export const taskKinds: AiTaskKind[] = ['discuss', 'plan', 'draft', 'revise', 'review', 'extract'];
const needs: CreativeContextNeed[] = ['current', 'outline', 'story', 'style', 'voices'];
export function list(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) v.invalid(`${label}数量或格式不正确。`);
  return value;
}
export const strings = (value: unknown, label: string, max = 100): string[] => [...new Set(list(value, label, max).map((item) => v.string(item, label, 128, 1)))];
function resource(value: unknown): SkillResource {
  const row = v.object(value, '技能资料'); const path = v.string(row.path, '资料路径', 160, 1);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.(?:md|txt)$/i.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) v.invalid('技能只支持包内相对路径的 Markdown 或文本资料。');
  return { path, text: v.string(row.text, '技能资料正文', 12000, 1) };
}
export function parseSkillDefinition(value: unknown): SkillDefinition {
  const row = v.object(value, '创作技能');
  const allowed = ['name', 'title', 'description', 'tasks', 'instructions', 'contextNeeds', 'resources', 'license', 'source'];
  if (Object.keys(row).some((key) => !allowed.includes(key))) v.invalid('技能包含不支持的字段；当前只支持声明式方法和文本资料，不执行脚本或工具。');
  const name = v.string(row.name, '技能名称', 64, 1);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) v.invalid('技能名称应使用小写字母、数字和连字符。');
  const tasks = strings(row.tasks, '适用任务', 6) as AiTaskKind[];
  if (!tasks.length || tasks.some((task) => !taskKinds.includes(task))) v.invalid('请选择支持的任务类型。');
  const contextNeeds = strings(row.contextNeeds ?? ['current'], '材料类别', 5) as CreativeContextNeed[];
  if (contextNeeds.some((need) => !needs.includes(need))) v.invalid('材料类别不支持。');
  const resources = list(row.resources ?? [], '技能资料', 8).map(resource);
  if (new Set(resources.map((entry) => entry.path)).size !== resources.length) v.invalid('技能资料路径重复。');
  const result = { name, title: v.string(row.title, '技能标题', 100, 1), description: v.string(row.description, '适用说明', 1024, 1), tasks,
    instructions: v.string(row.instructions, '方法正文', 20000, 1), contextNeeds, resources,
    license: v.string(row.license ?? '', '许可', 1000), source: v.string(row.source ?? '', '来源', 2000) };
  if (JSON.stringify(result).length > 80000) v.invalid('技能包过大，请减少参考资料。');
  // Links never trigger reads or network requests. Missing local resources fail at import.
  for (const match of result.instructions.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]!;
    if (!target.startsWith('#') && !/^https?:\/\//i.test(target) && !resources.some((entry) => entry.path === target)) v.invalid('技能引用了未包含的资料。请将参考文件作为文本资源一同导入。');
  }
  return result;
}

/** A deliberately limited frontmatter reader: no YAML tags, evaluation, tools or filesystem access. */
export function importSkill(value: unknown): SkillDefinition {
  const row = v.object(value, '导入技能');
  if (Object.keys(row).some((key) => !['format', 'version', 'definition', 'markdown', 'title', 'tasks', 'contextNeeds', 'resources', 'source'].includes(key))) v.invalid('技能包包含不支持的字段。');
  if (row.format !== undefined && (row.format !== 'shujian-skill' || row.version !== 1)) v.invalid('技能包版本或格式不支持。');
  if (row.definition !== undefined) return parseSkillDefinition(row.definition);
  const markdown = v.string(row.markdown, 'SKILL.md', 30000, 1).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(markdown);
  if (!match) v.invalid('请导入包含 YAML 名称和描述的 SKILL.md，或书间技能 JSON 包。');
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  const lines = match[1]!.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim() || line.startsWith('#') || /^\s/.test(line)) continue;
    const field = /^([a-zA-Z][a-zA-Z0-9-]*):\s*(.*)$/.exec(line);
    if (!field || ['scripts', 'tools'].includes(field[1]!)) v.invalid('技能元数据不支持，请改用书间声明式 JSON 格式。');
    let content = field[2]!.trim();
    if (/^[>|][+-]?$/.test(content)) {
      const parts: string[] = [];
      while (index + 1 < lines.length && /^\s/.test(lines[index + 1]!)) parts.push(lines[++index]!.trim());
      content = parts.join(' ');
    }
    if (/^[&*!]/.test(content)) v.invalid('不支持可执行或引用型 YAML 元数据。');
    fields[field[1]!] = content.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  if (fields['allowed-tools']) v.invalid('当前技能导入不授予工具权限，请移除 allowed-tools 后导入纯创作方法。');
  return parseSkillDefinition({ name: fields.name, title: row.title ?? fields.name, description: fields.description,
    tasks: row.tasks ?? ['discuss', 'plan', 'draft', 'revise', 'review'], instructions: match[2],
    contextNeeds: row.contextNeeds ?? ['current'], resources: row.resources ?? [], license: fields.license ?? '', source: row.source ?? '' });
}

export function parseSkillSelections(value: unknown): SkillSelection[] {
  return list(value, '本次技能', 3).map((item) => {
    const row = v.object(item, '技能选择');
    return { id: v.string(row.id, '技能 ID', 128, 1), version: v.integer(row.version, '技能版本', 1),
      ...(row.focus === undefined ? {} : { focus: v.string(row.focus, '技能补充要求', 2000) }),
      ...(row.resourcePaths === undefined ? {} : { resourcePaths: [...new Set(list(row.resourcePaths, '参考文件', 8).map((path) => v.string(path, '参考文件', 160, 1)))] }) };
  });
}
export function parseProfile(value: unknown): SaveCreativeProfile {
  const row = v.object(value, '创作档案'); const style = v.object(row.style, '文风');
  const voices: CharacterVoice[] = list(row.voices, '人物声音', 40).map((value) => {
    const item = v.object(value, '人物声音'); return { id: v.string(item.id, '声音 ID', 128, 1), name: v.string(item.name, '人物名称', 100, 1),
      aliases: strings(item.aliases ?? [], '人物别名', 20), traits: v.string(item.traits, '声音特点', 3000), example: v.string(item.example, '对白示例', 4000) };
  });
  const preferences: PreferenceExample[] = list(row.preferences, '偏好案例', 100).map((value) => {
    const item = v.object(value, '偏好案例');
    if (!['pending', 'confirmed', 'withdrawn'].includes(String(item.status))) v.invalid('偏好确认状态不正确。');
    if(item.status==='confirmed'&&!v.string(item.reason,'修改理由',2000).trim())v.invalid('确认偏好前，请说明修改理由及适用情况。');
    return { id: v.string(item.id, '偏好 ID', 128, 1), title: v.string(item.title, '案例标题', 100, 1), before: v.string(item.before, '修改前', 6000),
      after: v.string(item.after, '作者改稿', 6000), reason: v.string(item.reason, '修改理由', 2000), condition: v.string(item.condition, '适用条件', 2000),
      counterExample: v.string(item.counterExample, '例外', 2000), status: item.status as PreferenceExample['status'],
      ...(item.sourceJobId === undefined ? {} : { sourceJobId: v.string(item.sourceJobId, '来源任务', 128, 1) }),
      ...(item.sourceChapterId === undefined ? {} : { sourceChapterId: v.string(item.sourceChapterId, '来源章节', 128, 1) }) };
  });
  if (new Set([...voices, ...preferences].map((entry) => entry.id)).size !== voices.length + preferences.length) v.invalid('档案条目 ID 重复。');
  const defaults = v.object(row.defaultSkillIds ?? {}, '常用技能'); const defaultSkillIds: SaveCreativeProfile['defaultSkillIds'] = {};
  for (const [key, ids] of Object.entries(defaults)) {
    if (!taskKinds.includes(key as AiTaskKind)) v.invalid('常用技能任务不支持。');
    defaultSkillIds[key as AiTaskKind] = strings(ids, '常用技能', 3);
  }
  const result: SaveCreativeProfile = { expectedVersion: v.integer(row.expectedVersion, '档案版本', 0),
    style: { narration: v.string(style.narration, '叙述方式', 3000), tone: v.string(style.tone, '语气', 3000), pacing: v.string(style.pacing, '节奏', 3000),
      avoid: v.string(style.avoid, '避免表达', 3000), example: v.string(style.example, '作者范例', 8000) }, voices, preferences,
    disabledSkillIds: strings(row.disabledSkillIds ?? [], '停用技能', 200), defaultSkillIds };
  if (JSON.stringify(result).length > 1_000_000) v.invalid('创作档案过大，请减少示例。');
  return result;
}

export function parsePromptMessages(value: unknown): PromptSnapshot['messages'] {
  return list(value, '实际提示', 20).map((value) => {
    const message = v.object(value, '提示消息');
    if (!['system', 'user', 'assistant'].includes(String(message.role))) v.invalid('提示角色不正确。');
    return { role: message.role as PromptSnapshot['messages'][number]['role'], content: v.string(message.content, '提示正文', 4_000_000) };
  });
}
export function parsePromptSnapshot(value: unknown): PromptSnapshot {
  const row = v.object(value, '提示快照'); if (row.schema !== 1) v.invalid('提示快照版本不支持。');
  const messages = parsePromptMessages(row.messages);
  const raw = v.object(row.creativity, '技能快照');
  const skills: SkillSnapshot[] = list(raw.skills, '冻结技能', 3).map((value) => {
    const item = v.object(value, '冻结技能'); const definition = parseSkillDefinition(item.definition);
    const hash = v.string(item.hash, '技能哈希', 64, 64); if (hash !== creativeHash(definition)) v.invalid('技能快照内容与哈希不一致。');
    const resources = list(item.resources, '冻结参考资料', 8).map(resource);
    if (resources.some((entry) => !definition.resources.some((source) => source.path === entry.path && source.text === entry.text))) v.invalid('技能快照参考资料不一致。');
    return { id: v.string(item.id, '技能 ID', 128, 1), version: v.integer(item.version, '技能版本', 1), hash, definition,
      focus: v.string(item.focus, '技能要求', 2000), resources };
  });
  const creativity: CreativeSnapshot = { skills, profileVersion: v.integer(raw.profileVersion, '档案版本', 0), profileHash: v.string(raw.profileHash, '档案哈希', 64, 64),
    voiceIds: strings(raw.voiceIds, '声音引用', 8), preferenceIds: strings(raw.preferenceIds, '偏好引用', 100) };
  const hash = v.string(row.hash, '提示哈希', 64, 64);
  if (hash !== creativeHash({ messages, creativity })) v.invalid('提示快照内容与哈希不一致。');
  return { schema: 1, hash, messages, creativity };
}

export function profileFromBackup(value: unknown, bookId: string): CreativeProfile {
  const row = v.object(value, '档案备份');
  if (row.bookId !== bookId) v.invalid('档案不属于备份作品。');
  const data = parseProfile({ ...row, expectedVersion: row.version });
  const { expectedVersion: version, ...rest } = data;
  return { ...rest, bookId, version, updatedAt: v.string(row.updatedAt, '档案时间', 40) };
}
