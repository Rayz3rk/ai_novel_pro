import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, BookOpen, Check, History, LoaderCircle, Plus, Search, X } from 'lucide-react';
import { documentToText, type Chapter, type ChapterSummary, type DocumentRevision, type SaveStoryEntryInput, type StoryAuthority, type StoryEntry, type StoryEntryKind, type StoryEvidence, type StoryImpact, type StoryProposal, type StoryVisibility, type StorySourceHit } from '@shujian/contracts';
import { api, request, errorMessage } from '../lib/api';
import { collaborationApi, type EvidenceParagraph } from '../lib/collaboration-api';
import { Dialog } from './Dialog';

const kinds: Record<StoryEntryKind, string> = { character: '人物', rule: '世界规则', event: '事件', item: '物品', foreshadow: '伏笔', plan: '剧情计划', location:'地点', organization:'组织', scene:'剧情场景', note:'构思便签' };
const authorities: Record<StoryAuthority, string> = { setting: '作者设定', fact: '正文事实', plan: '未来规划' };
const visibilities: Record<StoryVisibility, string> = { public: '公开信息', author: '仅作者知道', characters: '指定人物知情' };
interface Props { chapter: Chapter; chapters: ChapterSummary[]; onClose: () => void; onNavigate: (chapterId: string) => Promise<void>; initialContent?:string }

