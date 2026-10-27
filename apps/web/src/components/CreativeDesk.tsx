import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, Plus, Save } from 'lucide-react';
import type { AiTaskKind, CreativeProfile, CreativeSkill, PreferenceExample, SkillDefinition } from '@shujian/contracts';
import { creativeApi } from '../lib/creative-api';
import { downloadBlob, errorMessage } from '../lib/api';
import { Dialog } from './Dialog';
import '../creative.css';

export const creativeTaskLabels: Record<AiTaskKind, string> = { discuss: '讨论', plan: '策划', draft: '起草', revise: '改稿', review: '检查', extract: '整理资料' };
export function downloadJson(value: unknown, filename: string) { downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }), filename); }
const definitionOf = (skill: SkillDefinition): SkillDefinition => ({ name: skill.name, title: skill.title, description: skill.description, tasks: [...skill.tasks], instructions: skill.instructions,
  contextNeeds: [...skill.contextNeeds], resources: skill.resources.map((entry) => ({ ...entry })), license: skill.license, source: skill.source });
const blankDefinition = (): SkillDefinition => ({ name: 'my-writing-method', title: '我的创作方法', description: '', tasks: ['draft', 'revise'], instructions: '', contextNeeds: ['current'], resources: [], license: '', source: '' });
interface Props { bookId: string; onClose: () => void; onSaved: () => void; preferenceSeed?: PreferenceExample | null }

