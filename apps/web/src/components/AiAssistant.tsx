import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Download, LoaderCircle, MessageSquare, Pin, Play, RefreshCw, Settings2, Square, X } from 'lucide-react';
import { documentToText, type AiJob, type AiTaskKind, type Chapter, type ChapterReview, type StoryEntry, type TextSelection, type ModelCall, type CreativeProfile, type CreativeSkill, type SkillSelection, type CreateAiJobInput, type ContextPreview, type CleanReport, type PreferenceExample } from '@shujian/contracts';
import { collaborationApi } from '../lib/collaboration-api';
import { downloadText, request, errorMessage } from '../lib/api';
import { get, set, del } from 'idb-keyval';
import { creativeApi } from '../lib/creative-api';
import { CreativeMethodPicker } from './CreativeMethodPicker';
import { ContextPreviewDialog } from './ContextPreviewDialog';
import { downloadJson } from './CreativeDesk';
import type { AtlasSelection } from '@shujian/contracts';

export interface AssistantRequest {kind:'discuss'|'revise'|'draft';sequence:number;instruction?:string;atlas?:AtlasSelection;voiceIds?:string[]}

const taskLabels: Record<AiTaskKind, string> = { discuss: '讨论', plan: '策划', draft: '起草', revise: '改稿', review: '检查', extract: '整理资料' };
const stateLabels = { queued: '等待开始', running: '正在写作', succeeded: '已完成', failed: '未完成', interrupted: '运行中断', cancelled: '已取消' };
const running = (job: AiJob) => job.status === 'queued' || job.status === 'running';
const defaults: Record<AiTaskKind, string> = {
  discuss: '', plan: '根据当前故事方向，帮我完善这一章的冲突、人物选择与结尾变化。',
  draft: '根据本章意图起草正文。保持人物的行动动机，推动情节，避免空泛的总结。',
  revise: '保留这段的情节和关键信息，让表达更准确，人物反应更自然。',
  review: '检查人物行为、事实连续性、视角知情范围与本章情节推进。给出原文证据，疑点供作者判断。',
  extract: '从本章定稿中整理有原文支持的人物、事件、物品变化和伏笔，生成待确认资料。',
};
interface Props {
  chapter: Chapter; dirty: boolean; selection: TextSelection | null; onFlush: () => Promise<Chapter>;
  onApply: (job: AiJob, text: string, target: 'document' | 'outline') => Promise<void>;
  onSettings: () => void; onStory: (content?:string) => void;
  onPlanning: (text: string) => void;
  requestedTask?:AssistantRequest|null;
  storyRevision?:number;
  creativeRevision?:number; onCreative: (seed?: PreferenceExample) => void;
}

