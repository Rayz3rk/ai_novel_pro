import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Chapter, ContextItem, CreateAiJobInput, CreativeProfile, CreativeSkill, CreativeSnapshot, JsonValue, SkillDefinition, SkillSelection, SkillSnapshot } from '@shujian/contracts';
import { AppError, notFound } from '../errors.js';
import type { Store } from '../store.js';
import * as v from '../validation.js';
import { builtinSkills, creativeHash, skillDefinition } from './definitions.js';
import { importSkill, list, parseProfile, parseSkillDefinition, profileFromBackup } from './validation.js';
import { cleanManuscript } from './clean.js';

const now = () => new Date().toISOString();
export function emptyCreativeProfile(bookId: string): CreativeProfile {
  return { bookId, version: 0, style: { narration: '', tone: '', pacing: '', avoid: '', example: '' }, voices: [], preferences: [], disabledSkillIds: [], defaultSkillIds: {}, updatedAt: '' };
}
type SkillRow = { payload: string };

export class CreativeService {
  beforeProfileSave?: (bookId:string,profile:CreativeProfile)=>void;
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS creative_skills(id TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES books(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creative_skill_history(id TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES books(id),skill_id TEXT NOT NULL REFERENCES creative_skills(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creative_profiles(book_id TEXT PRIMARY KEY REFERENCES books(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creative_profile_history(id TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES books(id),payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS creative_skill_book ON creative_skills(book_id);
      CREATE INDEX IF NOT EXISTS creative_skill_history_book ON creative_skill_history(book_id);
      CREATE INDEX IF NOT EXISTS creative_profile_history_book ON creative_profile_history(book_id);`);
  }
  profile(bookId: string): CreativeProfile {
    this.store.getBook(bookId);
    const row = this.store.db.prepare('SELECT payload FROM creative_profiles WHERE book_id=?').get(bookId) as SkillRow | undefined;
    return row ? JSON.parse(row.payload) as CreativeProfile : emptyCreativeProfile(bookId);
  }
  skills(bookId: string): CreativeSkill[] {
    const profile = this.profile(bookId);
    const custom = (this.store.db.prepare('SELECT payload FROM creative_skills WHERE book_id=? ORDER BY rowid').all(bookId) as SkillRow[]).map((row) => JSON.parse(row.payload) as CreativeSkill);
    return [...builtinSkills.map((skill) => ({ ...skill, enabled: !profile.disabledSkillIds.includes(skill.id) })), ...custom];
  }
  skill(bookId: string, id: string): CreativeSkill { return this.skills(bookId).find((entry) => entry.id === id) ?? notFound('创作技能'); }
  saveSkill(bookId: string, value: unknown, id?: string): CreativeSkill {
    const raw = v.object(value); const definition = parseSkillDefinition(raw.definition);
    if (typeof raw.enabled !== 'boolean') v.invalid('技能启停设置不正确。');
    const expected = v.integer(raw.expectedVersion, '技能版本', 0);
    return this.store.db.transaction(() => {
      this.store.getBook(bookId); const prior = id ? this.skill(bookId, id) : null;
      if (prior?.builtin) throw new AppError(409, 'BUILTIN_READ_ONLY', '内置方法保留原版，请另存为自己的技能。');
      if ((prior?.version ?? 0) !== expected) throw new AppError(409, 'VERSION_CONFLICT', '技能已更新，请重新载入后保存。', prior?.version ?? 0);
      if(prior && Object.entries(this.profile(bookId).defaultSkillIds).some(([kind,entries])=>entries?.includes(prior.id)&&(!raw.enabled||!definition.tasks.includes(kind as CreateAiJobInput['kind'])))) throw new AppError(409,'SKILL_IN_USE','请先从相关任务的常用方法中移除此技能并保存档案，再停用或调整适用任务。');
      if (!prior && this.skills(bookId).filter((entry) => !entry.builtin).length >= 100) v.invalid('本作品的自定义技能已达到 100 个。');
      const time = now(); const skill: CreativeSkill = { ...definition, id: prior?.id ?? randomUUID(), bookId, version: expected + 1,
        hash: creativeHash(definition), builtin: false, enabled: raw.enabled as boolean, createdAt: prior?.createdAt ?? time, updatedAt: time };
      this.putSkill(skill);
      this.store.db.prepare('INSERT INTO creative_skill_history(id,book_id,skill_id,payload) VALUES(?,?,?,?)').run(randomUUID(), bookId, skill.id, JSON.stringify(skill));
      return skill;
    })();
  }
  private putSkill(skill: CreativeSkill): void {
    this.store.db.prepare('INSERT INTO creative_skills(id,book_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(skill.id, skill.bookId, JSON.stringify(skill));
  }
  skillHistory(bookId: string, id: string): CreativeSkill[] {
    const skill = this.skill(bookId, id); if (skill.builtin) return [skill];
    return (this.store.db.prepare('SELECT payload FROM creative_skill_history WHERE book_id=? AND skill_id=? ORDER BY rowid DESC').all(bookId, id) as SkillRow[]).map((row) => JSON.parse(row.payload) as CreativeSkill);
  }
  private validateProfileRelations(bookId:string,profile:Pick<CreativeProfile,'disabledSkillIds'|'defaultSkillIds'|'preferences'>,checkDefaults=true):void {
    const skills=this.skills(bookId);
    for(const id of profile.disabledSkillIds)if(!builtinSkills.some((skill)=>skill.id===id))v.invalid('停用的内置技能不存在。');
    for(const [kind,ids] of Object.entries(profile.defaultSkillIds))for(const id of ids!){
      const skill=skills.find((entry)=>entry.id===id);
      const enabled=skill?.builtin?!profile.disabledSkillIds.includes(id):skill?.enabled;
      if(!skill||(checkDefaults&&(!enabled||!skill.tasks.includes(kind as CreateAiJobInput['kind']))))v.invalid('常用技能不存在、已停用或不适合该任务。');
    }
    for(const preference of profile.preferences){
      if(preference.sourceChapterId&&this.store.getChapter(preference.sourceChapterId).bookId!==bookId)v.invalid('偏好来源章节不属于本作品。');
      if(preference.sourceJobId){const job=this.store.db.prepare('SELECT book_id,chapter_id FROM ai_jobs WHERE id=?').get(preference.sourceJobId) as {book_id:string;chapter_id:string}|undefined;
        if(!job||job.book_id!==bookId||(preference.sourceChapterId&&job.chapter_id!==preference.sourceChapterId))v.invalid('偏好来源任务不属于本作品或章节。');}
    }
  }
  saveProfile(bookId: string, value: unknown): CreativeProfile {
    const input = parseProfile(value);
    return this.store.db.transaction(() => {
      const previous = this.profile(bookId);
      if (previous.version !== input.expectedVersion) throw new AppError(409, 'VERSION_CONFLICT', '创作档案已更新，请保留填写内容并重新载入。', previous.version);
      this.validateProfileRelations(bookId,input);
      const { expectedVersion, ...rest } = input;
      const profile: CreativeProfile = { ...rest, bookId, version: expectedVersion + 1, updatedAt: now() };
      this.beforeProfileSave?.(bookId,profile);
      this.putProfile(profile);
      this.store.db.prepare('INSERT INTO creative_profile_history(id,book_id,payload) VALUES(?,?,?)').run(randomUUID(), bookId, JSON.stringify(profile));
      return profile;
    })();
  }
  private putProfile(profile: CreativeProfile): void {
    this.store.db.prepare('INSERT INTO creative_profiles(book_id,payload) VALUES(?,?) ON CONFLICT(book_id) DO UPDATE SET payload=excluded.payload').run(profile.bookId, JSON.stringify(profile));
  }
  profileHistory(bookId: string): CreativeProfile[] {
    this.store.getBook(bookId);
    return (this.store.db.prepare('SELECT payload FROM creative_profile_history WHERE book_id=? ORDER BY rowid DESC').all(bookId) as SkillRow[]).map((row) => JSON.parse(row.payload) as CreativeProfile);
  }
  materialize(input: CreateAiJobInput, chapter: Chapter, replay?: SkillSnapshot[]): { items: ContextItem[]; snapshot: CreativeSnapshot } {
    const profile = this.profile(chapter.bookId); const available = this.skills(chapter.bookId);
    const selections: SkillSelection[] = input.skills ?? (profile.defaultSkillIds[input.kind] ?? []).map((id) => ({ id, version: this.skill(chapter.bookId, id).version }));
    if (selections.length > 3 || new Set(selections.map((entry) => entry.id)).size !== selections.length) v.invalid('每次最多选择三个不同的技能。');
    const items: ContextItem[] = []; const snapshots: SkillSnapshot[] = [];
    for (const selection of selections) {
      const skill = available.find((entry) => entry.id === selection.id) ?? notFound('创作技能');
      if (!skill.enabled) throw new AppError(409, 'SKILL_DISABLED', '所选技能已停用，请重新选择。');
      const frozen = replay?.find((entry) => entry.id === selection.id && entry.version === selection.version);
      if (!frozen && selection.version !== skill.version) throw new AppError(409, 'SKILL_CHANGED', '所选技能已经更新，请重新预览后开始。', skill.version);
      const definition = frozen?.definition ?? skillDefinition(skill);
      if (!definition.tasks.includes(input.kind)) v.invalid('所选技能不适合当前任务。');
      const paths = selection.resourcePaths ?? [];
      if (paths.some((path) => !definition.resources.some((entry) => entry.path === path))) v.invalid('所选技能参考资料不存在。');
      const resources = definition.resources.filter((entry) => paths.includes(entry.path));
      const snapshot: SkillSnapshot = { id: skill.id, version: frozen?.version ?? skill.version, hash: frozen?.hash ?? skill.hash, definition, focus: selection.focus ?? '', resources };
      snapshots.push(snapshot);
      items.push({ id: `skill:${skill.id}:v${snapshot.version}`, label: `本次创作方法 · ${definition.title} · V${snapshot.version}`, source: 'skill', required: true,
        text: `此方法仅辅助当前任务；不改变正文范围、输出格式、事实确认与作者采纳规则。\n${definition.instructions}${snapshot.focus ? `\n作者对本方法的补充：${snapshot.focus}` : ''}${resources.map((entry) => `\n参考资料 ${entry.path}：\n${entry.text}`).join('')}` });
    }
    const style = profile.style;
    if (Object.values(style).some((entry) => entry.trim())) items.push({ id: `style:v${profile.version}`, label: '本书文风（表达偏好，不是故事事实）', source: 'style', required: true,
      text: `叙述：${style.narration}\n语气：${style.tone}\n节奏：${style.pacing}\n避免：${style.avoid}\n作者范例（只参考表达）：${style.example}` });
    const voices = profile.voices.filter((voice) => input.voiceIds?.includes(voice.id));
    if (input.voiceIds?.some((id) => !voices.some((voice) => voice.id === id))) v.invalid('所选人物声音不存在，请重新载入档案。');
    for (const voice of voices) items.push({ id: `voice:${voice.id}:v${profile.version}`, label: `人物声音 · ${voice.name}（表达示例，非事实依据）`, source: 'style', required: true,
      text: `别名：${voice.aliases.join('、')}\n声音特点：${voice.traits}\n对白示例：${voice.example}` });
    const preferences = profile.preferences.filter((entry) => entry.status === 'confirmed');
    for (const entry of preferences) items.push({ id: `preference:${entry.id}:v${profile.version}`, label: `作者确认的偏好 · ${entry.title}`, source: 'style', required: false,
      text: `适用条件：${entry.condition || '依当前场景判断，不机械套用'}\n原句：${entry.before}\n作者改稿：${entry.after}\n理由：${entry.reason}\n例外：${entry.counterExample || '不由单次改稿推出通用禁令'}。仅作表达偏好，不改变剧情事实。` });
    return { items, snapshot: { skills: snapshots, profileVersion: profile.version, profileHash: creativeHash(profile), voiceIds: voices.map((entry) => entry.id), preferenceIds: preferences.map((entry) => entry.id) } };
  }
  exportBook(bookId: string): JsonValue {
    const skills = this.skills(bookId).filter((entry) => !entry.builtin);
    const skillHistory = (this.store.db.prepare('SELECT payload FROM creative_skill_history WHERE book_id=? ORDER BY rowid').all(bookId) as SkillRow[]).map((row) => JSON.parse(row.payload) as CreativeSkill);
    return JSON.parse(JSON.stringify({ version: 1, profile: this.profile(bookId), skills, skillHistory, profileHistory: this.profileHistory(bookId).reverse() })) as JsonValue;
  }
  prepareRestore(value: unknown, ids: Record<string, string>): void {
    if (value === undefined) return;
    const row = v.object(value, '创作技能备份'); if (row.version !== 1) v.invalid('创作技能备份版本不支持。');
    const owned = new Map<string,string>();
    const register = (value: unknown,kind:string) => { const id = v.string(value, '创作条目 ID', 128, 1); if(owned.has(id)&&owned.get(id)!==kind)v.invalid('创作备份含跨类别重复 ID。');if (!owned.has(id)) { if (ids[id]) v.invalid('创作备份含重复 ID。'); ids[id] = randomUUID(); owned.set(id,kind); } };
    for (const skill of list(row.skills, '技能备份', 100)) { const item = v.object(skill); if (owned.has(String(item.id))) v.invalid('技能 ID 重复。'); register(item.id,'skill'); }
    for (const profile of [row.profile, ...list(row.profileHistory, '档案历史', 100000)]) {
      const item = v.object(profile); for (const entry of list(item.voices, '声音', 40)) register(v.object(entry).id,'voice');for (const entry of list(item.preferences, '偏好', 100)) register(v.object(entry).id,'preference');
    }
  }
  restoreBook(oldBookId: string, newBookId: string, ids: Record<string, string>, value: unknown): void {
    if (value === undefined) return;
    const row = v.object(value, '创作技能备份');
    const parseSkill = (value: unknown): CreativeSkill => {
      const item = v.object(value, '技能备份');
      const id = v.string(item.id, '技能 ID', 128, 1);
      if (item.bookId !== oldBookId || !ids[id] || item.builtin !== false || typeof item.enabled !== 'boolean') v.invalid('技能备份关联不正确。');
      const fields = ['name', 'title', 'description', 'tasks', 'instructions', 'contextNeeds', 'resources', 'license', 'source'];
      const definition = parseSkillDefinition(Object.fromEntries(fields.map((key) => [key, item[key]])));
      if (item.hash !== creativeHash(definition)) v.invalid('技能备份内容与哈希不一致。');
      return { ...definition, id: ids[id]!, bookId: newBookId, version: v.integer(item.version, '技能版本', 1), hash: item.hash as string, builtin: false,
        enabled: item.enabled as boolean, createdAt: v.string(item.createdAt, '创建时间', 40, 1), updatedAt: v.string(item.updatedAt, '更新时间', 40, 1) };
    };
    const skills = list(row.skills, '技能备份', 100).map(parseSkill);
    for (const skill of skills) this.putSkill(skill);
    const history = list(row.skillHistory, '技能历史', 100000).map(parseSkill);
    for (const skill of history) {
      const current = skills.find((entry) => entry.id === skill.id);
      if (!current || skill.version > current.version) v.invalid('技能历史版本不正确。');
      this.store.db.prepare('INSERT INTO creative_skill_history(id,book_id,skill_id,payload) VALUES(?,?,?,?)').run(randomUUID(), newBookId, skill.id, JSON.stringify(skill));
    }
    const mapProfile = (value: unknown): CreativeProfile => {
      const profile = profileFromBackup(value, oldBookId); const mapped: CreativeProfile = { ...profile, bookId: newBookId,
        voices: profile.voices.map((voice) => ({ ...voice, id: ids[voice.id]! })), preferences: profile.preferences.map((entry) => {
          if ((entry.sourceJobId && !ids[entry.sourceJobId]) || (entry.sourceChapterId && !ids[entry.sourceChapterId])) v.invalid('偏好案例来源缺失。');
          return { ...entry, id: ids[entry.id]!, ...(entry.sourceJobId ? { sourceJobId: ids[entry.sourceJobId] } : {}), ...(entry.sourceChapterId ? { sourceChapterId: ids[entry.sourceChapterId] } : {}) };
        }), defaultSkillIds: Object.fromEntries(Object.entries(profile.defaultSkillIds).map(([kind, entries]) => [kind, entries!.map((id) => id.startsWith('builtin-') ? id : ids[id] ?? v.invalid('常用技能引用缺失。'))])) };
      this.validateProfileRelations(newBookId,mapped,false);
      return mapped;
    };
    const profile = mapProfile(row.profile);
    this.validateProfileRelations(newBookId,profile);
    this.putProfile(profile);
    for (const value of list(row.profileHistory, '档案历史', 100000)) {
      const prior = mapProfile(value); if (prior.version > profile.version) v.invalid('创作档案历史版本不正确。');
      this.store.db.prepare('INSERT INTO creative_profile_history(id,book_id,payload) VALUES(?,?,?)').run(randomUUID(), newBookId, JSON.stringify(prior));
    }
  }
}

export function registerCreativeRoutes(app: FastifyInstance, store: Store): CreativeService {
  const service = new CreativeService(store);
  const param = (request: FastifyRequest, name: string) => v.string(v.object(request.params)[name], '记录 ID', 128, 1);
  app.get('/api/books/:bookId/creative', async (request) => { const book = param(request, 'bookId'); return { profile: service.profile(book), skills: service.skills(book) }; });
  app.put('/api/books/:bookId/creative', async (request) => ({ profile: service.saveProfile(param(request, 'bookId'), request.body) }));
  app.get('/api/books/:bookId/creative/history', async (request) => ({ profiles: service.profileHistory(param(request, 'bookId')) }));
  app.post('/api/books/:bookId/skills', async (request, reply) => reply.code(201).send({ skill: service.saveSkill(param(request, 'bookId'), request.body) }));
  app.post('/api/books/:bookId/skills/import', async (request, reply) => reply.code(201).send({ skill: service.saveSkill(param(request, 'bookId'), { definition: importSkill(request.body), enabled: true, expectedVersion: 0 }) }));
  app.put('/api/books/:bookId/skills/:id', async (request) => ({ skill: service.saveSkill(param(request, 'bookId'), request.body, param(request, 'id')) }));
  app.get('/api/books/:bookId/skills/:id/history', async (request) => ({ skills: service.skillHistory(param(request, 'bookId'), param(request, 'id')) }));
  app.get('/api/books/:bookId/skills/:id/export', async (request) => ({ format: 'shujian-skill', version: 1, definition: skillDefinition(service.skill(param(request, 'bookId'), param(request, 'id'))) }));
  app.get('/api/chapters/:chapterId/clean-check', async (request) => { const chapter = store.getChapter(param(request, 'chapterId')); return { chapterId: chapter.id, version: chapter.version, findings: cleanManuscript(chapter.plainText), modelCalled: false }; });
  return service;
}
