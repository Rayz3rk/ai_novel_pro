import { AiRunner, safeError } from './runner.js';
import { prompt } from './prompts.js';
import { AiContext } from './context.js';
import { AiBudget, price } from './budget.js';
import { AiBackupService } from './backup.js';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  textToDocument, type AiJob, type ApplyAiJobInput, type ApplyAiJobResult,
  type Chapter, type ContextItem, type CreateAiJobInput, type JsonValue,
  type ModelSettings, type UpdateModelSettings,
  type ContextPreview, type CreativeSnapshot, type CreativeEvaluationSample,
  type PromptMessage, type SkillSnapshot,
} from '@shujian/contracts';
import { Store } from '../store.js';
import { AppError, conflict, notFound } from '../errors.js';
import * as validate from '../validation.js';
import * as inputs from './validation.js';
import { Credentials } from './credentials.js';
import { replaceSelection, verifySelection } from './document.js';
import { complete, type Message } from './provider.js';
import { readConnectionsFile } from './config-file.js';
import { type BillingJob } from './budget-ledger.js';
import { creativeHash } from '../creative/definitions.js';

interface JobRow { id: string; request_id: string; book_id: string; chapter_id: string; status: string; job: string; input: string; settings: string | null; reserved_cost: number | null }
export interface AiCall { id: string; jobId: string | null; billingSourceId?: string; attempt: number; model: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; inputTokens: number | null; outputTokens: number | null; estimatedCost: number | null; reservedCost?: number | null; error: string | null; output?:string; createdAt: string; updatedAt: string; requestMessages?: PromptMessage[]; promptHash?: string }
export interface AiOptions { credentialDir?: string; workspaceDirectory?: string; connectionsFile?:string }
export interface AiHooks { context?: (input: CreateAiJobInput, chapter: Chapter) => ContextItem[]; completed?: (job: AiJob) => void;
  creativity?: (input: CreateAiJobInput, chapter: Chapter, replay?: SkillSnapshot[]) => { items: ContextItem[]; snapshot: CreativeSnapshot } }
interface EventRow { id: number; payload: string }
const PROMPT_VERSION = 'shujian-1.1-2026-10-26';
const timestamp = () => new Date().toISOString();
const writing = (kind: AiJob['kind']) => ['draft', 'revise', 'plan'].includes(kind);
const active = (status: AiJob['status']) => status === 'queued' || status === 'running';
const defaults: Omit<ModelSettings, 'hasApiKey'> = { id: 'default', name:'OpenAI 兼容接口', baseUrl: 'https://api.openai.com/v1', model: '', stream: true, temperature: 0.7, maxOutputTokens: 4096, contextWindow: 32768, inputPricePerMillion: null, outputPricePerMillion: null, taskBudget: null, dailyBudget: null, tokenParameter:'max_tokens',sendTemperature:true,includeStreamUsage:true };

/** Conservative planning estimate; actual provider token counts are recorded separately. */


function param(request: FastifyRequest, name = 'jobId'): string { return validate.string(validate.object(request.params)[name], '记录 ID', 128, 1); }

export class AiService {
  readonly hooks: AiHooks = {};
  private readonly backups: AiBackupService;
  private readonly budget: AiBudget;
  private readonly context: AiContext;
  private readonly runner: AiRunner;
  private readonly credentials: Credentials;
  private readonly controllers = new Map<string, AbortController>();
  private readonly testing = new Set<AbortController>();
  private readonly testWork = new Set<Promise<unknown>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<ServerResponse>>();
  private closed = false;
  private importing = false;
  private readonly connectionsFile?:string;

