import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, CheckCheck, ChevronDown, Circle, Download, FileText, History, ListTree, LoaderCircle, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { countWords, documentToText, type Book, type Chapter, type ChapterSummary, type TextSelection, type PreferenceExample } from '@shujian/contracts';
import { api, downloadText, downloadUrl, errorMessage } from '../lib/api';
import { useDraft } from '../hooks/useDraft';
import { formatRecoveryText } from '../lib/recovery';
import { ManuscriptEditor } from './ManuscriptEditor';
import { VersionDrawer } from './VersionDrawer';
import { BookForm } from './BookForm';
import { Dialog } from './Dialog';
import { AiAssistant,type AssistantRequest } from './AiAssistant';
import { ModelSettings } from './ModelSettings';
import { StoryLibrary } from './StoryLibrary';
import { PlanningDesk } from './PlanningDesk';
import { FinalizationDialog } from './FinalizationDialog';
import { collaborationApi } from '../lib/collaboration-api';
import { CreativeDesk } from './CreativeDesk';
import { AtlasDesk } from './AtlasDesk';
import type { AtlasLaunch } from '../lib/atlas-api';

export type NavigationGuard = (() => Promise<void>) | null;
interface Props { bookId: string; chapterId?: string; onBack: () => Promise<void>; onSelect: (bookId: string, chapterId: string) => Promise<void>; registerGuard: (guard: NavigationGuard) => void }
interface WorkspaceData { book: Book; chapters: ChapterSummary[]; chapter: Chapter }
const statusLabel = { draft: '草稿', final: '已定稿', revising: '修订中' };

