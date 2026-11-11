import type { AiJob, CreateAiJobInput, JsonValue, SaveStoryEntryInput, StoryEvidence } from '@shujian/contracts';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import type { AiService } from './ai/index.js';
import type { StoryService } from './story/service.js';
import type { AtlasService } from './atlas/service.js';
import { AppError } from './errors.js';
import * as v from './validation.js';
import { evidenceHash, list, parseModelJson, storyInput } from './story/validation.js';
import { creativeHash } from './creative/definitions.js';
import { attributes } from './atlas/card-validation.js';

const normal = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');
export class BackfillService {
  constructor(readonly store: Store, readonly ai: AiService, readonly story: StoryService, readonly atlas: AtlasService) {
    store.db.exec('CREATE TABLE IF NOT EXISTS backfill_runs(job_id TEXT PRIMARY KEY REFERENCES ai_jobs(id),book_id TEXT NOT NULL REFERENCES books(id),chapter_id TEXT NOT NULL REFERENCES chapters(id),revision_id TEXT NOT NULL)');
  }
  isBackfill(id: string): boolean {
    const row = this.store.db.prepare('SELECT input FROM ai_jobs WHERE id=?').get(id) as {input:string}|undefined;
    return !!row && (JSON.parse(row.input) as CreateAiJobInput).backfill === true;
  }
  input(chapterId: string): CreateAiJobInput {
    const chapter = this.store.getChapter(chapterId);
    if (chapter.archivedAt || !chapter.finalizedRevisionId) throw new AppError(409, 'FINAL_REQUIRED', '请先定稿，再从正式正文回填。');
    return {requestId:`backfill:${chapter.id}:${chapter.finalizedRevisionId}:${chapter.version}`,kind:'extract',source:'final',backfill:true,chapterId,expectedVersion:chapter.version,instruction:'分析本章定稿，提取知识实体、实体关系和状态变化，所有候选附精确原文证据。'};
  }
  parse(job: AiJob) {
    if (!this.isBackfill(job.id)) v.invalid('请选择正文回填任务。');
    const source = job.context.find(item => item.id === 'chapter');
    if (!source?.revisionId) v.invalid('缺少正文快照。');
    const revision = this.store.getRevision(job.chapterId, source.revisionId);
    if (revision.kind !== 'final') v.invalid('回填来源必须是定稿。');
    const chapter = this.store.getChapter(job.chapterId);
    const evidence = (value: unknown): StoryEvidence[] => {
      const result = list(value, '原文证据', 20).map(value => {
        const row = v.object(value); const quote = v.string(row.quote, '原文摘录', 5000, 1);
        return {chapterId:chapter.id,revisionId:revision.id,paragraphId:v.string(row.paragraphId,'段落',128,1),quote,hash:evidenceHash(quote)};
      });
      if (!result.length) v.invalid('每条候选都必须有原文证据。');
      this.story.checkEvidence(job.bookId, result, false);
      return result;
    };
    const raw = parseModelJson(job.output);
    const keys = new Set<string>();
    const entries = list(raw.entries,'知识实体',60).map(value => {
      const row=v.object(value);const key=v.string(row.key,'实体键',100,1);
      if(keys.has(key))v.invalid('实体键重复。');keys.add(key);
      const entry=storyInput({...row,content:v.string(row.content,'实体事实',1990,1),authority:'fact',visibility:'author',knownBy:[],status:'confirmed',validFromChapter:chapter.position,evidence:evidence(row.evidence)});
      return {key,entry};
    });
    const key = (value:unknown) => {const id=v.string(value,'实体引用',100,1);if(!keys.has(id))v.invalid('关系或状态引用了未提取的实体。');return id;};
    const relations = list(raw.relations??[],'实体关系',60).map(value=>{const row=v.object(value);if(typeof row.symmetric!=='boolean')v.invalid('关系方向不正确。');const fromKey=key(row.fromKey),toKey=key(row.toKey);if(fromKey===toKey)v.invalid('关系双方不能相同。');return {fromKey,toKey,label:v.string(row.label,'关系',100,1),description:v.string(row.description??'','关系说明',10000),symmetric:row.symmetric,evidence:evidence(row.evidence)};});
    const states = list(raw.states??[],'状态变化',60).map(value=>{const row=v.object(value);return {nodeKey:key(row.nodeKey),summary:v.string(row.summary,'状态变化',2000,1),changes:attributes(row.changes??{}),evidence:evidence(row.evidence)};});
    return {revisionId:revision.id,chapter,entries,relations,states};
  }
  preview(id: string) {
    const job=this.ai.get(id);if(job.status!=='succeeded')throw new AppError(409,'TASK_NOT_READY','任务尚未成功完成。');
    const parsed=this.parse(job);
    if(parsed.chapter.archivedAt||parsed.chapter.finalizedRevisionId!==parsed.revisionId)throw new AppError(409,'SOURCE_CHANGED','定稿来源已变化，请重新分析。');
    const graph=this.atlas.bundle(job.bookId);
    const entries=parsed.entries.map(item=>({...item,matches:graph.nodes.filter(node=>node.status!=='withdrawn'&&node.kind===item.entry.kind&&[node.title,...node.aliases].some(name=>[item.entry.title,...item.entry.aliases??[]].some(other=>normal(name)===normal(other)))).map(node=>({id:node.id,title:node.title,content:node.content,version:node.version,needsReview:node.needsReview}))}));
    return {...parsed,entries,jobId:id,applied:!!this.store.db.prepare('SELECT job_id FROM backfill_runs WHERE job_id=?').get(id),fingerprint:creativeHash({job:job.output,revision:parsed.revisionId,graph}),existingNodes:graph.nodes.filter(node=>node.status!=='withdrawn').map(node=>({id:node.id,title:node.title,kind:node.kind,content:node.content,needsReview:node.needsReview})),existingRelations:graph.relations,existingStates:graph.states};
  }
  apply(id:string,value:unknown) {
    return this.store.db.transaction(()=>{
      const job=this.ai.get(id);
      if(this.store.db.prepare('SELECT job_id FROM backfill_runs WHERE job_id=?').get(id))return {alreadyApplied:true};
      const body=v.object(value);const preview=this.preview(id);
      if(body.fingerprint!==preview.fingerprint)throw new AppError(409,'PREVIEW_CHANGED','正文或资料图谱已变化，请重新查看差异。');
      const mapping=v.object(body.mapping??{});const ids=new Map<string,string>();
      const additions:Array<{nodeId:string;summary:string;changes:Record<string,string>;evidence:StoryEvidence[]}>=[];
      for(const item of preview.entries){
        const selected=mapping[item.key];
        if(selected===undefined&&item.matches.length>1)v.invalid('同名实体存在多个匹配，请明确选择。');
        const target=selected===null?null:typeof selected==='string'?this.story.getEntry(selected):item.matches.length===1?this.story.getEntry(item.matches[0]!.id):null;
        if(target&&(target.bookId!==job.bookId||target.kind!==item.entry.kind||target.status==='withdrawn'))v.invalid('实体匹配不属于本作品或类型不一致。');
        if(target){
          if(target.status!=='confirmed')v.invalid('匹配卡片尚未确认，请先确认原卡片，或选择新增独立实体。');
          if([...ids.values()].includes(target.id))v.invalid('不能把本次两个不同实体合并到同一张卡片。');
          ids.set(item.key,target.id);
          if(!target.content.includes(item.entry.content))additions.push({nodeId:target.id,summary:`补充事实：${item.entry.content}`,changes:{},evidence:item.entry.evidence??[]});
        }else ids.set(item.key,this.story.saveEntry(job.bookId,item.entry).id);
      }
      const common={phase:'confirmed',visibility:'author',knownBy:[],fromChapter:preview.chapter.position,sourceJobId:id};
      const graph=this.atlas.bundle(job.bookId);
      for(const relation of preview.relations){const fromId=ids.get(relation.fromKey)!,toId=ids.get(relation.toKey)!;
        const previous=graph.relations.find(record=>record.phase==='confirmed'&&record.fromId===fromId&&record.toId===toId&&record.label===relation.label&&record.symmetric===relation.symmetric&&record.fromChapter===preview.chapter.position);
        this.atlas.save('relation',job.bookId,{...relation,...common,fromId,toId,expectedVersion:previous?.version},previous?.id);
      }
      for(const state of [...preview.states.map(state=>({...state,nodeId:ids.get(state.nodeKey)!})),...additions]){const nodeId=state.nodeId;
        const previous=graph.states.find(record=>record.phase==='confirmed'&&record.nodeId===nodeId&&record.fromChapter===preview.chapter.position&&record.summary===state.summary);
        this.atlas.save('state',job.bookId,{...state,...common,nodeId,expectedVersion:previous?.version},previous?.id);
      }
      this.store.db.prepare('INSERT INTO backfill_runs(job_id,book_id,chapter_id,revision_id) VALUES(?,?,?,?)').run(id,job.bookId,job.chapterId,preview.revisionId);
      return {alreadyApplied:false,entities:ids.size,relations:preview.relations.length,states:preview.states.length+additions.length};
    })();
  }
  exportBook(bookId:string):JsonValue {return this.store.db.prepare('SELECT job_id,chapter_id,revision_id FROM backfill_runs WHERE book_id=?').all(bookId) as JsonValue;}
  restoreBook(value:unknown,bookId:string,ids:Record<string,string>):void {
    if(value===undefined)return;
    for(const valueRow of list(value,'回填记录',100000)){const row=v.object(valueRow);const mapped=(name:string)=>ids[v.string(row[name],'回填关联',128,1)]??v.invalid('回填关联缺失。');
      const jobId=mapped('job_id'),chapterId=mapped('chapter_id'),revisionId=mapped('revision_id');
      if(this.ai.get(jobId).bookId!==bookId||this.ai.get(jobId).chapterId!==chapterId||this.store.getChapter(chapterId).bookId!==bookId)v.invalid('回填记录不属于恢复作品。');if(!this.isBackfill(jobId)||this.ai.get(jobId).status!=='succeeded'||this.parse(this.ai.get(jobId)).revisionId!==revisionId)v.invalid('回填来源任务或定稿不正确。');
      this.store.db.prepare('INSERT INTO backfill_runs(job_id,book_id,chapter_id,revision_id) VALUES(?,?,?,?)').run(jobId,bookId,chapterId,revisionId);
    }
  }
}