  constructor(private readonly store: Store, options: AiOptions = {}) {
    this.budget = new AiBudget(store, id => this.calls(id), () => prompt('draft'));
    this.context = new AiContext(store, this.hooks, id => this.listChapter(id), this.budget.checkBudget.bind(this.budget));
    this.backups = new AiBackupService(store, id => this.calls(id), job => this.write(job), call => this.writeCall(call));
    this.credentials = new Credentials(options.credentialDir, options.workspaceDirectory);
    this.runner = new AiRunner({ store, credentials: this.credentials, controllers: this.controllers, hooks: this.hooks,
      get: id => this.get(id), write: job => this.write(job), writeCall: call => this.writeCall(call), calls: id => this.calls(id),
      checkRetryBudget: (settings, job, messages) => this.checkRetryBudget(settings, job, messages), isClosed: () => this.closed });
    this.connectionsFile=options.connectionsFile;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_settings(id TEXT PRIMARY KEY, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_active(singleton INTEGER PRIMARY KEY CHECK(singleton=1),connection_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_config_import(source_path TEXT PRIMARY KEY,source_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_jobs(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
        book_id TEXT NOT NULL REFERENCES books(id), chapter_id TEXT NOT NULL REFERENCES chapters(id),
        status TEXT NOT NULL, job TEXT NOT NULL, input TEXT NOT NULL, settings TEXT,
        reserved_cost REAL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_jobs_book ON ai_jobs(book_id, created_at);
      CREATE TABLE IF NOT EXISTS ai_events(id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES ai_jobs(id), payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_events_job ON ai_events(job_id,id);
      CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY,job_id TEXT REFERENCES ai_jobs(id),payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_jobs_created ON ai_jobs(created_at);
    `);
    this.store.db.exec(`CREATE INDEX IF NOT EXISTS ai_calls_created ON ai_calls((${this.callDateExpression()}))`);
    this.store.db.transaction(() => {
      const interrupted = this.store.db.prepare("SELECT * FROM ai_jobs WHERE status IN ('queued','running')").all() as JobRow[];
      for (const row of interrupted) {
        const job = JSON.parse(row.job) as AiJob;
        job.status = 'interrupted'; job.error = '本地服务已重启，生成中断。已收到的文字保留；重试会创建新的候选。';
        this.write(job);
      }
      const calls = this.store.db.prepare('SELECT id,payload FROM ai_calls').all() as Array<{id:string;payload:string}>;
      for (const call of calls) {
        const value = JSON.parse(call.payload) as AiCall;
        if (value.status === 'running') { value.status = 'interrupted'; value.updatedAt = timestamp(); this.writeCall(value); }
      }
    })();
  }

  private activeId():string {
    const row=this.store.db.prepare('SELECT connection_id FROM ai_active WHERE singleton=1').get() as {connection_id:string}|undefined;
    return row?.connection_id??'default';
  }
  private reloadFile():void {
    if(this.importing||!this.connectionsFile)return;
    const config=readConnectionsFile(this.connectionsFile,defaults);if(!config)return;
    const imported=this.store.db.prepare('SELECT source_hash FROM ai_config_import WHERE source_path=?').get(this.connectionsFile) as {source_hash:string}|undefined;
    if(imported?.source_hash===config.hash)return;
    this.importing=true;
    try{this.store.db.transaction(()=>{
      for(const connection of config.connections)this.updateSettings(connection.settings,connection.id);
      this.activate(config.activeId);
      this.store.db.prepare('INSERT INTO ai_config_import(source_path,source_hash) VALUES(?,?) ON CONFLICT(source_path) DO UPDATE SET source_hash=excluded.source_hash').run(this.connectionsFile!,config.hash);
    })();}finally{this.importing=false;}
  }
  settings(id?:string): ModelSettings {
    this.reloadFile();id??=this.activeId();
    const row = this.store.db.prepare('SELECT config FROM ai_settings WHERE id=?').get(id) as {config:string} | undefined;
    if(!row&&id!=='default')return notFound('模型连接');
    return { ...defaults, ...(row ? JSON.parse(row.config) as Omit<ModelSettings,'hasApiKey'> : {}),id, hasApiKey: !!this.credentials.get(id) };
  }
  connections():{connections:ModelSettings[];activeId:string} {
    this.reloadFile();
    const rows=this.store.db.prepare('SELECT id FROM ai_settings ORDER BY rowid').all() as Array<{id:string}>;
    if(!rows.some((row)=>row.id==='default'))rows.unshift({id:'default'});
    return {connections:rows.map((row)=>this.settings(row.id)),activeId:this.activeId()};
  }
  activate(id:string):ModelSettings {
    const settings=this.settings(id);
    this.store.db.prepare('INSERT INTO ai_active(singleton,connection_id) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET connection_id=excluded.connection_id').run(id);
    return settings;
  }
  addConnection(input:UpdateModelSettings):ModelSettings {
    const id=randomUUID();const result=this.updateSettings(input,id);this.activate(id);return result;
  }
  updateSettings(input: UpdateModelSettings,id=this.activeId()): ModelSettings {
    if (input.contextWindow <= input.maxOutputTokens + 256) throw new AppError(400, 'CONTEXT_BUDGET', '上下文窗口需要大于输出额度，并为输入保留空间。');
    const { apiKey, clearApiKey, ...configuration } = input;
    if (clearApiKey) this.credentials.set('',id); else if (apiKey) this.credentials.set(apiKey,id);
    this.store.db.prepare('INSERT INTO ai_settings(id,config) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config').run(id,JSON.stringify({ ...configuration, id }));
    return this.settings(id);
  }
  async catalog(id:string):Promise<{models:string[]}> {
    const settings=this.settings(id);const root=settings.baseUrl.replace(/\/chat\/completions$/,'');
    let response:Response;
    try { const key=this.credentials.get(id);response=await fetch(`${root}/models`,{headers:key?{authorization:`Bearer ${key}`}:{},signal:AbortSignal.timeout(20_000),redirect:'error'}); }
    catch {throw new AppError(502,'MODEL_CATALOG','无法读取平台模型列表；仍可手工填写平台提供的模型名称。');}
    if(!response.ok){await response.body?.cancel();throw new AppError(502,'MODEL_CATALOG',`平台未提供可读取的模型列表（HTTP ${response.status}）。可手工填写模型名称。`);}
    let data:unknown;try{data=await response.json();}catch{throw new AppError(502,'MODEL_CATALOG','平台模型列表格式无法识别。');}
    const rows=validate.object(data).data;if(!Array.isArray(rows))throw new AppError(502,'MODEL_CATALOG','平台模型列表格式无法识别。');
    return {models:rows.slice(0,10000).flatMap((row)=>{if(row&&typeof row==='object'&&'id'in row&&typeof row.id==='string'&&row.id.length<500)return[row.id];return[];}).sort()};
  }
  async test(): Promise<{ok:true;message:string}> {
    if(this.closed)throw new AppError(503,'SERVICE_CLOSING','本地服务正在关闭，请稍后重试。');
    const settings = this.settings();
    if (!settings.model) throw new AppError(400, 'MODEL_NOT_CONFIGURED', '请先保存模型地址和名称。');
    const controller = new AbortController();
    const testSettings={...settings,maxOutputTokens:Math.min(settings.maxOutputTokens,512)};
    const reservedCost=this.checkBudget(testSettings,[{id:'test',source:'instruction',label:'连接测试',text:'请只回复：连接成功。',required:true}]);
    const callId=randomUUID();
    const call: AiCall = { id:callId,billingSourceId:callId,jobId:null, attempt:1, model:settings.model, status:'running', inputTokens:null,outputTokens:null,estimatedCost:null,reservedCost,error:null,createdAt:timestamp(),updatedAt:timestamp() };
    this.writeCall(call);
    this.testing.add(controller);
    const work=this.runConnectionTest(testSettings,controller,call);
    this.testWork.add(work);
    try {return await work;} finally {this.testWork.delete(work);}
  }
  private async runConnectionTest(settings:ModelSettings,controller:AbortController,call:AiCall):Promise<{ok:true;message:string}> {
    try {
      await complete({ settings,apiKey:this.credentials.get(settings.id),signal:controller.signal,messages:[{role:'user',content:'请只回复：连接成功。'}],onText:()=>undefined,onUsage:(u)=>{call.inputTokens=u.inputTokens;call.outputTokens=u.outputTokens;} });
      call.status='succeeded';
      return {ok:true,message:'模型连接成功，可以开始协作。'};
    } catch (error) {call.status=this.closed?'interrupted':'failed';call.error=safeError(error);throw new AppError(502,'MODEL_TEST_FAILED',call.error);}
    finally {call.estimatedCost=price(settings,call.inputTokens,call.outputTokens);call.updatedAt=timestamp();this.writeCall(call);this.testing.delete(controller);}
  }

  get(id: string): AiJob {
    const row = this.store.db.prepare('SELECT job FROM ai_jobs WHERE id=?').get(id) as {job:string}|undefined;
    return row ? JSON.parse(row.job) as AiJob : notFound('AI 任务');
  }
  list(bookId: string): AiJob[] {
    this.store.getBook(bookId);
    return (this.store.db.prepare('SELECT job FROM ai_jobs WHERE book_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200').all(bookId) as Array<{job:string}>).map((row)=>JSON.parse(row.job) as AiJob);
  }
  listChapter(chapterId:string):AiJob[] {
    this.store.getChapter(chapterId);
    return(this.store.db.prepare('SELECT job FROM ai_jobs WHERE chapter_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200').all(chapterId) as Array<{job:string}>).map((row)=>JSON.parse(row.job) as AiJob);
  }
  calls(id:string):AiCall[] {
    this.get(id);
    return (this.store.db.prepare('SELECT payload FROM ai_calls WHERE job_id=? ORDER BY rowid').all(id) as Array<{payload:string}>).map((row)=>JSON.parse(row.payload) as AiCall);
  }
  private writeCall(call: AiCall):void {this.store.db.prepare('INSERT INTO ai_calls(id,job_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(call.id,call.jobId,JSON.stringify(call));}
  private write(job:AiJob):void {
    job.updatedAt=timestamp();
    const event=this.store.db.transaction(()=>{
      this.store.db.prepare('UPDATE ai_jobs SET status=?,job=? WHERE id=?').run(job.status,JSON.stringify(job),job.id);
      return this.store.db.prepare('INSERT INTO ai_events(job_id,payload,created_at) VALUES(?,?,?)').run(job.id,JSON.stringify({status:job.status,outputLength:job.output.length,updatedAt:job.updatedAt}),timestamp());
    })();
    const frame=`id: ${event.lastInsertRowid}\nevent: job\ndata: ${JSON.stringify({job})}\n\n`;
    for(const listener of this.listeners.get(job.id)??[]) if(!listener.destroyed)listener.write(frame);
  }

  preview(input: CreateAiJobInput): ContextPreview { return this.context.preparePreview(input, this.settings()); }
  private preparePreview(input: CreateAiJobInput, settings: ModelSettings, replay?: SkillSnapshot[]): ContextPreview { return this.context.preparePreview(input, settings, replay); }
  private callDateExpression(): string { return this.budget.callDateExpression(); }
  private checkBudget(settings: ModelSettings, context: ContextItem[], reservedElsewhere = 0, messages?: Message[]): number | null { return this.budget.checkBudget(settings, context, reservedElsewhere, messages); }

  create(input:CreateAiJobInput,replay?:SkillSnapshot[]):AiJob {
    if(this.closed)throw new AppError(503,'SERVICE_CLOSING','本地服务正在关闭，请稍后重试。');
    const existing=this.store.db.prepare('SELECT id,input FROM ai_jobs WHERE request_id=?').get(input.requestId) as {id:string;input:string}|undefined;
    if(existing){if(existing.input!==JSON.stringify(input))throw new AppError(409,'REQUEST_ID_REUSED','请求标识已用于其他任务。');return this.get(existing.id);}
    const settings=this.settings();if(!settings.model)throw new AppError(422,'MODEL_NOT_CONFIGURED','先在模型设置中保存地址、名称与密钥，再开始 AI 协作。');
    const chapter=this.store.getChapter(input.chapterId);
    if(chapter.archivedAt)throw new AppError(409,'CHAPTER_ARCHIVED','此章已归档，请先取消归档后再发起任务。');if(chapter.version!==input.expectedVersion)conflict(chapter.version);
    if(input.selection)verifySelection(chapter.document,input.selection);
    const inFlight=this.store.db.prepare("SELECT job FROM ai_jobs WHERE chapter_id=? AND status IN ('queued','running')").all(chapter.id) as Array<{job:string}>;
    if(writing(input.kind)&&inFlight.some((row)=>writing((JSON.parse(row.job) as AiJob).kind)))throw new AppError(409,'CHAPTER_BUSY','这一章已有写作任务在运行，请先完成或取消它。');
    if(input.kind==='extract'&&input.source!=='draft'&&!chapter.finalizedRevisionId)throw new AppError(422,'FINAL_REQUIRED','先为本章定稿，再从正式正文整理资料。');
    const job=this.store.db.transaction(()=>{
      const prepared=this.preparePreview(input,settings,replay);
      if(input.previewFingerprint&&input.previewFingerprint!==prepared.fingerprint)throw new AppError(409,'PREVIEW_CHANGED','正文、技能、档案、材料或模型设置已变化，请重新预览后开始。');
      if(prepared.blocked)throw new AppError(422,prepared.blocked.code,prepared.blocked.message);
      const revisionId=input.kind==='extract'&&input.source!=='draft'?chapter.finalizedRevisionId!:this.store.checkpoint(chapter.id,chapter.version,'AI 输入快照').id;
      const context=prepared.included.map((item)=>item.id==='chapter'||item.id==='selection'?{...item,revisionId}:item);
      const reservation=this.checkBudget(settings,context,0,prepared.prompt.messages);
      const source=input.kind==='extract'?this.store.getRevision(chapter.id,revisionId):chapter;
      const time=timestamp();
      const id=randomUUID();
      const value:BillingJob={...(input.backfill?{backfill:true}:{}),id,billingSourceId:id,bookId:chapter.bookId,chapterId:chapter.id,kind:input.kind,status:'queued',instruction:input.instruction,inputVersion:input.kind==='extract'?this.store.getRevision(chapter.id,revisionId).sourceVersion:chapter.version,inputDocument:source.document,inputTitle:source.title,inputOutline:source.outline,selection:input.selection??null,output:'',error:null,model:settings.model,modelConnectionId:settings.id,priceSnapshot:{inputPricePerMillion:settings.inputPricePerMillion,outputPricePerMillion:settings.outputPricePerMillion},context,promptVersion:PROMPT_VERSION,usage:{inputTokens:null,outputTokens:null,estimatedCost:null,attempts:0,currency:'USD'},appliedVersion:null,createdAt:time,updatedAt:time};
      value.promptSnapshot=prepared.prompt;
      value.skillBindings=prepared.prompt.creativity.skills.map((skill)=>({snapshotId:skill.id,skillId:skill.id}));
      this.store.db.prepare('INSERT INTO ai_jobs(id,request_id,book_id,chapter_id,status,job,input,settings,reserved_cost,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(value.id,input.requestId,value.bookId,value.chapterId,value.status,JSON.stringify(value),JSON.stringify(input),JSON.stringify(settings),reservation,time);
      this.write(value);return value;
    })();
    queueMicrotask(()=>{if(!this.closed&&this.get(job.id).status==='queued'){const work=this.execute(job.id).finally(()=>this.running.delete(job.id));this.running.set(job.id,work);}});
    return job;
  }
  cancel(id:string):AiJob {
    const job=this.get(id);if(!active(job.status))return job;
    job.status='cancelled';job.error='任务已取消，已收到的文字保留；未写入正文。';this.write(job);this.controllers.get(id)?.abort();return job;
  }
  retry(id:string):AiJob {
    const row=this.store.db.prepare('SELECT input FROM ai_jobs WHERE id=?').get(id) as {input:string}|undefined;if(!row)notFound('AI 任务');
    const prior=this.get(id);if(active(prior.status))throw new AppError(409,'TASK_RUNNING','任务还在执行，请先取消。');
    const input=JSON.parse(row.input) as CreateAiJobInput;const chapter=this.store.getChapter(input.chapterId);
    if(chapter.archivedAt)throw new AppError(409,'CHAPTER_ARCHIVED','此章已归档，请先取消归档后再发起任务。');
    if(prior.kind==='revise'&&chapter.version!==prior.inputVersion)throw new AppError(409,'STALE_CANDIDATE','选区所在正文已经变化，请重新选择并创建改稿任务。');
    const {previewFingerprint:_previewFingerprint,...freshInput}=input;
    const replay=prior.promptSnapshot?.creativity.skills.map((skill)=>({...skill,id:prior.skillBindings?.find((binding)=>binding.snapshotId===skill.id)?.skillId??skill.id}));
    const skills=replay?.map((skill)=>({id:skill.id,version:skill.version,focus:skill.focus,resourcePaths:skill.resources.map((entry)=>entry.path)}));
    return this.create({...freshInput,...(skills?{skills}:{}),requestId:randomUUID(),expectedVersion:chapter.version},replay);
  }

  private execute(id: string): Promise<void> { return this.runner.execute(id); }
  private checkRetryBudget(settings: ModelSettings, job: AiJob, messages: Message[]): number | null { return this.budget.checkRetryBudget(settings, job, messages); }

  apply(id:string,input:ApplyAiJobInput):ApplyAiJobResult {
    return this.store.db.transaction(()=>{
      const job=this.get(id);
      if(job.appliedVersion!==null)return {chapter:this.store.getChapter(job.chapterId),alreadyApplied:true};
      if(job.status!=='succeeded'||['review','extract'].includes(job.kind))throw new AppError(409,'CANDIDATE_NOT_READY','这个任务没有可采纳的正文或计划。');
      const chapter=this.store.getChapter(job.chapterId);
      if(chapter.version!==input.expectedVersion)conflict(chapter.version);
      if(chapter.version!==job.inputVersion)throw new AppError(409,'STALE_CANDIDATE','生成后正文已经变化。旧候选只能查看或复制，请根据当前稿重新生成。',chapter.version);
      if(input.target==='document'&&!['draft','revise'].includes(job.kind))throw new AppError(400,'INVALID_APPLY_TARGET','讨论和规划请采纳到本章意图。');
      const text=input.text??job.output;if(!text.trim())throw new AppError(422,'EMPTY_CANDIDATE','候选稿为空。');
      const document=input.target==='outline'?chapter.document:job.kind==='revise'&&job.selection?replaceSelection(chapter.document,job.selection,text):validate.document(textToDocument(text));
      if(input.target==='outline')validate.string(text,'本章意图',20_000,1);
      this.store.checkpoint(chapter.id,chapter.version,'采纳 AI 前自动留稿');
      const result=this.store.saveDraft(chapter.id,{expectedVersion:chapter.version,title:chapter.title,outline:input.target==='outline'?text:chapter.outline,document});
      this.store.checkpoint(result.id,result.version,'AI 采纳稿');
      job.candidateText=text;job.appliedVersion=result.version;this.write(job);return {chapter:result,alreadyApplied:false};
    })();
  }

  subscribe(id:string,response:ServerResponse,lastId:number):()=>void {
    const job=this.get(id);const events=this.store.db.prepare('SELECT id,payload FROM ai_events WHERE job_id=? AND id>? ORDER BY id LIMIT 500').all(id,lastId) as EventRow[];
    for(const event of events)response.write(`id: ${event.id}\nevent: progress\ndata: ${event.payload}\n\n`);
    const latest=this.store.db.prepare('SELECT MAX(id) AS id FROM ai_events WHERE job_id=?').get(id) as {id:number|null};
    response.write(`${latest.id === null ? '' : `id: ${latest.id}\n`}event: job\ndata: ${JSON.stringify({job})}\n\n`);
    const listeners=this.listeners.get(id)??new Set<ServerResponse>();listeners.add(response);this.listeners.set(id,listeners);
    const heartbeat=setInterval(()=>{if(!response.destroyed)response.write(': keep-alive\n\n');},15000);
    return()=>{clearInterval(heartbeat);listeners.delete(response);if(listeners.size===0)this.listeners.delete(id);};
  }
  assertCanDelete(bookId:string,chapterId?:string):void {
    const rows=this.store.db.prepare('SELECT id,chapter_id,status FROM ai_jobs WHERE book_id=?').all(bookId) as {id:string;chapter_id:string;status:AiJob['status']}[];
    if(rows.some(row=>(!chapterId||row.chapter_id===chapterId)&&(active(row.status)||this.running.has(row.id)))) {
      throw new AppError(409,'AI_JOB_ACTIVE','仍有 AI 任务正在运行，请取消任务并等待结束后再删除。');
    }
  }
  async close():Promise<void> {
    if(this.closed)return;this.closed=true;
    for(const controller of this.testing)controller.abort();
    for(const [id,controller]of this.controllers){const job=this.get(id);if(active(job.status)){job.status='interrupted';job.error='本地服务关闭，生成中断；已收到的文字保留。';this.write(job);}controller.abort();}
    for(const row of this.store.db.prepare("SELECT id FROM ai_jobs WHERE status='queued'").all() as Array<{id:string}>){const job=this.get(row.id);job.status='interrupted';job.error='服务关闭，任务尚未执行。';this.write(job);}
    await Promise.allSettled([...this.running.values(),...this.testWork]);
    for(const listeners of this.listeners.values())for(const listener of listeners)listener.end();this.listeners.clear();
  }

  exportBook(bookId: string): JsonValue { return this.backups.exportBook(bookId); }
  prepareRestore(payload: JsonValue, ids: Record<string,string>): void { this.backups.prepareRestore(payload, ids); }
  restoreBook(oldBookId: string, newBookId: string, ids: Record<string,string>, payload: JsonValue): void { this.backups.restoreBook(oldBookId, newBookId, ids, payload); }
  validateRestoredSkillBindings(bookId: string): void { this.backups.validateRestoredSkillBindings(bookId); }

}

export function registerAiRoutes(app:FastifyInstance,store:Store,options:AiOptions={}):AiService {
  const service=new AiService(store,options);
  app.get('/api/model',async()=>({settings:service.settings()}));
  app.get('/api/models',async()=>service.connections());
  app.post('/api/models',async(request,reply)=>reply.code(201).send({settings:service.addConnection(inputs.modelSettings(request.body))}));
  app.post('/api/models/:connectionId/activate',async(request)=>({settings:service.activate(param(request,'connectionId'))}));
  app.get('/api/models/:connectionId/catalog',async(request)=>service.catalog(param(request,'connectionId')));
  app.put('/api/model',async(request)=>({settings:service.updateSettings(inputs.modelSettings(request.body))}));
  app.post('/api/model/test',async()=>service.test());
  app.get('/api/books/:bookId/jobs',async(request)=>({jobs:service.list(param(request,'bookId'))}));
  app.get('/api/chapters/:chapterId/jobs',async(request)=>({jobs:service.listChapter(param(request,'chapterId'))}));
  app.post('/api/jobs',async(request,reply)=>reply.code(201).send({job:service.create(inputs.createJob(request.body))}));
  app.post('/api/jobs/preview',async(request)=>({preview:service.preview(inputs.createJob(request.body))}));
  app.get('/api/jobs/:jobId',async(request)=>({job:service.get(param(request))}));
  app.get('/api/jobs/:jobId/evaluation-sample',async(request)=>{
    const job=service.get(param(request));
    const row=store.db.prepare('SELECT input,settings FROM ai_jobs WHERE id=?').get(job.id) as {input:string;settings:string|null};
    let parameters:CreativeEvaluationSample['parameters']=null;
    if(row.settings){const saved=JSON.parse(row.settings) as ModelSettings;const {hasApiKey:_privateFlag,...publicSettings}=saved;parameters=publicSettings;}
    const sample:CreativeEvaluationSample={format:'shujian-creative-evaluation',version:1,exportedAt:timestamp(),sourceJobId:job.id,task:job.kind,input:JSON.parse(row.input) as CreateAiJobInput,prompt:job.promptSnapshot??null,context:job.context,output:job.output,model:job.model,inputVersion:job.inputVersion,parameters,status:job.status,calls:service.calls(job.id)};
    return sample;
  });
  app.get('/api/jobs/:jobId/calls',async(request)=>({calls:service.calls(param(request))}));
  app.post('/api/jobs/:jobId/cancel',async(request)=>({job:service.cancel(param(request))}));
  app.post('/api/jobs/:jobId/retry',async(request,reply)=>reply.code(201).send({job:service.retry(param(request))}));
  app.post('/api/jobs/:jobId/apply',async(request)=>service.apply(param(request),inputs.applyJob(request.body)));
  app.get('/api/jobs/:jobId/events',async(request,reply)=>{
    const id=param(request);service.get(id);
    const raw=request.headers['last-event-id'];const query=validate.object(request.query);
    const value=typeof raw==='string'?Number(raw):Number(query.after??0);const last=Number.isSafeInteger(value)&&value>=0?value:0;
    reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
    const unsubscribe=service.subscribe(id,reply.raw,last);reply.raw.on('close',unsubscribe);
  });
  return service;
}