export function Workbench({ bookId, chapterId, onBack, onSelect, registerGuard }: Props) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    void (async () => {
      try {
        const [{ book }, { chapters }] = await Promise.all([api.book(bookId), api.chapters(bookId)]);
        const selected = chapterId && chapters.some((entry) => entry.id === chapterId) ? chapterId : chapters[0]?.id;
        if (!selected) throw new Error('这部作品还没有章节，请重新打开作品。');
        const { chapter } = await api.chapter(selected);
        if (!cancelled) setData({ book, chapters, chapter });
      } catch (failure) { if (!cancelled) setError(errorMessage(failure)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [bookId, chapterId, reload]);
  const saved = useCallback((next: Chapter) => {
    setData((previous) => {
      if (!previous) return previous;
      const oldWords = previous.chapters.find((chapter) => chapter.id === next.id)?.wordCount ?? 0;
      return { ...previous, chapter: next, chapters: previous.chapters.map((chapter) => chapter.id === next.id ? next : chapter), book: { ...previous.book, wordCount: previous.book.wordCount - oldWords + next.wordCount, updatedAt: next.updatedAt } };
    });
  }, []);
  if (loading) return <div className="full-state" role="status"><span className="brand-seal">间</span><LoaderCircle className="spin" size={23} /><p>正在打开你的故事……</p></div>;
  if (error || !data) return <div className="full-state"><BookOpen size={35} strokeWidth={1} /><h2>暂时没能打开作品</h2><p role="alert">{error}</p><div className="inline-actions"><button className="button secondary" onClick={() => { void onBack(); }}>回到书架</button><button className="button primary" onClick={() => setReload((value) => value + 1)}><RefreshCw size={16} />重试</button></div></div>;
  return <EditorSession key={data.chapter.id} {...data} onSaved={saved} onBack={onBack} onSelect={onSelect} registerGuard={registerGuard} onBookUpdated={(book) => setData((previous) => previous ? { ...previous, book } : previous)} />;
}

interface SessionProps extends WorkspaceData { onSaved: (chapter: Chapter) => void; onBack: () => Promise<void>; onSelect: (bookId: string, chapterId: string) => Promise<void>; registerGuard: (guard: NavigationGuard) => void; onBookUpdated: (book: Book) => void }

function EditorSession({ book, chapters, chapter, onSaved, onBack, onSelect, registerGuard, onBookUpdated }: SessionProps) {
  const draftState = useDraft(chapter, onSaved);
  const { draft, status, error, flush, update, replace, setComposing } = draftState;
  const [planOpen, setPlanOpen] = useState(() => window.innerWidth > 1100);
  const [chapterMenu, setChapterMenu] = useState(false);
  const [focus, setFocus] = useState(false);
  const [versions, setVersions] = useState(false);
  const [bookForm, setBookForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serverPreview, setServerPreview] = useState<Chapter | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [rightTab, setRightTab] = useState<'plan' | 'ai'>('plan');
  const [modelSettings, setModelSettings] = useState(false);
  const [storyOpen, setStoryOpen] = useState(false);
  const [storySeed,setStorySeed]=useState<string|undefined>(undefined);
  const [storyRevision,setStoryRevision]=useState(0);
  const [creativeOpen, setCreativeOpen] = useState(false);
  const [atlasOpen,setAtlasOpen]=useState(false);
  const [creativeRevision, setCreativeRevision] = useState(0);
  const [preferenceSeed, setPreferenceSeed] = useState<PreferenceExample | null>(null);
  const [planningContent, setPlanningContent] = useState<string | null>(null);
  const [finalization,setFinalization]=useState<Chapter|null>(null);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [selectionTask,setSelectionTask]=useState<AssistantRequest|null>(null);
  const words = countWords(draftState.text);
  const disabled = busy || draftState.recoveryBusy || !draftState.ready || !!draftState.recovery;
  const displayStatus = status !== 'saved' && draft.status === 'final' ? 'revising' : draft.status;

  useEffect(() => { registerGuard(async () => { await flush(); }); return () => registerGuard(null); }, [registerGuard, flush]);
  useEffect(() => {
    const narrowViewport = window.matchMedia('(max-width: 1000px)');
    // A preview/dialog may be hosted by the AI panel; do not unmount it on resize.
    const closeOnNarrowViewport = () => { if (narrowViewport.matches && !document.querySelector('dialog[open]')) setPlanOpen(false); };
    closeOnNarrowViewport();
    narrowViewport.addEventListener('change', closeOnNarrowViewport);
    return () => narrowViewport.removeEventListener('change', closeOnNarrowViewport);
  }, []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void flush().catch(() => undefined); } if (event.key === 'Escape') setFocus(false); };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [flush]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setActionError(null); setNotice(null);
    try { await action(); } catch (failure) { setActionError(errorMessage(failure)); } finally { setBusy(false); }
  };
  const exportBook = (format: 'txt' | 'md') => { setExportOpen(false); void run(async () => { await flush(); await downloadUrl(`/api/books/${book.id}/export?format=${format}`, `${book.title}.${format}`); }); };
  const showServer = () => { void run(async () => { const response = await api.chapter(chapter.id); setServerPreview(response.chapter); }); };
  const prepareFinalization = async () => {
    const saved=await flush();
    const result=await collaborationApi.chapterJobs(chapter.id);
    if(result.jobs.some((job)=>job.chapterId===chapter.id)){setFinalization(saved);return;}
    const finalized=await api.finalize(chapter.id,draftState.getVersion());replace(finalized.chapter);setNotice('这一章已定稿。继续书写时，会保留这一稿。');
  };
  const recovery = draftState.recovery;
  const launchAtlasTask=(input:AtlasLaunch)=>void run(async()=>{await flush();setAtlasOpen(false);setSelection(null);setSelectionTask({...input,sequence:Date.now()});setRightTab('ai');setPlanOpen(true);setFocus(false);});
  return <div className={`workbench ${focus ? 'focus-mode' : ''} ${!planOpen ? 'plan-hidden' : ''} ${rightTab === 'ai' ? 'ai-open' : ''}`}>
    <header className="workbench-header"><div className="workbench-brand"><button className="icon-button back-library" aria-label="返回书架" onClick={() => { void run(onBack); }} disabled={busy}><ArrowLeft size={19} /></button><button className="icon-button mobile-chapters" aria-label="打开章节目录" onClick={() => setChapterMenu(true)} disabled={busy}><ListTree size={19} /></button><span className="brand-seal small">间</span><button className="book-title-button" onClick={() => setBookForm(true)} title="编辑作品设定">{book.title}<ChevronDown size={14} /></button><span className="header-divider" /><span className="chapter-breadcrumb">第 {draft.position} 章</span></div><div className="workbench-actions"><span className={`save-state ${status}`} role="status">{status === 'saving' ? <LoaderCircle size={13} className="spin" /> : status === 'saved' ? <CheckCheck size={14} /> : <Circle size={7} fill="currentColor" />}{status === 'saved' ? '已保存到本地' : status === 'saving' ? '正在保存' : status === 'conflict' ? '版本需要处理' : status === 'error' ? '尚未保存' : '等待保存'}</span><button className="text-button version-trigger" onClick={() => setVersions(true)} disabled={busy}><History size={16} />版本</button><div className="export-menu"><button className="text-button" aria-expanded={exportOpen} onClick={() => setExportOpen((value) => !value)} disabled={busy}><Download size={16} />导出<ChevronDown size={12} /></button>{exportOpen && <div className="dropdown-menu"><button onClick={() => exportBook('txt')}>纯文本 .txt</button><button onClick={() => exportBook('md')}>Markdown .md</button></div>}</div><button className="button primary compact" disabled={disabled || words === 0} onClick={() => { void run(prepareFinalization); }}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={16} />}定稿</button></div></header>
    <aside className="chapters-sidebar"><div className="sidebar-book"><span className="eyebrow">正在书写</span><h2>{book.title}</h2><p>{book.genre || '你的故事，自有天地'}<span>·</span>{chapters.length} 章</p></div><div className="sidebar-section-head"><span><ListTree size={15} />章节目录</span><button className="icon-button" aria-label="新增章节" disabled={busy} onClick={() => { void run(async () => { await flush(); const result = await api.createChapter(book.id); await onSelect(book.id, result.chapter.id); }); }}><Plus size={18} /></button></div><nav className="chapter-list" aria-label="章节目录">{chapters.map((entry) => <button key={entry.id} className={`chapter-item ${entry.id === chapter.id ? 'selected' : ''}`} aria-current={entry.id === chapter.id ? 'page' : undefined} disabled={busy} onClick={() => { void run(() => onSelect(book.id, entry.id)); }}><span className="chapter-number">{String(entry.position).padStart(2, '0')}</span><span className="chapter-item-main"><strong>{entry.title}</strong><small>{entry.wordCount.toLocaleString('zh-CN')} 字{entry.status === 'final' && <Check size={11} />}</small></span>{entry.id === chapter.id && <span className="active-chapter-dot" />}</button>)}</nav><button className="add-chapter" disabled={busy} onClick={() => { void run(async () => { await flush(); const result = await api.createChapter(book.id); await onSelect(book.id, result.chapter.id); }); }}><Plus size={16} />写下一章</button><div className="sidebar-bottom"><p>每一段文字，<br />都在靠近故事的远方。</p><span>书间 · 私人的写作房间</span></div></aside>
    <main className="writing-main">
      <div className="writing-topline"><span><FileText size={14} />正文<span className="status-pill">{statusLabel[displayStatus]}</span></span><div><button className="text-button" onClick={() => setAtlasOpen(true)}>设定与图谱</button><button className="text-button" onClick={() => setPlanningContent('')}>故事策划</button><button className="text-button" onClick={() => { setPreferenceSeed(null); setCreativeOpen(true); }}>文风与技能</button><button className="text-button" onClick={() => setStoryOpen(true)}>故事资料</button><button className="text-button" onClick={() => { setRightTab('ai'); setPlanOpen(true); setFocus(false); }}>AI 共创</button><button className="icon-button" aria-label={focus ? '退出专注模式' : '进入专注模式'} aria-pressed={focus} onClick={() => setFocus((value) => !value)}>{focus ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button><button className="icon-button" aria-label={planOpen ? '收起本章计划' : '展开本章计划'} aria-pressed={planOpen} onClick={() => { setRightTab('plan'); setPlanOpen((value) => !value); }}>{planOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button></div></div>
      {(error || actionError) && <div className="notice error editor-notice" role="alert"><p>{actionError ?? error}</p><div className="inline-actions">{status === 'conflict' ? <><button className="text-button" onClick={() => downloadText(formatRecoveryText(draft), `${draft.title}-本机未保存稿.txt`)}>导出本机稿</button><button className="text-button" onClick={showServer}>查看服务器稿</button></> : <button className="text-button" onClick={() => { void run(async () => { await flush(); }); }}>重试保存</button>}</div></div>}
      {draftState.recoveryWarning && <div className="notice warning editor-notice" role="alert">浏览器的应急副本暂时不可用。请保持页面打开，并确认顶部显示“已保存到本地”。</div>}
      {notice && <div className="notice success editor-notice" role="status"><p>{notice}</p><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={15} /></button></div>}
      {recovery && <div className="notice recovery-notice editor-notice" role="alert"><div style={{minWidth:0,flex:1}}><strong>{draftState.recoveries.length===1?'发现一份未完成保存的本机稿':`发现 ${draftState.recoveries.length} 份未完成保存的本机稿`}</strong><p>{recovery.baseVersion === draft.version ? '可以恢复选中的内容；其他页签的副本会分别保留。' : '保存版本已变化。为避免覆盖新稿，请先导出这份副本，再继续当前稿。'}</p>{draftState.recoveries.length>1&&<label style={{display:'block',marginTop:10}}>选择本机副本<select aria-label="选择本机恢复稿" style={{display:'block',width:'100%',maxWidth:'100%',marginTop:6}} disabled={draftState.recoveryBusy} value={recovery.sessionId} onChange={(event)=>draftState.selectRecovery(event.target.value)}>{draftState.recoveries.map((entry,index)=><option key={entry.sessionId} value={entry.sessionId}>{index+1}. {entry.legacy?'旧版副本':`页签 ${entry.sessionId.slice(0,8)}`} · {new Date(entry.updatedAt).toLocaleString('zh-CN',{hour12:false})} · {documentToText(entry.document).slice(0,24)}</option>)}</select></label>}<p>原稿版本 V{recovery.baseVersion} · {recovery.legacy?'旧版副本':`页签 ${recovery.sessionId.slice(0,8)}`} · {new Date(recovery.updatedAt).toLocaleString('zh-CN',{hour12:false})}</p><details><summary>查看选中副本的内容</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:180,overflow:'auto',font:'inherit'}}>{formatRecoveryText(recovery)}</pre></details><p>导出文本包含章节名称、本章意图和正文。</p></div><div className="inline-actions">{recovery.baseVersion === draft.version && <button className="button primary compact" disabled={draftState.recoveryBusy} onClick={()=>{void draftState.recover();}}>恢复本机稿</button>}<button className="text-button" disabled={draftState.recoveryBusy} onClick={() => { downloadText(formatRecoveryText(recovery), `${recovery.title}-本机副本.txt`); void draftState.dismissRecovery(); }}>导出副本并沿用已保存稿</button></div></div>}
      <div className="manuscript-scroll"><article className="manuscript-page" onCompositionStartCapture={() => setComposing(true)} onCompositionEndCapture={() => setComposing(false)}><div className="manuscript-chapter-label"><span />CHAPTER {String(draft.position).padStart(2, '0')}<span /></div><input className="chapter-title-input" aria-label="章节名称" value={draft.title} maxLength={160} disabled={disabled} onChange={(event) => update({ title: event.target.value })} placeholder="给这一章一个名字" />{draftState.ready && !recovery ? <ManuscriptEditor document={draft.document} disabled={disabled} onChange={(document) => update({ document })} onComposition={setComposing} onSelection={setSelection} onSelectionAction={(kind)=>{setSelectionTask({kind,sequence:Date.now()});setRightTab('ai');setPlanOpen(true);setFocus(false);}} /> : <div className="editor-loading">{recovery ? '请先处理上次未保存的副本，再继续写作。' : '正在检查本机草稿……'}</div>}<div className="manuscript-end"><span />间<span /></div></article></div>
      <footer className="writing-footer"><span>{words.toLocaleString('zh-CN')} 字<span className="footer-dot">·</span>约 {Math.max(1, Math.ceil(words / 500))} 分钟阅读</span><span>{status === 'saved' ? '所有改动已保存' : '请确认保存状态后离开'}<span className="footer-dot">·</span>UTF-8</span></footer>
    </main>
    {planOpen && rightTab === 'ai' && <aside className="plan-sidebar ai-sidebar"><div className="assistant-panel-tools"><button className="text-button" onClick={() => setRightTab('plan')}>← 本章计划</button><button className="icon-button" aria-label="关闭 AI 共创" onClick={() => setPlanOpen(false)}><X size={17} /></button></div><AiAssistant creativeRevision={creativeRevision} onCreative={(seed) => { setPreferenceSeed(seed ?? null); setCreativeOpen(true); }} storyRevision={storyRevision} requestedTask={selectionTask} chapter={draft} dirty={status !== 'saved'} selection={selection} onFlush={async () => { if (recovery || !draftState.ready) throw new Error('请先处理本机恢复副本。'); return flush(); }} onApply={async (job, text, target) => { setBusy(true); try { if (recovery) throw new Error('请先处理本机恢复副本。'); await flush(); const result = await collaborationApi.applyJob(job.id, { expectedVersion: draftState.getVersion(), text, target }); replace(result.chapter); setSelection(null); } finally { setBusy(false); } }} onSettings={() => setModelSettings(true)} onStory={(content)=>{setStorySeed(content);setStoryOpen(true);}} onPlanning={setPlanningContent} /></aside>}
    {planningContent !== null && <PlanningDesk chapter={draft} chapters={chapters} initialContent={planningContent} onClose={() => setPlanningContent(null)} />}
    {finalization && <FinalizationDialog chapter={finalization} onClose={()=>setFinalization(null)} onFinalize={async(ids)=>{const result=await api.finalize(chapter.id,finalization.version,ids);replace(result.chapter);setFinalization(null);setNotice('这一章已定稿。继续书写时，会保留这一稿。');}} />}
    {modelSettings && <ModelSettings onClose={() => setModelSettings(false)} />}
    {storyOpen && <StoryLibrary initialContent={storySeed} chapter={draft} chapters={chapters} onClose={() => {setStoryOpen(false);setStorySeed(undefined);setStoryRevision((value)=>value+1);}} onNavigate={(id) => onSelect(book.id, id)} />}
    {planOpen && rightTab === 'plan' && <aside className="plan-sidebar"><div className="plan-heading"><div className="plan-heading-top"><span className="eyebrow">BEFORE THE WORDS</span><button type="button" className="icon-button" aria-label="关闭本章计划" onClick={() => setPlanOpen(false)}><X size={17} /></button></div><h2>这一章，写什么</h2><p>给故事一个方向，给落笔留些自由。</p></div><label className="outline-field" htmlFor="chapter-outline">本章意图<textarea id="chapter-outline" value={draft.outline} disabled={disabled} maxLength={20000} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onChange={(event) => update({ outline: event.target.value })} placeholder={'这一章要发生什么？\n谁做出了选择？\n结尾留下什么变化？'} rows={12} /></label><div className="plan-divider" /><div className="story-seed"><div><span className="eyebrow">故事的种子</span><button className="icon-button" aria-label="编辑故事设定" onClick={() => setBookForm(true)}><Settings2 size={14} /></button></div><p>{book.premise || '最初想讲的那个故事，也可以在写作中慢慢清晰。'}</p></div><div className="plan-footnote"><span>给自己的一点提醒</span><p>人物做出的选择，<br />往往比发生的事情更重要。</p></div></aside>}
    {focus && <button className="focus-exit button secondary compact" onClick={() => setFocus(false)}><Minimize2 size={15} />退出专注<span>Esc</span></button>}
    {versions && <VersionDrawer chapterId={chapter.id} onClose={() => setVersions(false)} onCheckpoint={async (label) => { await flush(); await api.checkpoint(chapter.id, draftState.getVersion(), label || undefined); }} onRestore={async (revision) => { setBusy(true); try { await flush(); const result = await api.restore(chapter.id, draftState.getVersion(), revision.id); replace(result.chapter); setNotice('已恢复到选定版本，恢复前的稿件也已留存。'); } finally { setBusy(false); } }} />}
    {creativeOpen && <CreativeDesk bookId={book.id} preferenceSeed={preferenceSeed} onClose={() => { setCreativeOpen(false); setPreferenceSeed(null); }} onSaved={() => setCreativeRevision((version) => version + 1)} />}
    {atlasOpen&&<AtlasDesk bookId={book.id} bookTitle={book.title} chapter={draft} chapters={chapters} onClose={()=>setAtlasOpen(false)} onSaved={()=>setStoryRevision(value=>value+1)} onAction={launchAtlasTask} onNavigate={id=>{setAtlasOpen(false);void run(async()=>{await flush();await onSelect(book.id,id);});}} onLegacy={()=>{setAtlasOpen(false);setStoryOpen(true);}} onCreative={()=>{setAtlasOpen(false);setPreferenceSeed(null);setCreativeOpen(true);}} onPlanning={()=>{setAtlasOpen(false);setPlanningContent('');}}/>}
    {bookForm && <BookForm book={book} onClose={() => setBookForm(false)} onSubmit={async (input) => { const result = await api.updateBook(book.id, input); onBookUpdated(result.book); setBookForm(false); }} />}
    {chapterMenu && <Dialog title="章节目录" subtitle={book.title} onClose={() => setChapterMenu(false)} busy={busy}><nav className="mobile-chapter-list" aria-label="移动端章节目录">{chapters.map((entry) => <button className={entry.id === chapter.id ? 'selected' : ''} key={entry.id} disabled={busy} onClick={() => { void run(async () => { await onSelect(book.id, entry.id); setChapterMenu(false); }); }}><span>{String(entry.position).padStart(2, '0')}</span><strong>{entry.title}</strong><small>{entry.wordCount} 字</small></button>)}</nav>{actionError && <p className="notice error" role="alert">{actionError}</p>}<div className="dialog-footer"><button className="button primary" disabled={busy} onClick={() => { void run(async () => { await flush(); const result = await api.createChapter(book.id); await onSelect(book.id, result.chapter.id); setChapterMenu(false); }); }}><Plus size={17} />写下一章</button></div></Dialog>}
    {serverPreview && <Dialog title="两份稿件，都先留下" subtitle="服务器已有另一份更新。导出会保留本机章节名称、本章意图和正文（纯文本），再载入服务器稿。" onClose={() => setServerPreview(null)} wide><div className="conflict-columns"><section><span className="eyebrow">本机未保存稿</span><h3>{draft.title}</h3><div className="conflict-prose"><span>【本章意图】</span><p>{draft.outline || '（未填写）'}</p><span>【正文】</span><p>{draftState.text}</p></div></section><section><span className="eyebrow">服务器已保存稿 · V{serverPreview.version}</span><h3>{serverPreview.title}</h3><div className="conflict-prose"><span>【本章意图】</span><p>{serverPreview.outline || '（未填写）'}</p><span>【正文】</span><p>{serverPreview.plainText}</p></div></section></div><div className="dialog-footer"><button className="button quiet" onClick={() => setServerPreview(null)}>继续保留本机稿</button><button className="button primary" onClick={() => { downloadText(formatRecoveryText(draft), `${draft.title}-本机未保存稿.txt`); replace(serverPreview); setServerPreview(null); setActionError(null); }}>导出本机稿并载入服务器稿<ArrowRight size={16} /></button></div></Dialog>}
  </div>;
}