export function AiAssistant({ chapter, dirty, selection, onFlush, onApply, onSettings, onStory, onPlanning, requestedTask, storyRevision, creativeRevision, onCreative }: Props) {
  const [kind, setKind] = useState<AiTaskKind>('discuss');
  const [instruction, setInstruction] = useState('');
  useEffect(()=>{if(requestedTask){setKind(requestedTask.kind);setInstruction(requestedTask.instruction??(requestedTask.kind==='discuss'?'讨论我选中的这段文字：人物动机、冲突或表达还有哪些选择？':defaults[requestedTask.kind]));setAtlasSelection(requestedTask.atlas??null);if(requestedTask.voiceIds)setVoiceIds(requestedTask.voiceIds);}},[requestedTask?.sequence]);
  const [autoReview,setAutoReview]=useState(true);
  const [extractSource,setExtractSource]=useState<'draft'|'final'>('final');
  const [pov, setPov] = useState('');
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [selected, setSelected] = useState<AiJob | null>(null);
  const [candidate, setCandidate] = useState('');
  const edited = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [entries, setEntries] = useState<StoryEntry[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [reviews, setReviews] = useState<ChapterReview[]>([]);
  const [calls,setCalls]=useState<ModelCall[]>([]);
  const [creative, setCreative] = useState<{ profile: CreativeProfile; skills: CreativeSkill[] } | null>(null);
  const [methods, setMethods] = useState<SkillSelection[]>([]);
  const methodsTouched = useRef(false);
  const methodsKind = useRef(kind);
  const [voiceIds, setVoiceIds] = useState<string[]>([]);
  const [atlasSelection,setAtlasSelection]=useState<AtlasSelection|null>(null);
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [previewInput, setPreviewInput] = useState<CreateAiJobInput | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [clean, setClean] = useState<CleanReport | null>(null);
  const creativeReady = creative?.profile.bookId === chapter.bookId;
  useEffect(() => { let live = true; void creativeApi.data(chapter.bookId).then((data) => { if (live) setCreative(data); }).catch((failure) => { if (live) setError(errorMessage(failure)); }); return () => { live = false; }; }, [chapter.bookId, creativeRevision]);
  useEffect(() => {
    if (methodsKind.current !== kind) { methodsKind.current = kind; methodsTouched.current = false; }
    if (!creative) return;
    setMethods((current) => methodsTouched.current ? current.flatMap((item) => { const skill = creative.skills.find((skill) => skill.id === item.id && skill.enabled && skill.tasks.includes(kind)); return skill ? [{ ...item, version: skill.version, resourcePaths: item.resourcePaths?.filter((path) => skill.resources.some((entry) => entry.path === path)) }] : []; }) : (creative.profile.defaultSkillIds[kind] ?? []).flatMap((id) => { const skill = creative.skills.find((item) => item.id === id && item.enabled && item.tasks.includes(kind)); return skill ? [{ id, version: skill.version }] : []; }));
    setVoiceIds((ids) => ids.filter((id) => creative.profile.voices.some((voice) => voice.id === id)));
  }, [kind, creative]);
  const mounted = useRef(true);
  const firstLoad = useRef(true);
  const updateSelected = useCallback((job: AiJob) => {
    if (!mounted.current) return;
    if(selectedIdRef.current!==job.id){
      selectedIdRef.current=job.id;edited.current=false;setCandidate(job.candidateText??job.output);
      if(!job.appliedVersion)void get<string>(`shujian:candidate:${job.id}`).then((cached)=>{if(mounted.current&&selectedIdRef.current===job.id&&!edited.current&&typeof cached==='string'){edited.current=true;setCandidate(cached);}}).catch(()=>setError('候选编辑的本机副本暂时不可用，请导出需要保留的修改。'));
    }else if(!edited.current||job.appliedVersion)setCandidate(job.candidateText??job.output);
    if(job.appliedVersion)void del(`shujian:candidate:${job.id}`).catch(()=>undefined);
    setSelected(job);
    setJobs((old) => [job, ...old.filter((entry) => entry.id !== job.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, []);
  const refreshJobs = useCallback(async () => {
    const [bookJobs,chapterJobs]=await Promise.all([collaborationApi.jobs(chapter.bookId),collaborationApi.chapterJobs(chapter.id)]);
    const response={jobs:[...new Map([...bookJobs.jobs,...chapterJobs.jobs].map((job)=>[job.id,job])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
    if (!mounted.current) return;
    setJobs(response.jobs);
    if (firstLoad.current) {
      firstLoad.current = false;
      const latest = response.jobs.find((job) => job.chapterId === chapter.id);
      if (latest) { setJobId(latest.id); updateSelected(latest); }
    }
  }, [chapter.bookId, chapter.id, updateSelected]);
  useEffect(() => {
    mounted.current = true;
    void refreshJobs().catch((failure) => { if (mounted.current) setError(errorMessage(failure)); });
    void collaborationApi.story(chapter.bookId).then((response) => { if (mounted.current) setEntries(response.entries.filter((entry) => entry.status === 'confirmed')); }).catch(() => undefined);
    return () => { mounted.current = false; };
  }, [chapter.bookId, refreshJobs, storyRevision]);
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try { const { job } = await collaborationApi.job(jobId); if (live) updateSelected(job); }
      catch (failure) { if (live) setError(errorMessage(failure)); }
      finally { fetching = false; }
    };
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    const receive = (event: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (parsed && typeof parsed === 'object' && 'job' in parsed) { if (live) updateSelected(parsed.job as AiJob); }
        else void refresh();
      } catch { void refresh(); }
    };
    source.addEventListener('job', receive);
    source.onmessage = receive;
    const timer = window.setInterval(() => { void refresh(); }, 1800);
    void refresh();
    return () => { live = false; source.close(); window.clearInterval(timer); };
  }, [jobId, updateSelected]);
  useEffect(() => {
    let live = true;
    void collaborationApi.reviews(chapter.id).then((result) => { if (live) setReviews(result.reviews); }).catch(() => undefined);
    return () => { live = false; };
  }, [chapter.id, chapter.version, selected?.status, selected?.id]);
  const terminalUpdate=selected&&!running(selected)?selected.updatedAt:null;
  useEffect(()=>{let live=true;if(selected)void request<{calls:ModelCall[]}>(`/jobs/${selected.id}/calls`).then((result)=>{if(live)setCalls(result.calls);}).catch(()=>undefined);else setCalls([]);return()=>{live=false;};},[selected?.id,selected?.usage.attempts,terminalUpdate]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const makeInput = async (): Promise<CreateAiJobInput> => {
    if (!instruction.trim()) throw new Error('先告诉 AI 你想讨论或修改什么。');
    const frozenSelection = selection;
    if (kind === 'revise' && !frozenSelection?.text.trim()) throw new Error('请先在正文中选中想修改的文字。');
    const saved = await onFlush();
    if (kind === 'extract' && extractSource==='final' && !saved.finalizedRevisionId) throw new Error('本章还没有定稿；可选择“当前保存稿”，生成随定稿确认的候选。');
    return { requestId: crypto.randomUUID(), kind, chapterId: chapter.id, expectedVersion: saved.version, instruction: instruction.trim(), ...(kind==='extract'?{source:extractSource}:{}), ...(['revise','discuss'].includes(kind) && frozenSelection ? { selection: frozenSelection } : {}), ...(pov.trim() ? { pov: pov.trim() } : {}), pinnedEntryIds: pins, excludedEntryIds: excluded, skills: methods, voiceIds,...(atlasSelection?{atlas:atlasSelection}:{}) };
  };
  const submit = async (input: CreateAiJobInput) => {
    const result = await collaborationApi.createJob(input);
    edited.current = false; setJobId(result.job.id); updateSelected(result.job); await refreshJobs();
    setPreview(null); setPreviewInput(null);
  };
  const start = () => { void run(async () => submit(await makeInput())); };
  const showPreview = () => { void run(async () => { const input = await makeInput(); const result = await creativeApi.preview(input); setPreviewInput(input); setPreview(result.preview); setPreviewError(null); }); };
  const chooseKind = (value: AiTaskKind) => { setKind(value); setInstruction(defaults[value]); setError(null); };
  const active = selected && running(selected);
  const stale = !!selected && selected.inputVersion !== chapter.version;
  const candidateKind = selected && ['discuss', 'plan', 'draft', 'revise'].includes(selected.kind);
  const canApply = selected?.status === 'succeeded' && candidate.trim() && !selected.appliedVersion && !stale && !dirty && selected.chapterId === chapter.id;
  const oldText = selected ? selected.kind === 'revise' ? selected.selection?.text ?? '' : selected.kind === 'plan' || selected.kind === 'discuss' ? selected.inputOutline : documentToText(selected.inputDocument) : '';
  const latestReview = reviews.find((review) => review.jobId === selected?.id);
  const relevantJobs = jobs.filter((job) => job.chapterId === chapter.id || job.kind === 'discuss').slice(0, 30);
  const toggleEntry = (id: string, mode: 'pin' | 'exclude') => {
    if (mode === 'pin') { setPins((old) => old.includes(id) ? old.filter((value) => value !== id) : [...old, id]); setExcluded((old) => old.filter((value) => value !== id)); }
    else { setExcluded((old) => old.includes(id) ? old.filter((value) => value !== id) : [...old, id]); setPins((old) => old.filter((value) => value !== id)); }
  };
  const adopt = async () => {
    if(!selected)return;
    await onApply(selected,candidate,['plan','discuss'].includes(selected.kind)?'outline':'document');
    const result=await collaborationApi.job(selected.id);updateSelected(result.job);setNotice('已采纳，采纳前的版本也已保留。');
    if(selected.kind==='draft'&&autoReview){
      try{const saved=await onFlush();const review=await collaborationApi.createJob({requestId:crypto.randomUUID(),kind:'review',chapterId:saved.id,expectedVersion:saved.version,instruction:defaults.review,...(pov.trim()?{pov:pov.trim()}:{})});setJobId(review.job.id);updateSelected(review.job);setNotice('起草已采纳，正在检查这份正文。你可以继续编辑。');}
      catch(failure){setError(`起草已采纳；自动检查未完成：${errorMessage(failure)}`);}
    }
  };
  return <section className="ai-assistant" aria-label="AI 创作助手">
    <div className="assistant-heading"><div><span className="eyebrow">WITH YOUR DIRECTION</span><h2>一起，把故事写下去</h2></div><button className="icon-button" aria-label="模型连接设置" onClick={onSettings}><Settings2 size={17} /></button></div>
    <div className="ai-task-tabs" role="group" aria-label="AI 任务类型">{(Object.keys(taskLabels) as AiTaskKind[]).map((task) => <button key={task} aria-pressed={kind === task} className={kind === task ? 'selected' : ''} onClick={() => chooseKind(task)}>{taskLabels[task]}</button>)}</div>
    <div className="ai-compose">
      {atlasSelection&&<div className="notice atlas-task-selection"><p>本次使用图谱子图 · {atlasSelection.nodeIds.length} 张卡片 · 方案 {atlasSelection.branch}{atlasSelection.includeIdeas?' · 构思想法仅作为假设':' · 仅使用已确认内容'}。知情范围和章节限制仍生效。</p><button type="button" className="text-button" onClick={()=>setAtlasSelection(null)}>清除本次图谱选择</button></div>}
      {kind === 'revise' && <div className="selected-excerpt"><span>当前选区 · {selection ? `${selection.text.length} 字符` : '尚未选择'}</span><p>{selection?.text || '在正文里选中一段，再告诉我希望怎么改。'}</p></div>}
      <label className="sr-only" htmlFor="ai-instruction">创作要求</label><textarea id="ai-instruction" aria-label="创作要求" placeholder={kind === 'discuss' ? '聊聊人物、设定或接下来的剧情……' : defaults[kind]} rows={4} value={instruction} maxLength={20000} onChange={(event) => setInstruction(event.target.value)} />
      <CreativeMethodPicker kind={kind} skills={creative?.skills ?? []} profile={creative?.profile ?? null} selections={methods} voiceIds={voiceIds} onSelections={(items) => { methodsTouched.current = true; setMethods(items); }} onVoices={setVoiceIds} onManage={() => onCreative()} />
      <details className="ai-context-options"><summary>视角与本次资料<ChevronDown size={12} /></summary><label>视角人物<input aria-label="当前视角人物" placeholder="留空按公开信息写作" value={pov} onChange={(e) => setPov(e.target.value)} /></label><p className="field-help">角色私有资料只在对应视角下参与。作者秘密不会进入正文写作。</p>{entries.length ? <div className="context-choice-list">{entries.map((entry) => <div key={entry.id}><span title={entry.content}>{entry.title}</span><button className={pins.includes(entry.id) ? 'chosen' : ''} aria-label={`固定资料：${entry.title}`} aria-pressed={pins.includes(entry.id)} onClick={() => toggleEntry(entry.id, 'pin')}><Pin size={12} />固定</button><button className={excluded.includes(entry.id) ? 'chosen excluded' : ''} aria-label={`排除资料：${entry.title}`} aria-pressed={excluded.includes(entry.id)} onClick={() => toggleEntry(entry.id, 'exclude')}><X size={12} />排除</button></div>)}</div> : <button className="text-button" onClick={() => onStory()}>添加故事资料<ArrowRight size={13} /></button>}</details>
      {kind === 'draft' && <label className="checkbox-field auto-review-option"><input aria-label="采纳起草后自动检查" type="checkbox" checked={autoReview} onChange={(event)=>setAutoReview(event.target.checked)}/>采纳起草后，检查当前稿（另一次模型调用）</label>}
      {kind==='extract'&&<label className="job-picker-label">资料来源<select aria-label="资料提取来源" value={extractSource} onChange={(event)=>setExtractSource(event.target.value as 'draft'|'final')}><option value="final">当前定稿 · 已正式采用</option><option value="draft">当前保存稿 · 随定稿确认</option></select></label>}
      <div className="creative-preview-tools"><button className="text-button" disabled={busy || !creativeReady || !instruction.trim()} onClick={showPreview}>预览本次材料与费用</button><button className="text-button" disabled={busy} onClick={() => void run(async () => { const saved = await onFlush(); setClean(await creativeApi.clean(saved.id)); })}>基础稿件检查 · 不调用模型</button></div>
      {clean && <div className="clean-findings" role="status"><strong>基础稿件检查 · V{clean.version}</strong><p>{dirty || clean.version !== chapter.version ? '正文已变化，请重新检查当前保存稿。' : '仅提示确定性问题，不评分、不改稿、不阻止定稿。'}</p>{clean.findings.length ? clean.findings.map((finding, index) => <div key={index}><p>{finding.message}</p><blockquote>{finding.quote}</blockquote></div>) : <p>未发现这几类明显残留，仍可继续通读。</p>}</div>}
      <div className="ai-compose-footer"><span>{kind === 'extract' ? extractSource==='final'?'以本章定稿为依据':'候选随定稿确认' : '结果由你决定是否采纳'}</span><button className="button primary compact" onClick={start} disabled={busy || !creativeReady || !instruction.trim() || !!jobs.find((job) => job.chapterId === chapter.id && running(job))}>{busy ? <LoaderCircle size={14} className="spin" /> : <Play size={13} />}开始{taskLabels[kind]}</button></div>
    </div>
    {error && <div className="notice error" role="alert">{error}<button className="text-button" onClick={onSettings}>模型设置</button></div>}{notice && <p className="notice success" role="status">{notice}</p>}
    <div className="ai-result-area">
      {relevantJobs.length > 0 && <label className="job-picker-label">创作记录<select aria-label="选择创作记录" value={jobId ?? ''} onChange={(e) => { const job = jobs.find((entry) => entry.id === e.target.value); if (job) { setJobId(job.id); updateSelected(job); } }}><option value="" disabled>选择一条记录</option>{relevantJobs.map((job) => <option key={job.id} value={job.id}>{taskLabels[job.kind]} · {new Date(job.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · {stateLabels[job.status]}</option>)}</select></label>}
      {!selected ? <div className="ai-empty"><MessageSquare size={28} strokeWidth={1} /><h3>故事的下一步，由你来定。</h3><p>从一次讨论开始，或给本章一个方向。<br />这里的建议，经你采纳才进入作品。</p></div> : <div className="job-result" data-job-status={selected.status}>
        <div className="job-result-heading"><strong>{taskLabels[selected.kind]}{active ? '中' : '结果'}</strong><span className={`job-state ${selected.status}`}>{active && <LoaderCircle size={12} className="spin" />}{stateLabels[selected.status]}</span></div>
        <p className="job-instruction">{selected.instruction}</p>
        {selected.error && <p className="notice error" role="alert">{selected.error}</p>}
        {stale && selected.kind!=='extract' && !selected.appliedVersion && <p className="notice warning">正文或章纲已经变化。这份结果可以参考，请根据当前稿重新发起，避免覆盖新编辑。</p>}
        {selected.appliedVersion && <p className="notice success"><Check size={13} />已采纳为第 {selected.appliedVersion} 稿，原稿已留在版本中。</p>}
        {selected.output || active ? <>
          {candidateKind ? <><label className="candidate-label" htmlFor="ai-candidate">候选内容{!active && <span>本机暂存，采纳后进入作品</span>}</label><textarea id="ai-candidate" aria-label="AI 候选内容" className="candidate-text" value={candidate} readOnly={!!active || !!selected.appliedVersion} onChange={(e) => { edited.current = true; setCandidate(e.target.value); void set(`shujian:candidate:${selected.id}`,e.target.value).catch(()=>setError('候选编辑未写入本机副本，请导出后再离开。')); }} rows={Math.min(18, Math.max(7, candidate.split('\n').length))} placeholder={active ? '正在等待模型回应……' : ''} />{!active && <details className="candidate-diff"><summary>查看与原稿的差异</summary><TextDiff before={oldText} after={candidate} /></details>}</> : latestReview ? <div className="review-report"><p className="field-help">{latestReview.stale || latestReview.sourceVersion !== chapter.version || dirty ? '这份检查已过期，请检查当前正文。' : '基于当前正文快照。语义疑点由你判断。'}</p>{latestReview.issues.length ? latestReview.issues.map((issue) => <article key={issue.id}><span className={`issue-severity ${issue.severity}`}>{issue.severity === 'warning' ? '疑点' : '建议'}</span><p>{issue.message}</p>{issue.quote && <blockquote>{issue.quote}</blockquote>}</article>) : <p>本次检查未报告问题。仍建议通读当前稿。</p>}</div> : selected.kind === 'extract' && selected.status === 'succeeded' ? <div className="extraction-ready"><Check size={23} /><p>资料建议已整理，等待你确认。</p><button className="button secondary compact" onClick={() => onStory()}>查看待确认资料<ArrowRight size={13} /></button></div> : <pre className="raw-result">{selected.output || '正在等待模型回应……'}</pre>}
        </> : <p className="panel-empty">尚未收到正文，已保存本次任务信息。</p>}
        <div className="job-actions">
          {active ? <button className="button secondary compact" disabled={busy} onClick={() => { void run(async () => { const result = await collaborationApi.cancelJob(selected.id); updateSelected(result.job); }); }}><Square size={12} />停止生成</button> : <>
            {candidateKind && selected.status === 'succeeded' && !selected.appliedVersion && <button className="button primary compact" disabled={busy || !canApply} onClick={() => { void run(adopt); }}><Check size={14} />{selected.kind === 'plan' || selected.kind === 'discuss' ? '采纳到本章计划' : selected.kind === 'revise' ? '采纳选区修改' : '采纳为正文'}</button>}
            {['failed', 'interrupted', 'cancelled'].includes(selected.status) && <button className="button secondary compact" disabled={busy} onClick={() => { void run(async () => { const result = await collaborationApi.retryJob(selected.id); edited.current = false; setJobId(result.job.id); updateSelected(result.job); }); }}><RefreshCw size={13} />重新尝试</button>}
          </>}
          {candidateKind && selected.status === 'succeeded' && ['plan','discuss'].includes(selected.kind) && <button className="text-button" onClick={() => onPlanning(candidate)}>整理到故事策划</button>}
          {candidateKind && selected.status==='succeeded' && ['discuss','plan'].includes(selected.kind) && <button className="text-button" onClick={()=>onStory(candidate)}>整理为人物或设定</button>}
          {selected.output && <button className="text-button" onClick={() => downloadText(candidateKind ? candidate : selected.output, `${taskLabels[selected.kind]}-${chapter.title}.txt`)}><Download size={13} />导出结果</button>}
          {selected.output && !active && selected.chapterId === chapter.id && ['draft', 'revise'].includes(selected.kind) && <button className="text-button" disabled={busy} onClick={() => void run(async () => { const saved = await onFlush(); onCreative({ id: crypto.randomUUID(), title: '从这次改稿留下的偏好', before: selected.output.slice(0, 6000), after: saved.plainText.slice(0, 6000), reason: '', condition: '', counterExample: '', status: 'pending', sourceJobId: selected.id, sourceChapterId: saved.id }); })}>记录作者改稿偏好</button>}
        </div>
        <details className="prompt-snapshot"><summary>创作方法与实际提示快照</summary>{selected.promptSnapshot ? <><p>档案 V{selected.promptSnapshot.creativity.profileVersion} · 提示摘要 {selected.promptSnapshot.hash.slice(0, 16)}</p>{selected.promptSnapshot.creativity.skills.length ? selected.promptSnapshot.creativity.skills.map((skill) => <p key={skill.id}>{skill.definition.title} · V{skill.version} · {skill.hash.slice(0, 16)}</p>) : <p>本次未使用额外创作方法。</p>}{selected.promptSnapshot.messages.map((message, index) => <details key={index}><summary>{message.role === 'system' ? '冻结任务规则' : '实际发送的材料'}</summary><pre>{message.content}</pre></details>)}</> : <p>旧版任务未保存完整提示快照；已有材料和原始结果仍保留，不推断其完整提示。</p>}<button className="text-button" onClick={() => void run(async () => downloadJson(await creativeApi.evaluationSample(selected), `创作评测样本-${selected.id}.json`))}>导出冻结评测样本</button></details>
        <details className="job-details"><summary>本次依据与用量</summary><dl><div><dt>正文版本</dt><dd>V{selected.inputVersion}</dd></div><div><dt>模型 / 提示版本</dt><dd>{selected.model} / {selected.promptVersion}</dd></div><div><dt>调用次数</dt><dd>{selected.usage.attempts}</dd></div><div><dt>Token · 输入 / 输出</dt><dd>{selected.usage.inputTokens ?? '未知'} / {selected.usage.outputTokens ?? '未知'}</dd></div><div><dt>估算费用</dt><dd>{selected.usage.estimatedCost === null ? '未知' : `$${selected.usage.estimatedCost.toFixed(6)} USD`}</dd></div></dl><p className="field-help">依据在请求发起时冻结。取消后服务商仍可能计费，费用以服务商账单为准。</p>{selected.priceSnapshot && <p className="field-help">计价依据：输入 {selected.priceSnapshot.inputPricePerMillion??'未知'} / 输出 {selected.priceSnapshot.outputPricePerMillion??'未知'} USD / 百万 Token。</p>}{calls.map((call)=><details className="call-record" key={call.id}><summary>第 {call.attempt} 次调用 · {stateLabels[call.status]}</summary><p>{call.model} · 输入 {call.inputTokens??'未知'} / 输出 {call.outputTokens??'未知'} Token · {call.estimatedCost===null?'费用未知':`$${call.estimatedCost.toFixed(6)} USD`}</p>{call.error&&<p>{call.error}</p>}{call.output&&<pre>{call.output}</pre>}{call.requestMessages&&<details className="prompt-snapshot"><summary>这次调用的实际提示 · {call.promptHash?.slice(0,12)}</summary>{call.requestMessages.map((message,index)=><pre key={index}>{message.role}{"\n"}{message.content}</pre>)}</details>}</details>)}<div className="context-manifest">{selected.context.map((item, index) => <details key={`${item.id}-${index}`}><summary>{item.label}{item.required && <small>必需</small>}</summary><p>{item.text}</p></details>)}</div></details>
      </div>}
    </div>
    {preview && previewInput && <ContextPreviewDialog preview={preview} busy={busy} error={previewError} onClose={() => setPreview(null)} onStart={() => void run(async () => { try { const saved = await onFlush(); if (saved.version !== previewInput.expectedVersion) throw new Error('保存稿已更新，请返回后重新预览。'); await submit({ ...previewInput, previewFingerprint: preview.fingerprint }); } catch (failure) { setPreviewError(errorMessage(failure)); throw failure; } })} />}
  </section>;
}

function TextDiff({ before, after }: { before: string; after: string }) {
  const left = before.split('\n'); const right = after.split('\n');
  if (before === after) return <p className="field-help">候选内容与原稿相同。</p>;
  if (left.length * right.length > 200000) return <div className="diff-lines"><p className="diff-legend">红色为原稿，绿色为候选</p><del>{before || '（原稿为空）'}</del><ins>{after}</ins></div>;
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) lengths[i]![j] = left[i] === right[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const lines: Array<{ kind: 'same' | 'remove' | 'add'; text: string }> = [];
  let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { lines.push({ kind: 'same', text: left[i]! }); i += 1; j += 1; }
    else if (j < right.length && (i === left.length || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)) { lines.push({ kind: 'add', text: right[j]! }); j += 1; }
    else { lines.push({ kind: 'remove', text: left[i]! }); i += 1; }
  }
  return <div className="diff-lines"><p className="diff-legend"><span>− 删去</span><span>＋ 新增</span></p>{lines.map((line, index) => line.kind === 'add' ? <ins key={index}>＋ {line.text || ' '}</ins> : line.kind === 'remove' ? <del key={index}>− {line.text || ' '}</del> : <p key={index}>{line.text || ' '}</p>)}</div>;
}
