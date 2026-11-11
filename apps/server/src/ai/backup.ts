import { randomUUID } from 'node:crypto';
import type { AiJob, CreateAiJobInput, JsonValue, ContextItem } from '@shujian/contracts';
import type { Store } from '../store.js';
import type { AiCall } from './index.js';
import { AppError } from '../errors.js';
import * as validate from '../validation.js';
import * as inputs from './validation.js';
import { builtinSkills, creativeHash } from '../creative/definitions.js';
import { parsePromptMessages, parsePromptSnapshot } from '../creative/validation.js';
import type { BillingJob } from './budget-ledger.js';
const timestamp = () => new Date().toISOString();
const active = (status: AiJob['status']) => status === 'queued' || status === 'running';

/** Backup validation and ID remapping are separate from live task execution. */
export class AiBackupService {
  constructor(private readonly store: Store, private readonly calls: (id: string) => AiCall[],
    private readonly write: (job: AiJob) => void, private readonly writeCall: (call: AiCall) => void) {}
  exportBook(bookId:string):JsonValue {
    this.store.getBook(bookId);
    const jobs=(this.store.db.prepare('SELECT job FROM ai_jobs WHERE book_id=? ORDER BY created_at,rowid').all(bookId) as Array<{job:string}>).map((row)=>JSON.parse(row.job) as AiJob);
    return jobs.map((job)=>{
      const row=this.store.db.prepare('SELECT input,reserved_cost FROM ai_jobs WHERE id=?').get(job.id) as {input:string;reserved_cost:number|null};
      const events=this.store.db.prepare('SELECT id,payload,created_at FROM ai_events WHERE job_id=? ORDER BY id').all(job.id);
      const history:BillingJob={...job,billingSourceId:(job as BillingJob).billingSourceId??job.id};
      const calls=this.calls(job.id).map((call)=>({...call,billingSourceId:call.billingSourceId??call.id}));
      return JSON.parse(JSON.stringify({job:history,input:JSON.parse(row.input),calls,events,budgetReservation:row.reserved_cost})) as JsonValue;
    });
  }
  prepareRestore(payload:JsonValue,ids:Record<string,string>):void {
    if(!Array.isArray(payload)||payload.length>100000)throw new AppError(400,'INVALID_AI_BACKUP','备份任务格式不正确。');
    for(const raw of payload){const item=validate.object(raw,'备份任务');const job=validate.object(item.job,'任务');const id=validate.string(job.id,'任务ID',128,1);if(ids[id])throw new AppError(400,'INVALID_AI_BACKUP','备份中存在重复任务ID。');ids[id]=randomUUID();}
  }
  restoreBook(oldBookId:string,newBookId:string,ids:Record<string,string>,payload:JsonValue):void {
    if(!Array.isArray(payload))throw new AppError(400,'INVALID_AI_BACKUP','备份任务格式不正确。');
    for(const raw of payload){
      const item=validate.object(raw,'备份任务');const source=validate.object(item.job,'任务');const input=inputs.createJob(item.input);
      const oldId=validate.string(source.id,'任务ID',128,1);const oldChapter=validate.string(source.chapterId,'章节ID',128,1);
      if(source.bookId!==oldBookId||!ids[oldId]||!ids[oldChapter])throw new AppError(400,'INVALID_AI_BACKUP','备份任务关联不正确。');
      const kind=validate.string(source.kind,'任务类型',20);if(kind!==input.kind||input.chapterId!==oldChapter)throw new AppError(400,'INVALID_AI_BACKUP','备份任务输入不一致。');
      const status=validate.string(source.status,'任务状态',20);if(!['queued','running','succeeded','failed','interrupted','cancelled'].includes(status))throw new AppError(400,'INVALID_AI_BACKUP','任务状态不正确。');
      const context=source.context;if(!Array.isArray(context)||context.length>100000)throw new AppError(400,'INVALID_AI_BACKUP','任务上下文不正确。');
      const mappedContext:ContextItem[]=context.map((rawContext)=>{
        const c=validate.object(rawContext,'上下文');const src=validate.string(c.source,'上下文来源',30);if(!['instruction','chapter','outline','premise','canon','history','conversation','skill','style'].includes(src))validate.invalid('上下文来源不正确。');
        const mapped:ContextItem={id:validate.string(c.id,'上下文ID',500,1),label:validate.string(c.label,'上下文名称',500),source:src as ContextItem['source'],text:validate.string(c.text,'上下文正文',2_000_000),required:c.required===true};
        for(const field of ['chapterId','revisionId','entryId'] as const)if(c[field]!==undefined){const prior=validate.string(c[field],'上下文引用',128,1);if(!ids[prior])throw new AppError(400,'INVALID_AI_BACKUP','任务上下文引用缺失。');mapped[field]=ids[prior];}
        return mapped;
      });
      const usage=validate.object(source.usage,'任务用量');const nullable=(v:unknown)=>v===null?null:validate.integer(v,'用量',0,Number.MAX_SAFE_INTEGER);
      const allowance=(value:unknown):number|null=>{if(value===undefined||value===null)return null;if(typeof value!=='number'||!Number.isFinite(value)||value<0)validate.invalid('预算预留不正确。');return value;};
      const budgetReservation=allowance(item.budgetReservation);
      const applied=source.appliedVersion===null?null:validate.integer(source.appliedVersion,'采纳版本',1);
      const priceSnapshot=source.priceSnapshot===undefined?undefined:validate.object(source.priceSnapshot,'计价依据');
      const nullablePrice=(value:unknown):number|null=>{if(value===null)return null;if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1_000_000)validate.invalid('计价依据不正确。');return value;};
      const job:BillingJob={id:ids[oldId]!,billingSourceId:validate.string(source.billingSourceId??oldId,'计费来源ID',128,1),bookId:newBookId,chapterId:ids[oldChapter]!,kind:kind as AiJob['kind'],status:active(status as AiJob['status'])?'interrupted':status as AiJob['status'],instruction:input.instruction,inputVersion:validate.integer(source.inputVersion,'输入版本',1),inputDocument:validate.document(source.inputDocument),inputTitle:validate.string(source.inputTitle,'输入标题',200),inputOutline:validate.string(source.inputOutline,'输入章纲',20_000),selection:input.selection??null,output:validate.string(source.output,'任务结果',1_000_000),...(source.candidateText===undefined?{}:{candidateText:validate.string(source.candidateText,'采纳候选',1_000_000)}),error:active(status as AiJob['status'])?'备份恢复的任务已中断，模型连接需要重新绑定。':source.error===null?null:validate.string(source.error,'任务错误',5000),model:validate.string(source.model,'模型名',200),context:mappedContext,promptVersion:validate.string(source.promptVersion,'提示词版本',200),...(priceSnapshot?{priceSnapshot:{inputPricePerMillion:nullablePrice(priceSnapshot.inputPricePerMillion),outputPricePerMillion:nullablePrice(priceSnapshot.outputPricePerMillion)}}:{}),usage:{inputTokens:nullable(usage.inputTokens),outputTokens:nullable(usage.outputTokens),estimatedCost:typeof usage.estimatedCost==='number'&&Number.isFinite(usage.estimatedCost)&&usage.estimatedCost>=0?usage.estimatedCost:null,attempts:validate.integer(usage.attempts,'调用次数',0,100),currency:'USD'},appliedVersion:applied,createdAt:validate.string(source.createdAt,'创建时间',40,1),updatedAt:timestamp()};
      if(source.promptSnapshot!==undefined)job.promptSnapshot=parsePromptSnapshot(source.promptSnapshot);
      if(!job.promptSnapshot&&source.skillBindings!==undefined&&(!Array.isArray(source.skillBindings)||source.skillBindings.length))validate.invalid('技能绑定缺少对应提示快照。');
      if(job.promptSnapshot){
        const bindings=source.skillBindings===undefined?[]:source.skillBindings;
        if(!Array.isArray(bindings)||bindings.length>3)validate.invalid('技能绑定格式不正确。');
        const parsed=bindings.map((value)=>{const binding=validate.object(value,'技能绑定');return {snapshotId:validate.string(binding.snapshotId,'快照技能ID',128,1),skillId:validate.string(binding.skillId,'作品技能ID',128,1)};});
        if((source.skillBindings!==undefined&&parsed.length!==job.promptSnapshot.creativity.skills.length)||new Set(parsed.map((entry)=>entry.snapshotId)).size!==parsed.length||parsed.some((entry)=>!job.promptSnapshot!.creativity.skills.some((skill)=>skill.id===entry.snapshotId)))validate.invalid('技能绑定引用不正确。');
        job.skillBindings=job.promptSnapshot.creativity.skills.map((skill)=>{const old=parsed.find((entry)=>entry.snapshotId===skill.id)?.skillId??skill.id;const mapped=builtinSkills.some((entry)=>entry.id===old)?old:ids[old];if(!mapped)validate.invalid('冻结技能关联缺失。');return {snapshotId:skill.id,skillId:mapped};});
      }
      if(input.backfill)job.backfill=true;
      const mappedInput={...input,chapterId:job.chapterId,requestId:randomUUID(),pinnedEntryIds:input.pinnedEntryIds?.map((id)=>ids[id]).filter((id):id is string=>!!id),excludedEntryIds:input.excludedEntryIds?.map((id)=>ids[id]).filter((id):id is string=>!!id),
        ...(input.skills?{skills:input.skills.map((skill)=>({...skill,id:skill.id.startsWith('builtin-')?skill.id:ids[skill.id]??validate.invalid('任务技能引用缺失。')}))}:{}),
        ...(input.voiceIds?{voiceIds:input.voiceIds.map((id)=>ids[id]??validate.invalid('任务声音引用缺失。'))}:{}),
        ...(input.atlas?{atlas:{...input.atlas,nodeIds:input.atlas.nodeIds.map(id=>ids[id]??validate.invalid('图谱卡片引用缺失。')),relationIds:input.atlas.relationIds.map(id=>ids[id]??validate.invalid('图谱关系引用缺失。'))}}:{})};
      this.store.db.prepare('INSERT INTO ai_jobs(id,request_id,book_id,chapter_id,status,job,input,settings,reserved_cost,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(job.id,mappedInput.requestId,newBookId,job.chapterId,job.status,JSON.stringify(job),JSON.stringify(mappedInput),null,budgetReservation,job.createdAt);
      if(!Array.isArray(item.calls)||item.calls.length>100)validate.invalid('备份调用记录不正确。');
      for(const rawCall of item.calls){const c=validate.object(rawCall);if(c.jobId!==oldId)validate.invalid('调用所属任务不一致。');const call:AiCall={id:randomUUID(),jobId:job.id,billingSourceId:validate.string(c.billingSourceId??c.id,'调用计费来源ID',128,1),...(c.reservedCost===undefined?{}:{reservedCost:allowance(c.reservedCost)}),attempt:validate.integer(c.attempt,'调用序号',1,100),model:validate.string(c.model,'模型名',200),status:c.status==='succeeded'?'succeeded':c.status==='cancelled'?'cancelled':c.status==='failed'?'failed':'interrupted',inputTokens:nullable(c.inputTokens),outputTokens:nullable(c.outputTokens),estimatedCost:typeof c.estimatedCost==='number'&&Number.isFinite(c.estimatedCost)&&c.estimatedCost>=0?c.estimatedCost:null,error:c.error===null?null:validate.string(c.error,'调用错误',5000),...(c.output===undefined?{}:{output:validate.string(c.output,'调用原始输出',1_000_000)}),createdAt:validate.string(c.createdAt,'调用时间',40,1),updatedAt:timestamp()};if(c.requestMessages!==undefined){call.requestMessages=parsePromptMessages(c.requestMessages);call.promptHash=validate.string(c.promptHash,'调用提示哈希',64,64);if(call.promptHash!==creativeHash(call.requestMessages))validate.invalid('调用提示内容与哈希不一致。');}this.writeCall(call);}
      if (!Array.isArray(item.events) || item.events.length > 1_000_000) validate.invalid('备份事件记录不正确。');
      for (const rawEvent of item.events) {
        const event=validate.object(rawEvent,'任务事件');
        const saved=validate.string(event.payload,'事件内容',4_000_000,1);
        let payload:Record<string,unknown>;
        try { payload=validate.object(JSON.parse(saved)); } catch { validate.invalid('任务事件内容不正确。'); }
        if (payload.job) { const prior=validate.object(payload.job); payload={status:prior.status,outputLength:typeof prior.output==='string'?prior.output.length:0,updatedAt:prior.updatedAt}; }
        validate.integer(payload.outputLength,'事件输出长度',0,1_000_000);
        if(!['queued','running','succeeded','failed','interrupted','cancelled'].includes(String(payload.status)))validate.invalid('任务事件状态不正确。');
        validate.string(payload.updatedAt,'事件时间',40,1);
        this.store.db.prepare('INSERT INTO ai_events(job_id,payload,created_at) VALUES(?,?,?)').run(job.id,JSON.stringify(payload),validate.string(event.created_at,'事件时间',40,1));
      }
      this.write(job);
    }
  }
  validateRestoredSkillBindings(bookId:string):void {
    const jobs=(this.store.db.prepare('SELECT job FROM ai_jobs WHERE book_id=?').all(bookId) as Array<{job:string}>).map((row)=>JSON.parse(row.job) as AiJob);
    for(const job of jobs)for(const binding of job.skillBindings??[]){
      if(builtinSkills.some((skill)=>skill.id===binding.skillId))continue;
      const skill=this.store.db.prepare('SELECT book_id FROM creative_skills WHERE id=?').get(binding.skillId) as {book_id:string}|undefined;
      if(!skill||skill.book_id!==bookId)validate.invalid('冻结技能必须关联本作品的创作技能。');
    }
  }
}