export function CreativeDesk({ bookId, onClose, onSaved, preferenceSeed }: Props) {
  const [profile, setProfile] = useState<CreativeProfile | null>(null);
  const [voiceAliasInputs, setVoiceAliasInputs] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState<CreativeSkill[]>([]);
  const [tab, setTab] = useState<'skills' | 'style' | 'voices' | 'preferences'>(preferenceSeed ? 'preferences' : 'skills');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [definition, setDefinition] = useState<SkillDefinition>(blankDefinition);
  const [enabled, setEnabled] = useState(true);
  const [profileDirty, setProfileDirty] = useState(false);
  const [skillDirty, setSkillDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<CreativeProfile[]>([]);
  const [skillHistory, setSkillHistory] = useState<CreativeSkill[]>([]);
  const [defaultTask, setDefaultTask] = useState<AiTaskKind>('draft');
  const importRef = useRef<HTMLInputElement>(null);
  const selected = skills.find((entry) => entry.id === selectedId);
  const chooseSkill = (skill: CreativeSkill | null) => { if (skillDirty && !window.confirm('当前方法还有未保存修改，放弃这些修改并切换？')) return;
    setSelectedId(skill?.id ?? null); setDefinition(skill ? definitionOf(skill) : blankDefinition()); setEnabled(skill?.enabled ?? true); setSkillDirty(false); setSkillHistory([]); };
  useEffect(() => {
    let live = true;
    void creativeApi.data(bookId).then((data) => {
      if (!live) return;
      const next = data.profile;
      if (preferenceSeed) { next.preferences.push(preferenceSeed); setProfileDirty(true); }
      setProfile(next); setSkills(data.skills); const first = data.skills[0];
      setVoiceAliasInputs(Object.fromEntries(next.voices.map((voice) => [voice.id, voice.aliases.join('、')])));
      if (first) { setSelectedId(first.id); setDefinition(definitionOf(first)); setEnabled(first.enabled); }
    }).catch((failure) => { if (live) setError(errorMessage(failure)); });
    return () => { live = false; };
  }, [bookId]);
  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => { if (profileDirty || skillDirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [profileDirty, skillDirty]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(null); setNotice(null); try { await action(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } };
  const changeProfile = (update: (value: CreativeProfile) => CreativeProfile) => { setProfile((current) => current ? update(current) : current); setProfileDirty(true); };
  const updateDefinition = (value: Partial<SkillDefinition>) => { setDefinition((current) => ({ ...current, ...value })); setSkillDirty(true); };
  const saveProfile = () => { if (profile) void run(async () => { const result = await creativeApi.saveProfile(bookId, { ...profile, expectedVersion: profile.version }); setProfile(result.profile); setVoiceAliasInputs(Object.fromEntries(result.profile.voices.map((voice) => [voice.id, voice.aliases.join('、')]))); setProfileDirty(false); setNotice('创作档案已保存。新任务使用新档案，既有任务保持原来的依据。'); onSaved(); }); };
  const saveSkill = (copy: boolean) => void run(async () => { const result = await creativeApi.saveSkill(bookId, definition, enabled, copy || !selected ? 0 : selected.version, copy ? undefined : selected?.id);
    const data = await creativeApi.data(bookId); setSkills(data.skills); setSelectedId(result.skill.id); setDefinition(definitionOf(result.skill)); setEnabled(result.skill.enabled); setSkillDirty(false);
    const removedDefault = !result.skill.enabled && profile && Object.values(profile.defaultSkillIds).some((ids) => ids?.includes(result.skill.id));
    if (removedDefault) changeProfile((p) => ({ ...p, defaultSkillIds: Object.fromEntries(Object.entries(p.defaultSkillIds).map(([task, ids]) => [task, ids!.filter((id) => id !== result.skill.id)])) }));
    setNotice(`已保存「${result.skill.title}」V${result.skill.version}。${removedDefault ? '已从本机常用设置移除，请保存创作档案使设置生效。' : !result.skill.enabled ? '该技能已停用，不再用于新任务。' : ''}`); onSaved(); });
  const close = () => { if (!(profileDirty || skillDirty) || window.confirm('还有未保存内容。关闭后将放弃本次填写，是否关闭？')) onClose(); };
  const localDraft = () => ({ ...profile, editingSkill: definition, editingSkillEnabled: enabled, editingSkillId: selectedId, editingSkillVersion: selected?.version ?? null });
  const reloadProfile = () => void run(async () => {
    downloadJson(localDraft(), '创作档案-重载前填写.json');
    const latest = await creativeApi.data(bookId);
    setProfile(latest.profile); setVoiceAliasInputs(Object.fromEntries(latest.profile.voices.map((voice) => [voice.id, voice.aliases.join('、')]))); setProfileDirty(false); setHistory([]);
    setNotice('已导出本机填写并载入服务器最新档案。技能编辑稿仍保留，请核对后继续。');
  });
  const reloadSkill = () => { if (!selected || selected.builtin) return; void run(async () => {
    downloadJson(localDraft(), '创作技能-重载前填写.json');
    const latest = await creativeApi.data(bookId); const skill = latest.skills.find((entry) => entry.id === selected.id);
    if (!skill) throw new Error('此技能已不可用，本机填写已导出。');
    setSkills(latest.skills); setDefinition(definitionOf(skill)); setEnabled(skill.enabled); setSkillDirty(false); setSkillHistory([]);
    setNotice('已导出本机填写并载入技能最新版本。未保存的文风、声音和偏好仍保留。');
  }); };
  const updatePreference = (id: string, patch: Partial<PreferenceExample>) => changeProfile((p) => ({ ...p, preferences: p.preferences.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) }));
  const importFile = (file: File | undefined) => { if (!file || (skillDirty && !window.confirm(`导入「${file.name}」会替换当前未保存的方法填写，是否继续？`))) return; void run(async () => {
    if (file.size > 200000) throw new Error('技能文件超过 200 KB，请减少参考资料后再导入。');
    const text = (await file.text()).replace(/^\uFEFF/, ''); const payload: unknown = file.name.toLowerCase().endsWith('.json') ? JSON.parse(text) : { markdown: text };
    const result = await creativeApi.importSkill(bookId, payload); const data = await creativeApi.data(bookId); setSkills(data.skills);
    setSelectedId(result.skill.id); setDefinition(definitionOf(result.skill)); setEnabled(true); setSkillDirty(false); setNotice('技能已作为本作品的独立副本导入。'); onSaved();
  }); };
  return <Dialog title="文风与创作技能" subtitle="为这部作品留下可复用的方法与声音。每次 AI 任务仍由你决定是否采纳。" onClose={close} busy={busy} wide>
    <div className="creative-desk"><fieldset className="creative-edit-scope" disabled={busy}>
      <div className="creative-tabs" role="tablist" aria-label="创作档案分类">{([['skills', '创作技能'], ['style', '本书文风'], ['voices', '人物声音'], ['preferences', '偏好案例']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div>
      {error && <p className="notice error" role="alert">{error} 填写内容仍保留，可先导出再处理。</p>}{notice && <p className="notice success" role="status">{notice}</p>}
      {error && <div className="creative-reload-actions">{profileDirty && <button className="text-button" onClick={reloadProfile}>导出填写并载入最新档案</button>}{skillDirty && selected && !selected.builtin && <button className="text-button" onClick={reloadSkill}>导出填写并载入技能最新版本</button>}</div>}
      {!profile ? <p className="field-help">正在读取本书档案……</p> : <>
        {tab === 'skills' && <div className="creative-skill-layout">
          <nav className="creative-skill-list" aria-label="本书创作技能"><div className="creative-list-actions"><button className="text-button" onClick={() => chooseSkill(null)}><Plus size={13} />新建</button><button className="text-button" disabled={busy} onClick={() => importRef.current?.click()}><FileUp size={13} />导入</button><input ref={importRef} hidden type="file" accept=".md,.json" aria-label="导入技能文件" onChange={(event) => { importFile(event.target.files?.[0]); event.target.value = ''; }} /></div>
            {skills.map((skill) => <button key={skill.id} className={selectedId === skill.id ? 'selected' : ''} onClick={() => chooseSkill(skill)}><strong>{skill.title}</strong><span>{skill.builtin ? '内置' : '自定义'} · V{skill.version} · {skill.builtin ? profile.disabledSkillIds.includes(skill.id) ? '已停用' : '已启用' : skill.enabled ? '已启用' : '已停用'}</span></button>)}
          </nav>
          <section className="creative-form" aria-label="技能编辑">
            <div className="creative-section-heading"><div><span className="eyebrow">A METHOD FOR THIS STORY</span><h3>{selected?.builtin ? '从一个方法，写出自己的版本' : selected ? '编辑我的创作方法' : '新建创作方法'}</h3></div>{selected && <button className="text-button" disabled={busy} onClick={() => void run(async () => downloadJson(await creativeApi.exportSkill(bookId, selected.id), `${selected.name}.skill.json`))}><Download size={13} />导出技能</button>}</div>
            <div className="creative-two-columns"><label>技能标题<input aria-label="技能标题" value={definition.title} maxLength={100} onChange={(e) => updateDefinition({ title: e.target.value })} /></label><label>英文标识<input aria-label="技能英文标识" value={definition.name} maxLength={64} onChange={(e) => updateDefinition({ name: e.target.value })} /></label></div>
            <label>何时使用<textarea aria-label="技能适用说明" value={definition.description} rows={2} maxLength={1024} onChange={(e) => updateDefinition({ description: e.target.value })} /></label>
            <fieldset><legend>适用任务</legend><div className="creative-checks">{(Object.keys(creativeTaskLabels) as AiTaskKind[]).map((task) => <label key={task}><input type="checkbox" checked={definition.tasks.includes(task)} onChange={(e) => updateDefinition({ tasks: e.target.checked ? [...definition.tasks, task] : definition.tasks.filter((entry) => entry !== task) })} />{creativeTaskLabels[task]}</label>)}</div></fieldset>
            <label>创作方法<textarea aria-label="创作方法正文" value={definition.instructions} rows={8} maxLength={20000} onChange={(e) => updateDefinition({ instructions: e.target.value })} /></label>
            <details><summary>来源、许可与可选参考资料</summary><label>来源<input aria-label="技能来源" value={definition.source} maxLength={2000} onChange={(e) => updateDefinition({ source: e.target.value })} /></label><label>许可<input aria-label="技能许可" value={definition.license} maxLength={1000} onChange={(e) => updateDefinition({ license: e.target.value })} /></label>
              {definition.resources.map((resource, index) => <div className="creative-resource" key={index}><label>包内文件名<input aria-label={`参考资料路径 ${index + 1}`} value={resource.path} onChange={(e) => updateDefinition({ resources: definition.resources.map((entry, i) => i === index ? { ...entry, path: e.target.value } : entry) })} placeholder="references/example.md" /></label><label>资料正文<textarea aria-label={`参考资料正文 ${index + 1}`} rows={3} maxLength={12000} value={resource.text} onChange={(e) => updateDefinition({ resources: definition.resources.map((entry, i) => i === index ? { ...entry, text: e.target.value } : entry) })} /></label><button className="text-button" onClick={() => updateDefinition({ resources: definition.resources.filter((_, i) => i !== index) })}>移除此资料</button></div>)}
              <button className="text-button" disabled={definition.resources.length >= 8} onClick={() => updateDefinition({ resources: [...definition.resources, { path: `references/example-${definition.resources.length + 1}.md`, text: '' }] })}><Plus size={13} />添加文本参考</button><p className="field-help">参考资料仅在本次任务选中时加载。技能文件中的链接不会自动联网，也不会执行脚本。</p>
            </details>
            {!selected?.builtin && <label className="checkbox-field"><input aria-label="启用自定义技能" type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setSkillDirty(true); }} />在本书启用此技能</label>}
            <div className="creative-inline-actions"><button className="button primary compact" disabled={busy} onClick={() => saveSkill(!!selected?.builtin)}><Save size={13} />{selected?.builtin || !selected ? '保存为我的技能' : '保存新版本'}</button>{selected && !selected.builtin && <button className="button secondary compact" disabled={busy} onClick={() => saveSkill(true)}>另存为副本</button>}{selected && <button className="text-button" onClick={() => void run(async () => setSkillHistory((await creativeApi.skillHistory(bookId, selected.id)).skills))}>查看技能历史</button>}</div>
            {skillHistory.length > 0 && <details open><summary>保留的技能版本</summary>{skillHistory.map((skill) => <details key={skill.version}><summary>V{skill.version} · {skill.updatedAt.slice(0, 10)} · {skill.hash.slice(0, 12)}</summary><pre>{skill.instructions}</pre><button className="text-button" onClick={() => { if (skillDirty && !window.confirm('载入历史版本会替换当前未保存的方法填写，是否继续？')) return; setDefinition(definitionOf(skill)); setEnabled(skill.enabled); setSkillDirty(true); }}>载入为编辑稿</button></details>)}</details>}
            {selected?.builtin && <label className="checkbox-field"><input aria-label="本书启用此内置技能" type="checkbox" checked={!profile.disabledSkillIds.includes(selected.id)} onChange={(e) => changeProfile((p) => ({ ...p, disabledSkillIds: e.target.checked ? p.disabledSkillIds.filter((id) => id !== selected.id) : [...p.disabledSkillIds, selected.id], defaultSkillIds: e.target.checked ? p.defaultSkillIds : Object.fromEntries(Object.entries(p.defaultSkillIds).map(([task, ids]) => [task, ids!.filter((id) => id !== selected.id)])) }))} />在本书启用此内置方法（保存档案后生效）</label>}
            <details><summary>每类任务的常用方法</summary><label>任务<select aria-label="常用技能任务" value={defaultTask} onChange={(e) => setDefaultTask(e.target.value as AiTaskKind)}>{Object.entries(creativeTaskLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><div className="creative-checks">{skills.filter((skill) => skill.tasks.includes(defaultTask) && (skill.builtin ? !profile.disabledSkillIds.includes(skill.id) : skill.enabled)).map((skill) => <label key={skill.id}><input type="checkbox" checked={profile.defaultSkillIds[defaultTask]?.includes(skill.id) ?? false} disabled={!(profile.defaultSkillIds[defaultTask]?.includes(skill.id) ?? false) && (profile.defaultSkillIds[defaultTask]?.length ?? 0) >= 3} onChange={(e) => changeProfile((p) => ({ ...p, defaultSkillIds: { ...p.defaultSkillIds, [defaultTask]: e.target.checked ? [...(p.defaultSkillIds[defaultTask] ?? []), skill.id] : (p.defaultSkillIds[defaultTask] ?? []).filter((id) => id !== skill.id) } }))} />{skill.title}</label>)}</div><p className="field-help">每次最多三个方法，发起任务时仍可调整。</p></details>
          </section>
        </div>}
        {tab === 'style' && <section className="creative-form"><span className="eyebrow">THE VOICE OF YOUR BOOK</span><h3>让表达有自己的方向</h3><p className="field-help">本书文风会参与新任务；范例只作为表达参考，不作为剧情事实。本次要求仍可具体调整。</p>{([['narration', '叙述方式', '例如：第三人称限制视角，贴近人物当下感受。'], ['tone', '语气与幽默', '例如：自然接地气，幽默来自人物反差。'], ['pacing', '句式与节奏', '例如：对白简洁，关键情绪留出停顿。'], ['avoid', '希望避免的表达', '例如：不在章末替人物总结道理。'], ['example', '自己的表达范例', '粘贴你有权使用、想保留表达特点的短段落。']] as const).map(([key, label, placeholder]) => <label key={key}>{label}<textarea aria-label={label} value={profile.style[key]} maxLength={key === 'example' ? 8000 : 3000} rows={key === 'example' ? 5 : 3} placeholder={placeholder} onChange={(e) => changeProfile((p) => ({ ...p, style: { ...p.style, [key]: e.target.value } }))} /></label>)}</section>}
        {tab === 'voices' && <section className="creative-form"><div className="creative-section-heading"><div><span className="eyebrow">EVERY PERSON HAS A VOICE</span><h3>人物声音卡</h3></div><button className="button secondary compact" disabled={profile.voices.length >= 40} onClick={() => changeProfile((p) => ({ ...p, voices: [...p.voices, { id: crypto.randomUUID(), name: '', aliases: [], traits: '', example: '' }] }))}><Plus size={13} />添加人物声音</button></div><p className="field-help">每次任务明确选择要参考的人物声音，未选中的卡片不会送入模型。事实与知情范围仍以故事资料为准。</p>
          {profile.voices.map((voice, index) => <article className="creative-card" key={voice.id}>{([['name', '人物名称'], ['traits', '声音特点'], ['example', '对白示例']] as const).map(([key, label]) => <label key={key}>{label}{key === 'name' ? <input aria-label={`${label} ${index + 1}`} value={voice[key]} maxLength={100} onChange={(e) => changeProfile((p) => ({ ...p, voices: p.voices.map((entry) => entry.id === voice.id ? { ...entry, [key]: e.target.value } : entry) }))} /> : <textarea aria-label={`${label} ${index + 1}`} value={voice[key]} maxLength={key === 'traits' ? 3000 : 4000} rows={3} onChange={(e) => changeProfile((p) => ({ ...p, voices: p.voices.map((entry) => entry.id === voice.id ? { ...entry, [key]: e.target.value } : entry) }))} />}</label>)}<label>别名（用顿号分隔）<input aria-label={`声音别名 ${index + 1}`} value={voiceAliasInputs[voice.id] ?? voice.aliases.join('、')} onChange={(e) => { const raw = e.target.value; setVoiceAliasInputs((inputs) => ({ ...inputs, [voice.id]: raw })); changeProfile((p) => ({ ...p, voices: p.voices.map((entry) => entry.id === voice.id ? { ...entry, aliases: raw.split(/[、,，]/).map((alias) => alias.trim()).filter(Boolean) } : entry) })); }} /></label><button className="text-button" onClick={() => changeProfile((p) => ({ ...p, voices: p.voices.filter((entry) => entry.id !== voice.id) }))}>移除此声音卡</button></article>)}
        </section>}
        {tab === 'preferences' && <section className="creative-form"><div className="creative-section-heading"><div><span className="eyebrow">LEARN FROM YOUR CHOICES</span><h3>作者偏好案例</h3></div><button className="button secondary compact" disabled={profile.preferences.length >= 100} onClick={() => changeProfile((p) => ({ ...p, preferences: [...p.preferences, { id: crypto.randomUUID(), title: '', before: '', after: '', reason: '', condition: '', counterExample: '', status: 'pending' }] }))}><Plus size={13} />添加偏好案例</button></div><p className="field-help">保留具体改稿和适用条件。只有“已确认”案例参与新任务；单次删除不代表永久禁令，也不把未修改的文字当作认可。</p>
          {profile.preferences.map((entry, index) => <article className="creative-card" key={entry.id}>{([['title', '案例标题'], ['before', '修改前'], ['after', '作者改稿'], ['reason', '修改理由'], ['condition', '适用条件'], ['counterExample', '例外或反例']] as const).map(([key, label]) => <label key={key}>{label}{key === 'title' ? <input aria-label={`${label} ${index + 1}`} value={entry[key]} maxLength={100} onChange={(e) => updatePreference(entry.id, { [key]: e.target.value })} /> : <textarea aria-label={`${label} ${index + 1}`} value={entry[key]} maxLength={key === 'before' || key === 'after' ? 6000 : 2000} rows={key === 'before' || key === 'after' ? 3 : 2} onChange={(e) => updatePreference(entry.id, { [key]: e.target.value })} />}</label>)}<label>确认状态<select aria-label={`偏好确认状态 ${index + 1}`} value={entry.status} onChange={(e) => updatePreference(entry.id, { status: e.target.value as PreferenceExample['status'] })}><option value="pending">待确认 · 暂不参与</option><option value="confirmed">已确认 · 可供参考</option><option value="withdrawn">已撤回 · 不再参与</option></select></label>{entry.sourceJobId && <p className="field-help">保留来源任务：{entry.sourceJobId}。原句与改稿可在这里选取相关片段。</p>}</article>)}
        </section>}
        <div className="creative-profile-footer"><span>档案 V{profile.version}{profileDirty ? ' · 尚未保存' : ' · 已载入'}</span><button className="text-button" onClick={() => downloadJson({ ...profile, editingSkill: definition, editingSkillEnabled: enabled, editingSkillId: selectedId, editingSkillVersion: selected?.version ?? null }, '创作档案-本机填写.json')}>导出填写内容</button><button className="text-button" onClick={() => void run(async () => setHistory((await creativeApi.profileHistory(bookId)).profiles))}>档案历史</button><button className="button primary compact" disabled={busy || !profileDirty} onClick={saveProfile}><Save size={13} />保存创作档案</button></div>
        {history.length > 0 && <div className="creative-history">{history.map((entry) => <details key={entry.version}><summary>档案 V{entry.version} · {entry.updatedAt.slice(0, 16).replace('T', ' ')}</summary><p>{entry.style.tone || '未填写语气'} · {entry.voices.length} 个人物声音 · {entry.preferences.length} 个案例</p><button className="text-button" onClick={() => { if (profileDirty && !window.confirm('载入历史档案会替换当前未保存的文风、声音和偏好填写，是否继续？')) return; setProfile({ ...entry, version: profile.version, updatedAt: profile.updatedAt }); setVoiceAliasInputs(Object.fromEntries(entry.voices.map((voice) => [voice.id, voice.aliases.join('、')]))); setProfileDirty(true); }}>载入此版作为编辑稿</button></details>)}</div>}
      </>}
    </fieldset></div>
  </Dialog>;
}
