import { useCallback, useEffect, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { AiJob, Chapter, ChapterReview, StoryProposal } from '@shujian/contracts';
import { collaborationApi } from '../lib/collaboration-api';
import { errorMessage } from '../lib/api';
import { Dialog } from './Dialog';
import { storyReviewHints } from '../lib/story-review';

export function FinalizationDialog({chapter,onClose,onFinalize}:{chapter:Chapter;onClose:()=>void;onFinalize:(ids:string[])=>Promise<void>}){
  const [proposals,setProposals]=useState<StoryProposal[]>([]);
  const [reviews,setReviews]=useState<ChapterReview[]>([]);
  const [selected,setSelected]=useState<string[]>([]);
  const [job,setJob]=useState<AiJob|null>(null);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const refresh=useCallback(async()=>{const[p,r]=await Promise.all([collaborationApi.proposals(chapter.bookId),collaborationApi.reviews(chapter.id)]);setProposals(p.proposals.filter((item)=>item.chapterId===chapter.id&&item.state==='pending'&&!item.stale));setReviews(r.reviews);},[chapter.id,chapter.bookId]);
  useEffect(()=>{void refresh().catch((failure)=>setError(errorMessage(failure))).finally(()=>setLoading(false));},[refresh]);
  const running=job&&['queued','running'].includes(job.status);
  useEffect(()=>{if(!job||!['queued','running'].includes(job.status))return;let live=true;let fetching=false;const timer=window.setInterval(()=>{if(fetching)return;fetching=true;void collaborationApi.job(job.id).then(async(result)=>{if(!live)return;setJob(result.job);if(!['queued','running'].includes(result.job.status)){if(result.job.error)setError(result.job.error);await refresh();}}).catch((failure)=>{if(live)setError(errorMessage(failure));}).finally(()=>{fetching=false;});},900);return()=>{live=false;window.clearInterval(timer);};},[job?.id,job?.status,refresh]);
  const start=async(kind:'review'|'extract')=>{setBusy(true);setError(null);try{const result=await collaborationApi.createJob({requestId:crypto.randomUUID(),kind,chapterId:chapter.id,expectedVersion:chapter.version,instruction:kind==='review'?'定稿前检查本快照：人物行为、连续性、视角边界；列出原句和依据。':'提取本快照中有原句支持的候选事实，等待作者定稿确认。',...(kind==='extract'?{source:'draft' as const}:{})});setJob(result.job);}catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}};
  const review=reviews.find((item)=>item.sourceVersion===chapter.version&&!item.stale);
  const orderedProposals=[...proposals].sort((a,b)=>Number(storyReviewHints(b.entry).length>0)-Number(storyReviewHints(a.entry).length>0));
  return <Dialog title="为这一章定稿" subtitle={`${chapter.title} · 已保存 V${chapter.version}。检查和整理可按需使用，模型失败时仍可定稿。`} onClose={onClose} wide busy={busy}>
    <div className="finalization-content">
      {error&&<p className="notice error" role="alert">{error}</p>}
      <section><div className="finalization-section-head"><h3>看一眼当前稿</h3><button className="button secondary compact" disabled={busy||!!running} onClick={()=>{void start('review');}}>检查当前稿</button></div>{review?<><p className="field-help">检查绑定当前版本，语义疑点由你判断。</p>{review.issues.length?review.issues.map((issue)=><article className="finalization-issue" key={issue.id}><p>{issue.message}</p>{issue.quote&&<blockquote>{issue.quote}</blockquote>}</article>):<p className="field-help">本次未报告问题，仍可根据自己的判断定稿。</p>}</>:<p className="field-help">当前版本尚无有效检查。可以先检查，也可以直接定稿。</p>}</section>
      <section><div className="finalization-section-head"><h3>确认故事中的变化</h3><button className="button secondary compact" disabled={busy||!!running} onClick={()=>{void start('extract');}}>整理当前稿资料</button></div><p className="field-help">勾选你确认的事实，正文定稿与所选资料在同一次提交中保存；其余可稍后处理。</p>{loading?<p className="panel-empty">正在读取建议……</p>:proposals.length?orderedProposals.map((proposal)=><label className={`finalization-proposal ${storyReviewHints(proposal.entry).length?'needs-attention':''}`} key={proposal.id}><input type="checkbox" disabled={busy} aria-label={`随定稿确认：${proposal.entry.title}`} checked={selected.includes(proposal.id)} onChange={(event)=>setSelected((prior)=>event.target.checked?[...prior,proposal.id]:prior.filter((id)=>id!==proposal.id))}/><span><strong>{proposal.entry.title}</strong>{storyReviewHints(proposal.entry).length>0&&<small className="finalization-reading-cue">重点核对：{storyReviewHints(proposal.entry).join('、')}。提示不代表已判定冲突，请结合原文与叙述时间确认。</small>}<p>{proposal.entry.content}</p>{proposal.entry.evidence?.map((source,index)=><blockquote key={index}>{source.quote}</blockquote>)}</span></label>):<p className="field-help">暂无本稿资料建议，定稿后也能整理。</p>}</section>
      {running&&<div className="finalization-progress" role="status"><LoaderCircle size={15} className="spin"/>正在{job.kind==='extract'?'整理资料':'检查正文'}。你仍可选择直接定稿。<button className="text-button" onClick={()=>{void collaborationApi.cancelJob(job.id).then((result)=>setJob(result.job)).catch((failure)=>setError(errorMessage(failure)));}}>停止</button></div>}
      {job?.output&&job.status==='failed'&&<details><summary>查看未完成任务的原始结果</summary><pre className="raw-result">{job.output}</pre></details>}
      <p className="field-help">{selected.length?`将随定稿确认 ${selected.length} 条资料。`:'未选择资料时，正文先定稿，资料保留为待确认或待整理。'}</p>
    </div><div className="dialog-footer"><button className="button quiet" disabled={busy} onClick={onClose}>返回改稿</button><button className="button primary" disabled={busy||loading} onClick={()=>{setBusy(true);setError(null);void onFinalize(selected).catch((failure)=>setError(errorMessage(failure))).finally(()=>setBusy(false));}}>{busy?<LoaderCircle size={15} className="spin"/>:<Check size={15}/>}确认定稿</button></div>
  </Dialog>;
}