export function registerBackfill(app:FastifyInstance,service:BackfillService){
  const param=(value:unknown,key:string)=>v.string(v.object(value)[key],'记录ID',128,1);
  app.get('/api/books/:bookId/backfill',async request=>{
    const bookId=param(request.params,'bookId');
    const jobs=service.store.db.prepare('SELECT job,input FROM ai_jobs WHERE book_id=? ORDER BY created_at DESC,rowid DESC').all(bookId) as {job:string;input:string}[];
    const runs=service.store.db.prepare('SELECT chapter_id,revision_id FROM backfill_runs WHERE book_id=?').all(bookId) as {chapter_id:string;revision_id:string}[];
    return {chapters:service.store.listChapters(bookId).map(chapter=>({...chapter,applied:runs.some(run=>run.chapter_id===chapter.id&&run.revision_id===chapter.finalizedRevisionId)})),jobs:jobs.filter(row=>(JSON.parse(row.input) as CreateAiJobInput).backfill).map(row=>JSON.parse(row.job) as AiJob)};
  });
  app.post('/api/chapters/:chapterId/backfill/preview',async request=>({preview:service.ai.preview(service.input(param(request.params,'chapterId')))}));
  app.post('/api/chapters/:chapterId/backfill/start',async request=>{
    const input=service.input(param(request.params,'chapterId'));const fingerprint=v.string(v.object(request.body).fingerprint,'材料指纹',64,64);
    return {job:service.ai.create({...input,previewFingerprint:fingerprint})};
  });
  app.get('/api/jobs/:jobId/backfill',async request=>service.preview(param(request.params,'jobId')));
  app.post('/api/jobs/:jobId/backfill/apply',async request=>service.apply(param(request.params,'jobId'),request.body));
}
