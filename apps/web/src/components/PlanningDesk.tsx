import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Plus } from 'lucide-react';
import type { Chapter, ChapterSummary, PlanNode, SavePlanInput } from '@shujian/contracts';
import { request, errorMessage } from '../lib/api';
import { Dialog } from './Dialog';

const levels = { book: '全书方向', arc: '分卷 / 故事弧', chapter: '章节规划', scene: '场景' };
interface Props { chapter: Chapter; chapters: ChapterSummary[]; initialContent?: string; onClose: () => void }

export function PlanningDesk({ chapter, chapters, initialContent, onClose }: Props) {
  const [nodes, setNodes] = useState<PlanNode[]>([]);
  const [selected, setSelected] = useState<PlanNode | null>(null);
  const [level, setLevel] = useState<PlanNode['level']>('chapter');
  const [title, setTitle] = useState(initialContent ? `${chapter.title} · 讨论整理` : '');
  const [content, setContent] = useState(initialContent ?? '');
  const [parentId, setParentId] = useState('');
  const [chapterId, setChapterId] = useState(chapter.id);
  const [position, setPosition] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const refresh = async () => { const result = await request<{plans:PlanNode[]}>(`/books/${chapter.bookId}/plans`); setNodes(result.plans); };
  useEffect(() => { void refresh().catch((failure) => setError(errorMessage(failure))); }, [chapter.bookId]);
  const edit = (node:PlanNode) => { setSelected(node); setLevel(node.level); setTitle(node.title); setContent(node.content); setParentId(node.parentId ?? ''); setChapterId(node.chapterId ?? ''); setPosition(node.position); setNotice(''); };
  const fresh = () => { setSelected(null); setTitle(''); setContent(''); setParentId(''); setLevel('chapter'); setChapterId(chapter.id); setPosition(nodes.length + 1); setNotice(''); };
  const parents = nodes.filter((node) => node.id !== selected?.id && ({ book: [], arc: ['book'], chapter: ['book','arc'], scene: ['chapter'] } as Record<PlanNode['level'],string[]>)[level].includes(node.level));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const input:SavePlanInput={level,title:title.trim(),content,parentId:parentId||null,chapterId:level==='book'?null:chapterId||null,position,...(selected?{expectedVersion:selected.version}:{})};
      const result=await request<{plan:PlanNode}>(selected?`/plans/${selected.id}`:`/books/${chapter.bookId}/plans`,input,selected?'PUT':'POST');
      await refresh(); setSelected(result.plan); setNotice('已确认这份规划。它会作为未来意图参与相关章节，不会成为已发生事实。');
    }catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}
  };
  const depth = (node:PlanNode):number => { let current=node; let value=0; const seen=new Set<string>(); while(current.parentId&&!seen.has(current.id)){seen.add(current.id);const parent=nodes.find((entry)=>entry.id===current.parentId);if(!parent)break;current=parent;value++;}return Math.min(value,3); };
  const ordered:PlanNode[]=[];const append=(parent:string|null)=>{for(const node of nodes.filter((entry)=>entry.parentId===parent)){ordered.push(node);append(node.id);}};append(null);
  return <Dialog title="故事策划" subtitle="先定近期方向；全书、分卷与场景可以边写边补。这里保存的是作者确认的未来意图。" onClose={onClose} wide busy={busy}>
    <div className="planning-desk"><nav aria-label="剧情规划目录"><div className="planning-nav-head"><span>故事的路线</span><button className="icon-button" aria-label="新增剧情规划" onClick={fresh} disabled={busy}><Plus size={17}/></button></div>{ordered.length?ordered.map((node)=><button key={node.id} className={selected?.id===node.id?'selected':''} style={{paddingLeft:12+depth(node)*14}} onClick={()=>edit(node)} disabled={busy}><small>{levels[node.level]}</small><strong>{node.title}</strong><span>{chapters.find((entry)=>entry.id===node.chapterId)?.title ?? (node.level==='book'?'整部作品':'暂未关联章节')}</span></button>):<p className="field-help">不必一次想好全书。<br/>从当前章，或一条故事方向开始。</p>}</nav>
      <section className="planning-editor"><div className="planning-editor-head"><span className="eyebrow">{selected?`已确认规划 · V${selected.version}`:'一份新的规划'}</span><button className="text-button" onClick={fresh} disabled={busy}><Plus size={13}/>另起一份</button></div>
        {error&&<p className="notice error" role="alert">{error}</p>}{notice&&<p className="notice success" role="status">{notice}</p>}
        <div className="model-grid"><label>规划层级<select aria-label="规划层级" value={level} onChange={(event)=>{setLevel(event.target.value as PlanNode['level']);setParentId('');}}>{Object.entries(levels).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label><label>上级规划<select aria-label="上级规划" value={parentId} onChange={(event)=>setParentId(event.target.value)}><option value="">{level==='scene'?'请选择章节规划':'独立规划'}</option>{parents.map((node)=><option value={node.id} key={node.id}>{node.title}</option>)}</select></label></div>
        <label>规划名称<input aria-label="规划名称" value={title} maxLength={200} onChange={(event)=>setTitle(event.target.value)}/></label><label>希望发生什么<textarea aria-label="规划内容" rows={10} value={content} maxLength={20000} placeholder="人物选择、主要冲突、必须保留的内容、结尾方向……" onChange={(event)=>setContent(event.target.value)}/></label>
        <div className="model-grid"><label>关联章节<select aria-label="规划关联章节" value={level==='book'?'':chapterId} disabled={level==='book'} onChange={(event)=>setChapterId(event.target.value)}><option value="">尚未确定 / 整体方向</option>{chapters.map((entry)=><option value={entry.id} key={entry.id}>{entry.title}</option>)}</select></label><label>排列顺序<input aria-label="规划排列顺序" type="number" min="1" value={position} onChange={(event)=>setPosition(Number(event.target.value))}/></label></div><div className="planning-save"><button className="button primary" disabled={busy||!title.trim()} onClick={()=>{void save();}}>{busy?<LoaderCircle className="spin" size={15}/>:<Check size={15}/>}确认规划</button></div>
      </section>
    </div>
  </Dialog>;
}
