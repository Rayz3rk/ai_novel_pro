import { useEffect, useRef, useState } from 'react';
import type { AiJob, Chapter, ChapterSummary, ContextPreview, SaveStoryEntryInput, StoryEvidence, StoryEntryKind } from '@shujian/contracts';
import { request, errorMessage } from '../lib/api';
import { Dialog } from './Dialog';

interface Plan { chapters: Array<ChapterSummary & {applied:boolean}>; jobs: AiJob[] }
interface Result {
  jobId:string;fingerprint:string;applied:boolean;chapter:Chapter;
  entries:Array<{key:string;entry:SaveStoryEntryInput;matches:Array<{id:string;title:string;content:string}>}>;
  relations:Array<{fromKey:string;toKey:string;label:string;description:string;evidence:StoryEvidence[]}>;
  states:Array<{nodeKey:string;summary:string;changes:Record<string,string>;evidence:StoryEvidence[]}>;
  existingNodes:Array<{id:string;title:string;kind:StoryEntryKind;content:string;needsReview:boolean}>;
  existingRelations:Array<{fromId:string;toId:string;label:string;description:string}>;existingStates:Array<{nodeId:string;summary:string}>;
}
const active=(job:AiJob)=>job.status==='queued'||job.status==='running';
export function BackfillDesk({bookId,onClose,onSaved}:{bookId:string;onClose:()=>void;onSaved:()=>void}){
  const [plan,setPlan]=useState<Plan|null>(null),[selected,setSelected]=useState<string[]>([]),[previews,setPreviews]=useState<Array<{chapterId:string;preview:ContextPreview}>>([]);
  const [result,setResult]=useState<Result|null>(null),[mapping,setMapping]=useState<Record<string,string|null>>({}),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState('');
  const stopping=useRef(false),runningId=useRef<string|null>(null);
  const refresh=async()=>{const next=await request<Plan>(`/books/${bookId}/backfill`);setPlan(next);return next;};
  useEffect(()=>{let live=true;void request<Plan>(`/books/${bookId}/backfill`).then(next=>{if(live){setPlan(next);setSelected(next.chapters.filter(chapter=>chapter.finalizedRevisionId&&!chapter.applied).map(chapter=>chapter.id));}}).catch(failure=>{if(live)setError(errorMessage(failure));});return()=>{live=false;};},[bookId]);
  const run=async(action:()=>Promise<void>)=>{setBusy(true);setError(null);try{await action();}catch(failure){setError(errorMessage(failure));}finally{setBusy(false);runningId.current=null;}};
  const show=async(id:string)=>{const next=await request<Result>(`/jobs/${id}/backfill`);setResult(next);setMapping(Object.fromEntries(next.entries.map(item=>[item.key,item.matches.length===1?item.matches[0]!.id:item.matches.length>1?'':null])));};
  const analyze=async()=>{
    stopping.current=false;
    for(const item of previews){
      if(stopping.current)break;
      const chapter=plan?.chapters.find(chapter=>chapter.id===item.chapterId);
      setNotice(`正在分析：${chapter?.title??''}。分析结果需单独确认回填。`);
      const existing=plan?.jobs.find(job=>job.chapterId===item.chapterId&&job.context.some(source=>source.id==='chapter'&&source.revisionId===chapter?.finalizedRevisionId));
      let job:AiJob;
      if(existing&&existing.status==='succeeded')job=existing;
      else if(existing&&active(existing))job=existing;
      else if(existing)job=(await request<{job:AiJob}>(`/jobs/${existing.id}/retry`,{},'POST')).job;
      else job=(await request<{job:AiJob}>(`/chapters/${item.chapterId}/backfill/start`,{fingerprint:item.preview.fingerprint},'POST')).job;
      runningId.current=job.id;
      while(active(job)&&!stopping.current){await new Promise(resolve=>setTimeout(resolve,500));job=(await request<{job:AiJob}>(`/jobs/${job.id}`)).job;}
      await refresh();
      if(stopping.current)break;
      if(job.status!=='succeeded')throw new Error(`${chapter?.title}：${job.error??'任务未完成，请重试。'}`);
    }
    setPreviews([]);setNotice(stopping.current?'已停止批量分析，已完成结果保留。':'分析完成。请逐章查看差异并确认回填。');
  };
  const sources=(items:StoryEvidence[])=><details><summary>原文证据（{items.length}）</summary>{items.map((source,index)=><blockquote key={index}>{source.quote}<small> · 第 {result?.chapter.position} 章 · {source.paragraphId}</small></blockquote>)}</details>;
  return <Dialog title="从正文回填知识与图谱" subtitle="按章分析定稿，匹配已有资料；查看差异后确认。分析会调用模型，确认回填不会再次调用。" onClose={onClose} busy={busy} wide><div className="maintenance-body">
    {error&&<p className="notice error" role="alert">{error}<button className="text-button" disabled={busy} onClick={()=>void run(async()=>{await refresh();if(result)await show(result.jobId);})}>刷新重试</button></p>}
    {notice&&<p role="status">{notice}</p>}
    <div className="inline-actions"><button className="text-button" disabled={busy} onClick={()=>{setSelected(plan?.chapters.filter(chapter=>chapter.finalizedRevisionId&&!chapter.applied).map(chapter=>chapter.id)??[]);setPreviews([]);}}>选择尚未回填或定稿已更新章节</button></div>
    <ul className="reference-list">{plan?.chapters.map(chapter=><li key={chapter.id}><label><input type="checkbox" aria-label={`分析${chapter.title}`} disabled={busy||!chapter.finalizedRevisionId} checked={selected.includes(chapter.id)} onChange={event=>{setSelected(ids=>event.target.checked?[...ids,chapter.id]:ids.filter(id=>id!==chapter.id));setPreviews([]);}}/> 第 {chapter.position} 章 · {chapter.title} · {!chapter.finalizedRevisionId?'请先定稿':chapter.applied?'本次定稿已回填':'待分析 / 待确认'}{chapter.status==='revising'?'（有未定稿修改，本次使用上次定稿）':''}</label></li>)}</ul>
    <button className="button secondary" disabled={busy||!selected.length} onClick={()=>void run(async()=>{const next=[];for(const chapterId of selected){const value=await request<{preview:ContextPreview}>(`/chapters/${chapterId}/backfill/preview`,{},'POST');next.push({chapterId,preview:value.preview});}setPreviews(next);})}>预览分析材料与费用</button>
    {previews.length>0&&<section className="maintenance-preview"><h3>分析预览</h3>{previews.map(item=><details key={item.chapterId}><summary>{plan?.chapters.find(chapter=>chapter.id===item.chapterId)?.title} · {item.preview.inputTokens} 输入 Token · {item.preview.estimatedCost===null?'费用未知':`约 $${item.preview.estimatedCost.toFixed(6)}`}</summary>{item.preview.blocked&&<p className="notice error">{item.preview.blocked.message}</p>}{item.preview.included.map((source,index)=><details key={index}><summary>{source.label}</summary><pre style={{whiteSpace:'pre-wrap'}}>{source.text}</pre></details>)}</details>)}<button className="button primary" disabled={busy||previews.some(item=>item.preview.blocked)} onClick={()=>void run(analyze)}>确认调用模型，按章顺序分析</button></section>}
    {busy&&<button className="button secondary" onClick={()=>{stopping.current=true;if(runningId.current)void request(`/jobs/${runningId.current}/cancel`,{},'POST').catch(failure=>setError(errorMessage(failure)));}}>停止分析队列</button>}
    <h3>已保存的分析任务</h3><ul className="backup-list">{plan?.jobs.map(job=><li key={job.id}><div><strong>{job.inputTitle}</strong><small> · {job.status}</small>{job.error&&<p>{job.error}</p>}</div><button className="button secondary compact" disabled={busy||job.status!=='succeeded'} onClick={()=>void run(()=>show(job.id))}>查看回填差异</button></li>)}</ul>
    {result&&<section className="maintenance-preview" aria-label="回填差异"><h3>{result.chapter.title} · 回填差异</h3><p>匹配实体保留原档案；新增事实写入本章状态，避免后文信息提前进入旧章。新增实体和状态默认仅作者可见。已确认历史保留。</p>
      {result.entries.map(item=><article key={item.key}><h4>{item.entry.title} · {item.entry.kind}</h4><label>匹配已有实体<select aria-label={`匹配${item.entry.title}`} disabled={busy||result.applied} value={mapping[item.key]??'__new'} onChange={event=>setMapping(current=>({...current,[item.key]:event.target.value==='__new'?null:event.target.value}))}><option value="">请选择同名实体</option><option value="__new">新增独立实体</option>{result.existingNodes.filter(node=>node.kind===item.entry.kind).map(node=><option key={node.id} value={node.id}>{node.title} · {node.id.slice(0,8)}</option>)}</select></label><p>已有内容：{result.existingNodes.find(node=>node.id===mapping[item.key])?.content??'新实体'}</p>{result.existingNodes.find(node=>node.id===mapping[item.key])?.needsReview&&<p className="notice warning">原档案的证据已变化，仍需在故事资料中复核；本次仅补充本章状态。</p>}<p>新增事实：{item.entry.content}</p>{sources(item.entry.evidence??[])}</article>)}
      <details><summary>已有图谱对照（旧记录不会自动撤回）</summary>{result.existingRelations.map((record,index)=><p key={index}>{result.existingNodes.find(node=>node.id===record.fromId)?.title} → {result.existingNodes.find(node=>node.id===record.toId)?.title}：{record.label} · {record.description}</p>)}{result.existingStates.map((record,index)=><p key={index}>{result.existingNodes.find(node=>node.id===record.nodeId)?.title}：{record.summary}</p>)}</details><h4>关系（{result.relations.length}）</h4>{result.relations.map((relation,index)=><article key={index}><p>{result.entries.find(item=>item.key===relation.fromKey)?.entry.title} → {result.entries.find(item=>item.key===relation.toKey)?.entry.title}：{relation.label} · {relation.description}</p>{sources(relation.evidence)}</article>)}
      <h4>状态变化（{result.states.length}）</h4>{result.states.map((state,index)=><article key={index}><p>{result.entries.find(item=>item.key===state.nodeKey)?.entry.title}：{state.summary}</p><pre>{JSON.stringify(state.changes,null,2)}</pre>{sources(state.evidence)}</article>)}
      <button className="button primary" disabled={busy||result.applied||Object.values(mapping).some(value=>value==='')} onClick={()=>void run(async()=>{await request(`/jobs/${result.jobId}/backfill/apply`,{fingerprint:result.fingerprint,mapping},'POST');onSaved();await refresh();await show(result.jobId);setNotice('知识、关系和状态已一并回填，原文未改动。');})}>{result.applied?'此任务已回填':'确认将以上候选回填知识与图谱'}</button>
    </section>}
  </div></Dialog>;
}