export function StoryLibrary({ chapter, chapters, onClose, onNavigate, initialContent }: Props) {
  const [tab, setTab] = useState<'entries' | 'proposals' | 'impacts' | 'sources'>('entries');
  const [sourceQuery,setSourceQuery]=useState('');
  const [sourceHits,setSourceHits]=useState<StorySourceHit[]>([]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [entries, setEntries] = useState<StoryEntry[]>([]);
  const [proposals, setProposals] = useState<StoryProposal[]>([]);
  const [impacts, setImpacts] = useState<StoryImpact[]>([]);
  const [coverage, setCoverage] = useState({ finalizedChapters: 0, withEvidence: 0, pendingProposals: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StoryEntry | 'new' | null>(null);
  const [seedContent,setSeedContent]=useState(initialContent);
  useEffect(()=>{if(initialContent)setEditing('new');},[initialContent]);
  const [evidence, setEvidence] = useState<{ revision: DocumentRevision; quote: string; paragraphId: string } | null>(null);
  const [history, setHistory] = useState<{ title: string; events: Array<{ id: string; action: string; version: number; entry: StoryEntry; createdAt: string }> } | null>(null);
  const [includeWithdrawn, setIncludeWithdrawn] = useState(false);
  useEffect(()=>{let live=true;const timer=window.setTimeout(()=>{void request<{sources:StorySourceHit[]}>(`/books/${chapter.bookId}/sources?q=${encodeURIComponent(sourceQuery)}`).then((result)=>{if(live)setSourceHits(result.sources);}).catch((failure)=>{if(live)setError(errorMessage(failure));});},150);return()=>{live=false;window.clearTimeout(timer);};},[chapter.bookId,sourceQuery]);
  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (kind) params.set('kind', kind);
    params.set('includeWithdrawn', 'true');
    const [story, proposalResult, impactResult] = await Promise.all([collaborationApi.story(chapter.bookId, `?${params}`), collaborationApi.proposals(chapter.bookId), collaborationApi.impacts(chapter.bookId)]);
    setEntries(story.entries); setCoverage(story.coverage); setProposals(proposalResult.proposals); setImpacts(impactResult.impacts);
  }, [chapter.bookId, query, kind]);
  useEffect(() => {
    let live = true; setLoading(true);
    const timer = window.setTimeout(() => { void refresh().catch((failure) => { if (live) setError(errorMessage(failure)); }).finally(() => { if (live) setLoading(false); }); }, 150);
    return () => { live = false; window.clearTimeout(timer); };
  }, [refresh]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(null); try { await action(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } };
  const showEvidence = (source: StoryEvidence) => { void run(async () => { const result = await api.version(source.chapterId, source.revisionId); setEvidence({ revision: result.version, quote: source.quote, paragraphId: source.paragraphId }); }); };
  const pending = proposals.filter((proposal) => proposal.state === 'pending');
  const shown = entries.filter((entry) => includeWithdrawn || entry.status === 'confirmed');
  return <Dialog title="故事资料" subtitle="设定、规划与正文事实各有出处。候选建议经你确认后，才参与创作。" onClose={onClose} wide busy={busy}>
    <div className="story-library">
      <div className="story-nav" role="tablist" aria-label="故事资料分类"><button role="tab" aria-selected={tab === 'sources'} onClick={() => setTab('sources')}>原文回查</button><button role="tab" aria-selected={tab === 'entries'} onClick={() => setTab('entries')}>已确认资料<span>{entries.filter((entry) => entry.status === 'confirmed').length}</span></button><button role="tab" aria-selected={tab === 'proposals'} onClick={() => setTab('proposals')}>待确认<span>{pending.length}</span></button><button role="tab" aria-selected={tab === 'impacts'} onClick={() => setTab('impacts')}>修改影响<span>{impacts.length}</span></button></div>
      <div className="story-coverage"><BookOpen size={15} /><span>{coverage.finalizedChapters} 章已定稿 · {coverage.withEvidence} 章有事实依据 · {coverage.pendingProposals} 条待确认建议</span></div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {tab === 'entries' && <><div className="story-search"><label><Search size={16} /><input aria-label="搜索故事资料" placeholder="姓名、别名、物品或关键词……" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="资料类型" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">全部类型</option>{(Object.entries(kinds) as Array<[StoryEntryKind, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="button primary compact" disabled={busy} onClick={() => setEditing('new')}><Plus size={14} />新增资料</button></div><label className="checkbox-field story-withdrawn-filter"><input type="checkbox" checked={includeWithdrawn} onChange={(e) => setIncludeWithdrawn(e.target.checked)} />显示已撤回资料</label>
        {loading ? <p className="panel-empty"><LoaderCircle size={17} className="spin" />正在查阅资料……</p> : shown.length ? <div className="story-entry-grid">{shown.map((entry) => <article className={`story-entry ${entry.status === 'withdrawn' ? 'withdrawn' : ''}`} key={entry.id}><div className="story-entry-meta"><span>{kinds[entry.kind]}</span><span className={`authority ${entry.authority}`}>{authorities[entry.authority]}</span>{entry.needsReview && <span className="needs-review">待复核</span>}{entry.status === 'withdrawn' && <span>已撤回</span>}</div><h3>{entry.title}</h3>{entry.aliases.length > 0 && <p className="story-aliases">别名：{entry.aliases.join('、')}</p>}<p className="story-content">{entry.content}</p><dl className="story-entry-details"><div><dt>知情范围</dt><dd>{visibilities[entry.visibility]}{entry.knownBy.length > 0 ? ` · ${entry.knownBy.join('、')}` : ''}</dd></div><div><dt>故事时间</dt><dd>{entry.storyTime || '尚未确定'}{entry.narrative === 'flashback' && ' · 回忆叙述'}</dd></div><div><dt>{entry.authority === 'plan' ? '预计回收' : '开始适用'}</dt><dd>{entry.authority === 'plan' ? entry.plannedPayoff ? `第 ${entry.plannedPayoff} 章` : '尚未确定' : `第 ${entry.validFromChapter} 章`}</dd></div></dl>{entry.evidence.length > 0 && <div className="entry-evidence">{entry.evidence.map((source, index) => <button className="text-button" key={`${source.revisionId}-${index}`} disabled={busy} onClick={() => showEvidence(source)}>查看原文 · {chapters.find((item) => item.id === source.chapterId)?.title ?? '来源章节'}<ArrowUpRight size={12} /></button>)}</div>}<div className="story-entry-actions"><button className="text-button" disabled={busy} onClick={() => setEditing(entry)}>编辑{entry.status === 'withdrawn' ? '并重新确认' : ''}</button><button className="text-button" disabled={busy} onClick={() => { void run(async () => { const result = await collaborationApi.history(entry.id); setHistory({ title: entry.title, events: result.events }); }); }}><History size={12} />记录</button>{entry.status !== 'withdrawn' && <button className="text-button withdraw-button" disabled={busy} onClick={() => { void run(async () => { await collaborationApi.withdrawStory(entry.id, entry.version); await refresh(); }); }}>撤回</button>}</div></article>)}</div> : <div className="story-empty"><BookOpen size={32} strokeWidth={1} /><h3>{query ? '暂时没有找到相关资料' : '世界可以从一个人物开始。'}</h3><p>{query ? '试试姓名、别名或更短的关键词。' : '先记下确认的人物和规则，后续从定稿中整理事实。'}</p></div>}
      </>}
      {tab === 'sources' && <section className="source-search-panel"><label className="search-field"><Search size={16}/><input aria-label="搜索已定稿原文" value={sourceQuery} placeholder="输入人物、物品或原文关键词……" onChange={(event)=>setSourceQuery(event.target.value)}/></label><p className="field-help">只回查当前采用的定稿；结果可打开当时正文。输入两字姓名也可查找。</p>{sourceHits.length?sourceHits.map((hit)=><article className="story-entry" key={hit.revisionId+hit.paragraphId}><span className="eyebrow">第 {hit.position} 章 · {hit.title}</span><p className="story-content">{hit.text}</p><button className="text-button" onClick={()=>showEvidence({chapterId:hit.chapterId,revisionId:hit.revisionId,paragraphId:hit.paragraphId,quote:hit.text,hash:hit.hash})}>打开原文出处<ArrowUpRight size={12}/></button></article>):<p className="panel-empty">{sourceQuery?'没有找到匹配原文，试试更短的关键词。':'输入关键词，回查整个故事。'}</p>}</section>}
      {tab === 'proposals' && <div className="story-proposals">{pending.length ? pending.map((proposal) => <article className="story-entry" key={proposal.id}><div className="story-entry-meta"><span>{kinds[proposal.entry.kind]}</span><span>{authorities[proposal.entry.authority]}</span>{proposal.stale && <span className="needs-review">来源已变化</span>}</div><h3>{proposal.entry.title}</h3><p className="story-content">{proposal.entry.content}</p>{proposal.entry.evidence?.map((source, index) => <button className="evidence-quote" key={index} disabled={busy} onClick={() => showEvidence(source)}>“{source.quote}”<ArrowUpRight size={12} /></button>)}<p className="field-help">{proposal.stale ? '来源正文已经变化，请重新整理当前稿。' : proposal.requiresFinalization ? '此建议来自未定稿快照，请在本章定稿窗口中确认。' : '采纳后将作为确认资料参与后续创作。'}</p><div className="story-entry-actions"><button className="button primary compact" disabled={busy || proposal.stale || proposal.requiresFinalization} onClick={() => { void run(async () => { await collaborationApi.acceptProposal(proposal.id); await refresh(); }); }}><Check size={13} />确认采纳</button><button className="text-button" disabled={busy} onClick={() => { void run(async () => { await collaborationApi.rejectProposal(proposal.id); await refresh(); }); }}>暂不采用</button></div></article>) : <div className="story-empty"><Check size={30} strokeWidth={1} /><h3>没有等待确认的建议</h3><p>章节定稿后，在 AI 助手中选择“整理资料”。</p></div>}</div>}
      {tab === 'impacts' && <div className="story-impacts"><p className="field-help">新定稿替换旧定稿后，相关证据和使用过它的后文章节会出现在这里。影响提示供你复核，后文由你决定如何改。</p>{impacts.length ? impacts.map((impact, index) => <article className="story-entry" key={`${impact.entryId}-${index}`}><span className="needs-review">需要复核</span><h3>{impact.title}</h3><p className="story-content">{impact.reason}</p><div className="inline-actions">{impact.chapterIds.map((id) => <button className="text-button" key={id} disabled={busy} onClick={() => { void run(async () => { await onNavigate(id); onClose(); }); }}>{chapters.find((item) => item.id === id)?.title ?? '相关章节'}<ArrowUpRight size={12} /></button>)}</div></article>) : <p className="panel-empty">目前没有已记录的修改影响。</p>}</div>}
    </div>
    {editing && <StoryEntryForm chapter={chapter} initialContent={editing==='new'?seedContent:undefined} entry={editing === 'new' ? undefined : editing} onClose={() => {setEditing(null);setSeedContent(undefined);}} onSave={async (input) => { if (editing === 'new') await collaborationApi.createStory(chapter.bookId, input); else await collaborationApi.updateStory(editing.id, input); setEditing(null); setSeedContent(undefined); await refresh(); }} />}
    {evidence && <Dialog title="资料的原文出处" subtitle={`${evidence.revision.title} · ${evidence.revision.label} · V${evidence.revision.sourceVersion}`} onClose={() => setEvidence(null)} wide><div className="source-preview"><span className="eyebrow">引用摘录</span><blockquote>{evidence.quote}</blockquote><details open><summary>查看当时的完整正文</summary><div>{documentToText(evidence.revision.document)}</div></details><p className="field-help">段落锚点：{evidence.paragraphId}。这里展示的是不可变历史版本。</p></div></Dialog>}
    {history && <Dialog title={`${history.title} · 确认记录`} onClose={() => setHistory(null)}><div className="entry-history">{history.events.map((event) => <article key={event.id}><span>V{event.version} · {event.action} · {new Date(event.createdAt).toLocaleString('zh-CN')}</span><h3>{event.entry.title}</h3><p>{event.entry.content}</p></article>)}</div></Dialog>}
  </Dialog>;
}

function StoryEntryForm({ chapter, entry, onClose, onSave,initialContent }: { chapter: Chapter; entry?: StoryEntry; onClose: () => void; onSave: (input: SaveStoryEntryInput) => Promise<void>; initialContent?:string }) {
  const [kind, setKind] = useState<StoryEntryKind>(entry?.kind ?? 'character');
  const [authority, setAuthority] = useState<StoryAuthority>(entry?.authority ?? 'setting');
  const [title, setTitle] = useState(entry?.title ?? '');
  const [content, setContent] = useState(entry?.content ?? initialContent ?? '');
  const [aliases, setAliases] = useState(entry?.aliases.join('、') ?? '');
  const [visibility, setVisibility] = useState<StoryVisibility>(entry?.visibility ?? 'public');
  const [knownBy, setKnownBy] = useState(entry?.knownBy.join('、') ?? '');
  const [storyTime, setStoryTime] = useState(entry?.storyTime ?? '');
  const [narrative, setNarrative] = useState<StoryEntry['narrative']>(entry?.narrative ?? 'unknown');
  const [validFrom, setValidFrom] = useState(entry?.validFromChapter ?? 1);
  const [payoff, setPayoff] = useState<number | ''>(entry?.plannedPayoff ?? '');
  const [sources, setSources] = useState<StoryEvidence[]>(entry?.evidence ?? []);
  const [paragraphs, setParagraphs] = useState<EvidenceParagraph[]>([]);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let live = true; void collaborationApi.evidence(chapter.id).then((result) => { if (live) { setParagraphs(result.paragraphs); setRevisionId(result.revisionId); } }).catch((failure) => { if (live) setError(errorMessage(failure)); }); return () => { live = false; }; }, [chapter.id]);
  const split = (value: string) => value.split(/[、,，;；\n]/).map((item) => item.trim()).filter(Boolean);
  const addSource = (paragraph: EvidenceParagraph) => {
    if (!revisionId) return;
    const existing = sources.find((source) => source.revisionId === revisionId && source.paragraphId === paragraph.paragraphId);
    if (existing) setSources((old) => old.filter((source) => source !== existing));
    else setSources((old) => [...old, { chapterId: chapter.id, revisionId, paragraphId: paragraph.paragraphId, quote: paragraph.text, hash: paragraph.hash }]);
  };
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (!title.trim() || !content.trim()) throw new Error('请填写资料名称和内容。');
      if (authority === 'fact' && !sources.length) throw new Error('正文事实需要至少一段定稿原文作为依据。');
      await onSave({ kind, authority, title: title.trim(), content: content.trim(), aliases: split(aliases), visibility, knownBy: visibility === 'characters' ? split(knownBy) : [], storyTime: storyTime.trim(), narrative, validFromChapter: validFrom, plannedPayoff: payoff === '' ? null : payoff, evidence: sources, ...(entry ? { expectedVersion: entry.version } : {}) });
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  return <Dialog title={entry ? '修改故事资料' : '新增故事资料'} subtitle="只记录你已经确认的内容，不确定的情节可以先放进规划。" onClose={onClose} busy={busy} wide><div className="story-entry-form">
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="model-grid"><label>资料类型<select aria-label="新增资料类型" value={kind} onChange={(e) => { setKind(e.target.value as StoryEntryKind); if (e.target.value === 'plan') setAuthority('plan'); }}>{(Object.entries(kinds) as Array<[StoryEntryKind, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>内容依据<select aria-label="内容依据" value={authority} onChange={(e) => setAuthority(e.target.value as StoryAuthority)}>{(Object.entries(authorities) as Array<[StoryAuthority, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <label>名称<input aria-label="资料名称" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label><label>确认的内容<textarea aria-label="资料内容" value={content} maxLength={20000} rows={5} onChange={(e) => setContent(e.target.value)} /></label><label>别名<input aria-label="资料别名" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="用顿号分隔" /></label>
    <div className="model-grid"><label>知情范围<select aria-label="知情范围" value={visibility} onChange={(e) => setVisibility(e.target.value as StoryVisibility)}>{(Object.entries(visibilities) as Array<[StoryVisibility, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{visibility === 'characters' && <label>知情人物<input aria-label="知情人物" value={knownBy} placeholder="用顿号分隔" onChange={(e) => setKnownBy(e.target.value)} /></label>}<label>从第几章起适用<input aria-label="开始适用章节" type="number" min="1" value={validFrom} onChange={(e) => setValidFrom(Number(e.target.value))} /></label><label>故事时间<input aria-label="故事时间" value={storyTime} placeholder="可留空，如三年前的冬天" onChange={(e) => setStoryTime(e.target.value)} /></label><label>叙述类型<select aria-label="叙述类型" value={narrative} onChange={(e) => setNarrative(e.target.value as StoryEntry['narrative'])}><option value="unknown">未确定</option><option value="normal">当前叙事</option><option value="flashback">回忆 / 倒叙</option></select></label>{(kind === 'foreshadow' || authority === 'plan') && <label>计划第几章回收<input aria-label="计划回收章节" type="number" min="1" value={payoff} placeholder="未确定" onChange={(e) => setPayoff(e.target.value === '' ? '' : Number(e.target.value))} /></label>}</div>
    <details className="evidence-selector" open={authority === 'fact'}><summary>原文依据{authority === 'fact' ? '（必选）' : '（可选）'} · 已选 {sources.length} 段</summary>{sources.length > 0 && <div className="selected-sources">{sources.map((source, index) => <div key={`${source.revisionId}-${index}`}><p>{source.quote}</p><button className="icon-button" aria-label={`移除第${index + 1}段依据`} onClick={() => setSources((old) => old.filter((_, item) => item !== index))}><X size={13} /></button></div>)}</div>}<p className="field-help">从当前章的定稿里选择。修改草稿不会改变已确认事实；替换定稿后需要复核。</p>{paragraphs.length ? <div className="evidence-paragraphs">{paragraphs.map((paragraph) => <label key={paragraph.paragraphId}><input type="checkbox" checked={sources.some((source) => source.revisionId === revisionId && source.paragraphId === paragraph.paragraphId)} onChange={() => addSource(paragraph)} /><span>{paragraph.text}</span></label>)}</div> : <p className="field-help">本章还没有可引用的定稿段落。先保存并定稿，再整理正文事实。</p>}</details>
  </div><div className="dialog-footer"><button className="button quiet" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || !title.trim() || !content.trim()} onClick={() => { void submit(); }}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}确认保存</button></div></Dialog>;
}
