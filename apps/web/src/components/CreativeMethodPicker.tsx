import type { AiTaskKind, CreativeProfile, CreativeSkill, SkillSelection } from '@shujian/contracts';

interface Props {
  kind: AiTaskKind; skills: CreativeSkill[]; profile: CreativeProfile | null;
  selections: SkillSelection[]; voiceIds: string[]; onSelections: (items: SkillSelection[]) => void;
  onVoices: (ids: string[]) => void; onManage: () => void;
}
export function CreativeMethodPicker({ kind, skills, profile, selections, voiceIds, onSelections, onVoices, onManage }: Props) {
  return <details className="creative-methods"><summary>创作方法与人物声音{selections.length ? ` · ${selections.length} 个方法` : '（可选）'}</summary>
    <p className="field-help">只加载选中的方法与参考资料，每次最多三个。写作范围和采纳仍由你决定。</p>
    {skills.filter((skill) => skill.enabled && skill.tasks.includes(kind)).map((skill) => {
      const selected = selections.find((item) => item.id === skill.id);
      const update = (patch: Partial<SkillSelection>) => onSelections(selections.map((item) => item.id === skill.id ? { ...item, ...patch } : item));
      return <div className="creative-method-card" key={skill.id}><label><input type="checkbox" aria-label={`使用方法：${skill.title}`} checked={!!selected} disabled={!selected && selections.length >= 3} onChange={(event) => onSelections(event.target.checked ? [...selections, { id: skill.id, version: skill.version }] : selections.filter((item) => item.id !== skill.id))} />{skill.title}<small>V{skill.version}</small></label><p>{skill.description}</p>
        {selected && <><textarea aria-label={`方法补充：${skill.title}`} placeholder="本次特别希望注意什么？（可留空）" rows={2} maxLength={2000} value={selected.focus ?? ''} onChange={(e) => update({ focus: e.target.value })} />{skill.resources.map((resource) => <label className="creative-voice-choice" key={resource.path}><input type="checkbox" aria-label={`加载参考：${resource.path}`} checked={selected.resourcePaths?.includes(resource.path) ?? false} onChange={(e) => update({ resourcePaths: e.target.checked ? [...(selected.resourcePaths ?? []), resource.path] : (selected.resourcePaths ?? []).filter((path) => path !== resource.path) })} />加载参考：{resource.path}</label>)}</>}
      </div>;
    })}
    {profile && profile.voices.length > 0 && <div><p className="field-help">本次参考的人物声音（最多八个）</p>{profile.voices.map((voice) => <label className="creative-voice-choice" key={voice.id}><input type="checkbox" aria-label={`参考人物声音：${voice.name}`} disabled={!voiceIds.includes(voice.id) && voiceIds.length >= 8} checked={voiceIds.includes(voice.id)} onChange={(e) => onVoices(e.target.checked ? [...voiceIds, voice.id] : voiceIds.filter((id) => id !== voice.id))} />{voice.name}</label>)}</div>}
    {profile && <p className="field-help">本书档案 V{profile.version} · {profile.preferences.filter((entry) => entry.status === 'confirmed').length} 个已确认偏好案例。待确认与已撤回案例不参与。</p>}
    <button className="text-button" onClick={onManage}>管理技能、文风与声音 →</button>
  </details>;
}
