import { randomUUID } from 'node:crypto';
import type { AtlasBundle, AtlasEvent, AtlasLinks, AtlasRelation, AtlasState, AtlasView, Chapter, ContextItem, CreateAiJobInput, JsonValue, StoryEntry, StoryEvidence } from '@shujian/contracts';
import { AppError, notFound } from '../errors.js';
import type { Store } from '../store.js';
import type { StoryService } from '../story/service.js';
import type { PlanningService } from '../planning.js';
import type { CreativeService } from '../creative/service.js';
import * as v from '../validation.js';
import { parseModelJson } from '../story/validation.js';
import { ids } from './card-validation.js';
import { relation as parseRelation, state as parseState } from './validation.js';

type Kind='relation'|'state';
type RecordValue=AtlasRelation|AtlasState;
const tables={relation:'atlas_relations',state:'atlas_states'} as const;
const now=()=>new Date().toISOString();
const json=<T>(value:unknown):T=>JSON.parse((value as {payload:string}).payload) as T;
const normal=(text:string)=>text.normalize('NFKC').toLocaleLowerCase();

export class AtlasService {
  constructor(readonly store:Store,readonly story:StoryService,readonly plans:PlanningService,readonly creative:CreativeService){
    store.db.exec(`CREATE TABLE IF NOT EXISTS atlas_relations(id TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES books(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS atlas_states(id TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES books(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS atlas_events(id TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES books(id),record_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS atlas_views(book_id TEXT PRIMARY KEY REFERENCES books(id),payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS atlas_relations_book ON atlas_relations(book_id);
      CREATE INDEX IF NOT EXISTS atlas_states_book ON atlas_states(book_id);
      CREATE INDEX IF NOT EXISTS atlas_events_record ON atlas_events(book_id,record_id);`);
    story.beforeEntryChange=(entry,previous)=>this.validateCard(entry,previous);
  }
  nodes(bookId:string):StoryEntry[]{return this.story.search(bookId,{includeWithdrawn:true}).entries;}
  records<K extends Kind>(bookId:string,kind:K):(K extends 'relation'?AtlasRelation:AtlasState)[]{
    this.store.getBook(bookId);return this.store.db.prepare(`SELECT payload FROM ${tables[kind]} WHERE book_id=? ORDER BY rowid`).all(bookId).map(row=>this.current(json<RecordValue>(row))) as (K extends 'relation'?AtlasRelation:AtlasState)[];
  }
  get(kind:Kind,id:string):RecordValue{
    const row=this.store.db.prepare(`SELECT payload FROM ${tables[kind]} WHERE id=?`).get(id);return row?this.current(json<RecordValue>(row)):notFound('图谱记录');
  }
  private stale(evidence:StoryEvidence[]):boolean{return evidence.some(source=>{try{return this.store.getChapter(source.chapterId).finalizedRevisionId!==source.revisionId;}catch{return true;}});}
  private current<T extends RecordValue>(record:T):T{
    const nodeIds='fromId' in record?[record.fromId,record.toId]:[record.nodeId];
    return {...record,needsReview:this.stale(record.evidence)||nodeIds.some(id=>{try{return this.story.getEntry(id).needsReview;}catch{return true;}})};
  }
  view(bookId:string):AtlasView{
    this.store.getBook(bookId);const row=this.store.db.prepare('SELECT payload FROM atlas_views WHERE book_id=?').get(bookId);
    return row?json<AtlasView>(row):{bookId,version:0,positions:{},selectedNodeIds:[],branch:'主线',updatedAt:''};
  }
  bundle(bookId:string):AtlasBundle{return {nodes:this.nodes(bookId),relations:this.records(bookId,'relation'),states:this.records(bookId,'state'),view:this.view(bookId),plans:this.plans.list(bookId),voices:this.creative.profile(bookId).voices};}
  private node(bookId:string,id:string):StoryEntry{const node=this.story.getEntry(id);if(node.bookId!==bookId)v.invalid('卡片不属于本作品。');return node;}
  validateCard(entry:StoryEntry,previous?:StoryEntry):void{
    const links=entry.links??{};
    if(links.voiceId&&entry.status!=='withdrawn'&&(entry.kind!=='character'||!this.creative.profile(entry.bookId).voices.some(voice=>voice.id===links.voiceId)))v.invalid('人物声音关联不存在或不属于此人物卡。');
    if(links.planId){const plan=this.plans.get(links.planId);if(entry.kind!=='scene'||plan.bookId!==entry.bookId||plan.level!=='scene')v.invalid('请关联本作品的场景规划。');}
    for(const id of links.chapterIds??[])if(this.store.getChapter(id).bookId!==entry.bookId)v.invalid('关联章节不属于本作品。');
    if(links.parentId){
      if(!['location','organization'].includes(entry.kind))v.invalid('上级归属用于地点或组织；其他关联请添加关系。');
      const seen=new Set([entry.id]);let id:string|undefined=links.parentId;
      while(id){if(seen.has(id))v.invalid('上级归属不能形成循环。');seen.add(id);const parent=this.node(entry.bookId,id);if(parent.kind!==entry.kind||parent.status==='withdrawn')v.invalid('上级必须是同类型、未撤回的卡片。');id=parent.links?.parentId;}
    }
    if(previous&&entry.status!=='confirmed'){
      const references=this.records(entry.bookId,'relation').some(edge=>edge.phase==='confirmed'&&(edge.fromId===entry.id||edge.toId===entry.id))||this.records(entry.bookId,'state').some(state=>state.phase==='confirmed'&&state.nodeId===entry.id);
      if(references)throw new AppError(409,'CARD_IN_USE','此卡片仍有已确认的关系或状态，请先处理关联，再撤回或转为构思。');
    }
    if(previous&&entry.status==='withdrawn'&&this.nodes(entry.bookId).some(node=>node.status!=='withdrawn'&&node.links?.parentId===entry.id))throw new AppError(409,'CARD_IN_USE','请先处理下级地点或组织的归属。');
    if(previous&&entry.status==='confirmed'&&(this.records(entry.bookId,'relation').some(edge=>edge.phase==='confirmed'&&(edge.fromId===entry.id||edge.toId===entry.id)&&edge.fromChapter<entry.validFromChapter)||this.records(entry.bookId,'state').some(state=>state.phase==='confirmed'&&state.nodeId===entry.id&&state.fromChapter<entry.validFromChapter)))v.invalid('卡片的生效章节不能晚于已确认关系或状态，请先调整这些记录的阶段。');
  }
  validateVoices(bookId:string,voiceIds:string[]):void{
    if(this.nodes(bookId).some(node=>node.status!=='withdrawn'&&node.links?.voiceId&&!voiceIds.includes(node.links.voiceId)))throw new AppError(409,'VOICE_IN_USE','人物卡仍关联此声音，请先在卡片中解除关联。');
  }
  private validate(kind:Kind,record:RecordValue,requireCurrent=true,historical=false):void{
    const nodeIds=kind==='relation'?[(record as AtlasRelation).fromId,(record as AtlasRelation).toId]:[(record as AtlasState).nodeId];
    const nodes=nodeIds.map(id=>this.node(record.bookId,id));
    if(kind==='relation'&&nodeIds[0]===nodeIds[1])v.invalid('请选择两个不同的卡片。');
    if(!historical&&record.phase!=='withdrawn'&&nodes.some(node=>node.status==='withdrawn'))v.invalid('关联卡片已撤回。');
    if(!historical&&record.phase==='confirmed'&&nodes.some(node=>node.status!=='confirmed'))v.invalid('请先确认关系或状态所涉及的卡片。');
    if(record.phase==='confirmed'&&nodes.some(node=>node.validFromChapter>record.fromChapter))v.invalid('关系或状态不能早于卡片开始适用的章节。');
    this.story.checkEvidence(record.bookId,record.evidence,requireCurrent&&record.phase==='confirmed');
    if(record.phase==='confirmed'&&record.evidence.some(source=>this.store.getChapter(source.chapterId).position>record.fromChapter))v.invalid('原文证据晚于记录的生效章节。');
    if(record.sourceJobId){const row=this.store.db.prepare('SELECT book_id FROM ai_jobs WHERE id=?').get(record.sourceJobId) as {book_id:string}|undefined;if(!row||row.book_id!==record.bookId)v.invalid('建议来源任务不属于本作品。');}
  }
  private put(kind:Kind,record:RecordValue):void{
    this.store.db.prepare(`INSERT INTO ${tables[kind]}(id,book_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(record.id,record.bookId,JSON.stringify(record));
  }
  private event(kind:Kind,record:RecordValue):void{
    const event:AtlasEvent={id:randomUUID(),bookId:record.bookId,kind,recordId:record.id,snapshot:record,createdAt:now()};
    this.store.db.prepare('INSERT INTO atlas_events(id,book_id,record_id,payload) VALUES(?,?,?,?)').run(event.id,event.bookId,event.recordId,JSON.stringify(event));
  }
  save(kind:'relation',bookId:string,value:unknown,id?:string):AtlasRelation;
  save(kind:'state',bookId:string,value:unknown,id?:string):AtlasState;
  save(kind:Kind,bookId:string,value:unknown,id?:string):RecordValue{
    const input=kind==='relation'?parseRelation(value):parseState(value);
    return this.store.db.transaction(()=>{
      this.store.getBook(bookId);const previous=id?this.get(kind,id):undefined;
      if(previous&&previous.bookId!==bookId)v.invalid('图谱记录不属于本作品。');
      if(previous&&previous.version!==input.expectedVersion)throw new AppError(409,'VERSION_CONFLICT','图谱记录已更新，请保留填写并重新读取。',previous.version);
      const {expectedVersion:_expected,...fields}=input;const time=now();
      const record={...fields,id:previous?.id??randomUUID(),bookId,version:(previous?.version??0)+1,createdAt:previous?.createdAt??time,updatedAt:time,needsReview:false} as RecordValue;
      this.validate(kind,record);this.put(kind,record);this.event(kind,record);return this.current(record);
    })();
  }
  history(kind:Kind,id:string):AtlasEvent[]{const record=this.get(kind,id);return this.store.db.prepare('SELECT payload FROM atlas_events WHERE book_id=? AND record_id=? ORDER BY rowid').all(record.bookId,id).map(row=>json<AtlasEvent>(row));}
  restore(kind:Kind,id:string,eventId:string,expectedVersion:number):RecordValue{
    const saved=this.history(kind,id).find(event=>event.id===eventId&&event.kind===kind)??notFound('图谱历史');
    return kind==='relation'?this.save(kind,saved.bookId,{...saved.snapshot,expectedVersion},id):this.save(kind,saved.bookId,{...saved.snapshot,expectedVersion},id);
  }
  evolve(id:string,value:unknown):AtlasRelation{
    const input=parseRelation(value);return this.store.db.transaction(()=>{
      const previous=this.get('relation',id) as AtlasRelation;
      if(previous.phase!=='confirmed'||input.phase!=='confirmed'||input.fromChapter<=previous.fromChapter||previous.toChapter!==null&&input.fromChapter>previous.toChapter+1)v.invalid('请在更晚章节记录连续的已确认关系变化；间隔后的新关系请独立添加。');
      if(input.fromId!==previous.fromId||input.toId!==previous.toId)v.invalid('关系变化必须保留原来的双方。');
      this.save('relation',previous.bookId,{...previous,toChapter:input.fromChapter-1,expectedVersion:input.expectedVersion},id);
      return this.save('relation',previous.bookId,{...input,expectedVersion:undefined});
    })();
  }
  saveView(bookId:string,value:unknown):AtlasView{
    const row=v.object(value);const expected=v.integer(row.expectedVersion,'图谱布局版本',0);const raw=v.object(row.positions,'节点位置');
    if(Object.keys(raw).length>5000)v.invalid('保存的位置过多。');const positions:AtlasView['positions']={};
    for(const [id,position] of Object.entries(raw)){this.node(bookId,id);const point=v.object(position);for(const key of ['x','y'])if(typeof point[key]!=='number'||!Number.isFinite(point[key])||Number(point[key])<0||Number(point[key])>1)v.invalid('节点位置应在画布范围内。');positions[id]={x:point.x as number,y:point.y as number};}
    const selected=ids(row.selectedNodeIds??[],'选中卡片',30);selected.forEach(id=>this.node(bookId,id));
    const branch=v.string(row.branch??'主线','构思方案',80,1);
    return this.store.db.transaction(()=>{const previous=this.view(bookId);if(previous.version!==expected)throw new AppError(409,'VERSION_CONFLICT','图谱布局已在其他页面更新，请保留本页布局并重新读取。',previous.version);
      const view:AtlasView={bookId,version:expected+1,positions,selectedNodeIds:selected,branch,updatedAt:now()};this.store.db.prepare('INSERT INTO atlas_views(book_id,payload) VALUES(?,?) ON CONFLICT(book_id) DO UPDATE SET payload=excluded.payload').run(bookId,JSON.stringify(view));return view;
    })();
  }
  fromPlan(bookId:string,planId:string):StoryEntry{
    const plan=this.plans.get(planId);if(plan.bookId!==bookId||plan.level!=='scene')v.invalid('请选择本作品的场景规划。');
    return this.store.db.transaction(()=>{const existing=this.nodes(bookId).find(node=>node.links?.planId===planId&&node.status!=='withdrawn');if(existing)return existing;
      return this.story.saveEntry(bookId,{kind:'scene',authority:'plan',title:plan.title,content:'此场景关联已有规划，规划正文在原入口维护。',status:'idea',links:{planId,...(plan.chapterId?{chapterIds:[plan.chapterId]}:{})},validFromChapter:plan.chapterId?this.store.getChapter(plan.chapterId).position:1});
    })();
  }
  mentions(bookId:string,id:string){
    const node=this.node(bookId,id);const linked=new Set([...(node.links?.chapterIds??[]),...node.evidence.map(source=>source.chapterId)]);
    const plan=node.links?.planId?this.plans.get(node.links.planId):null;if(plan?.chapterId)linked.add(plan.chapterId);
    const names=[node.title,...node.aliases].map(normal).filter(Boolean);
    return this.store.listChapters(bookId).filter(chapter=>{if(linked.has(chapter.id))return true;const text=normal(this.store.getChapter(chapter.id).plainText);return names.some(name=>text.includes(name));});
  }
  importJob(bookId:string,jobId:string):AtlasRelation[]{
    const row=this.store.db.prepare('SELECT job,input FROM ai_jobs WHERE id=?').get(jobId) as {job:string;input:string}|undefined;if(!row)notFound('讨论任务');
    const job=JSON.parse(row.job) as {bookId:string;status:string;output:string;context:ContextItem[]};const input=JSON.parse(row.input) as CreateAiJobInput;
    if(job.bookId!==bookId||job.status!=='succeeded'||input.kind!=='discuss'||!input.atlas)v.invalid('请选择基于图谱材料完成的本作品讨论。');
    const parsed=parseModelJson(job.output);if(!Array.isArray(parsed.relations)||parsed.relations.length>30)v.invalid('模型未返回约定的关系建议，请保留原输出，或手工添加。');const candidates=parsed.relations;
    const allowed=new Set(job.context.flatMap(item=>item.entryId?[item.entryId]:[]));
    return this.store.db.transaction(()=>candidates.map(raw=>{
      const value=v.object(raw);const from=v.string(value.fromId,'建议起点',128,1),to=v.string(value.toId,'建议终点',128,1);if(!allowed.has(from)||!allowed.has(to))v.invalid('模型建议引用了本次实际材料之外的卡片。');
      const label=v.string(value.label,'关系含义',100,1).trim();const duplicate=this.records(bookId,'relation').find(edge=>edge.sourceJobId===jobId&&edge.fromId===from&&edge.toId===to&&edge.label===label);if(duplicate)return duplicate;
      return this.save('relation',bookId,{...value,label,fromChapter:this.store.getChapter(input.chapterId).position,branch:input.atlas!.branch,phase:'idea',visibility:'author',knownBy:[],sourceJobId:jobId,evidence:[],symmetric:value.symmetric===true});
    }))();
  }
  context(input:CreateAiJobInput,chapter:Chapter):{transform:(node:StoryEntry)=>StoryEntry;allowedIds:Set<string>|undefined;items:ContextItem[]}{
    const all=this.nodes(chapter.bookId),relations=this.records(chapter.bookId,'relation'),states=this.records(chapter.bookId,'state');
    const planning=['discuss','plan','review','extract'].includes(input.kind);
    const visible=(record:{visibility:string;knownBy:string[];evidence:StoryEvidence[]},from:number)=>from<=chapter.position&&(planning||record.visibility!=='author')&&(record.visibility!=='characters'||!!input.pov&&record.knownBy.some(name=>normal(name)===normal(input.pov!)))&&!record.evidence.some(source=>this.store.getChapter(source.chapterId).position>chapter.position);
    const selected=new Set(input.atlas?.nodeIds??[]);const selectedEdges=new Set(input.atlas?.relationIds??[]);
    for(const id of selected)this.node(chapter.bookId,id);
    for(const id of selectedEdges){const edge=this.get('relation',id) as AtlasRelation;if(edge.bookId!==chapter.bookId)v.invalid('所选关系不属于本作品。');selected.add(edge.fromId);selected.add(edge.toId);}
    const eligible=all.filter(node=>node.status!=='withdrawn'&&!node.needsReview&&visible(node,node.validFromChapter)&&(node.status==='confirmed'||!!input.atlas?.includeIdeas&&selected.has(node.id)&&(node.branch??'主线')===input.atlas.branch));
    const eligibleIds=new Set(eligible.map(node=>node.id));const items:ContextItem[]=[];
    const allowedIds=input.atlas?new Set([...selected].filter(id=>eligibleIds.has(id))):undefined;
    const applicable=states.filter(state=>state.phase==='confirmed'&&!state.needsReview&&visible(state,state.fromChapter)).sort((a,b)=>a.fromChapter-b.fromChapter||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    const byNode=new Map<string,AtlasState[]>();for(const state of applicable)byNode.set(state.nodeId,[...(byNode.get(state.nodeId)??[]),state]);
    const transform=(node:StoryEntry):StoryEntry=>{
      const history=byNode.get(node.id)??[];if(!history.length)return node;
      const attributes={...node.attributes};for(const state of history)Object.assign(attributes,state.changes);
      const latest=history.at(-1)!;return {...node,attributes,content:node.content+`\n本章剧情状态（第 ${latest.fromChapter} 章起，优先于固定档案中的旧状态）：${latest.summary}`};
    };
    for(const node of eligible.filter(node=>node.status==='idea'&&selected.has(node.id))){
      const effective=transform(node);const attrs=Object.fromEntries(Object.entries(effective.attributes??{}).filter(([key])=>planning||key!=='secret'));
      items.push({id:`atlas-idea:${node.id}:v${node.version}`,entryId:node.id,label:`作者本次选用的假设 · ${node.title} · 方案 ${node.branch??'主线'}（尚未确认，不是正式事实）`,source:'canon',text:`卡片ID：${node.id}\n${effective.content}\n${JSON.stringify(attrs)}`,required:true});
    }
    const terms=normal(input.instruction+' '+chapter.outline);const related=(edge:AtlasRelation)=>[edge.fromId,edge.toId].some(id=>{const node=all.find(node=>node.id===id);return input.pinnedEntryIds?.includes(id)||node&&[node.title,...node.aliases].some(name=>terms.includes(normal(name)));});
    for(const edge of relations){
      if(edge.phase==='withdrawn'||edge.needsReview||!eligibleIds.has(edge.fromId)||!eligibleIds.has(edge.toId)||!visible(edge,edge.fromChapter)||edge.toChapter!==null&&edge.toChapter<chapter.position)continue;
      const explicitlySelected=selectedEdges.has(edge.id)||!!input.atlas&&selected.has(edge.fromId)&&selected.has(edge.toId);
      if(input.atlas&&!explicitlySelected||!input.atlas&&!related(edge))continue;
      if(edge.phase==='idea'&&(!input.atlas?.includeIdeas||edge.branch!==input.atlas.branch))continue;
      const from=all.find(node=>node.id===edge.fromId)!,to=all.find(node=>node.id===edge.toId)!;
      items.push({id:`atlas-relation:${edge.id}:v${edge.version}`,entryId:from.id,label:`${edge.phase==='idea'?'本次构思假设（未确认）':'作者确认关系'} · ${from.title} ${edge.symmetric?'↔':'→'} ${to.title}`,source:'canon',text:`起点卡片ID：${from.id}；终点卡片ID：${to.id}\n关系：${edge.label}；${edge.symmetric?'双方对称':'仅由起点指向终点，不推断反向态度'}。${edge.description}\n适用：第 ${edge.fromChapter} 章至 ${edge.toChapter??'后续'}；故事时间：${edge.storyTime||'未填写'}${edge.phase==='idea'?'\n仅按作者本次选择作为方案假设，不得宣称已经在正文中发生。':''}`,required:!!input.atlas});
    }
    return {transform,allowedIds,items};
  }
  exportBook(bookId:string):JsonValue{
    const events=this.store.db.prepare('SELECT payload FROM atlas_events WHERE book_id=? ORDER BY rowid').all(bookId).map(row=>json<AtlasEvent>(row));
    return JSON.parse(JSON.stringify({version:1,relations:this.records(bookId,'relation'),states:this.records(bookId,'state'),events,view:this.view(bookId)})) as JsonValue;
  }
  prepareRestore(value:unknown,idMap:Record<string,string>):void{
    if(value===undefined)return;const row=v.object(value,'图谱备份');if(row.version!==1)v.invalid('图谱备份版本不支持。');
    for(const key of ['relations','states','events']){const values=row[key];if(!Array.isArray(values)||values.length>100000)v.invalid('图谱备份列表格式不正确。');for(const value of values){const id=v.string(v.object(value).id,'图谱记录ID',128,1);if(idMap[id])v.invalid('图谱备份ID重复。');idMap[id]=randomUUID();}}
  }
  restoreBook(oldBookId:string,newBookId:string,idMap:Record<string,string>,value:unknown):void{
    if(value===undefined){this.validateBook(newBookId);return;}
    const row=v.object(value);const mapped=(id:string)=>idMap[id]??v.invalid('图谱备份关联缺失。');
    const parse=(kind:Kind,value:unknown):RecordValue=>{
      const raw=v.object(value);if(raw.bookId!==oldBookId)v.invalid('图谱记录所属作品不正确。');
      const input=kind==='relation'?parseRelation(raw):parseState(raw);const {expectedVersion:_expected,...fields}=input;
      const evidence=fields.evidence.map(source=>({...source,chapterId:mapped(source.chapterId),revisionId:mapped(source.revisionId)}));
      return {...fields,id:mapped(v.string(raw.id,'记录ID',128,1)),bookId:newBookId,evidence,sourceJobId:fields.sourceJobId?mapped(fields.sourceJobId):null,version:v.integer(raw.version,'记录版本',1),createdAt:v.string(raw.createdAt,'创建时间',40,1),updatedAt:v.string(raw.updatedAt,'更新时间',40,1),needsReview:false,...(kind==='relation'?{fromId:mapped((input as AtlasRelation).fromId),toId:mapped((input as AtlasRelation).toId)}:{nodeId:mapped((input as AtlasState).nodeId)})} as RecordValue;
    };
    for(const kind of ['relation','state'] as const)for(const raw of row[kind==='relation'?'relations':'states'] as unknown[]){const record=parse(kind,raw);this.validate(kind,record,false);this.put(kind,record);}
    for(const value of row.events as unknown[]){const raw=v.object(value);if(raw.bookId!==oldBookId||!['relation','state'].includes(String(raw.kind)))v.invalid('图谱历史格式不正确。');const kind=raw.kind as Kind;
      const snapshot=parse(kind,raw.snapshot),recordId=mapped(v.string(raw.recordId,'历史关联',128,1));if(snapshot.id!==recordId||snapshot.version>this.get(kind,recordId).version)v.invalid('图谱历史版本或引用不正确。');this.validate(kind,snapshot,false,true);
      const event:AtlasEvent={id:mapped(v.string(raw.id,'历史ID',128,1)),bookId:newBookId,kind,recordId,snapshot,createdAt:v.string(raw.createdAt,'历史时间',40,1)};
      this.store.db.prepare('INSERT INTO atlas_events(id,book_id,record_id,payload) VALUES(?,?,?,?)').run(event.id,newBookId,recordId,JSON.stringify(event));
    }
    for(const kind of ['relation','state'] as const)for(const record of this.records(newBookId,kind)){
      const history=this.history(kind,record.id);const versions=new Set(history.map(event=>event.snapshot.version));
      if(history.length!==record.version||versions.size!==record.version||!Array.from({length:record.version},(_,index)=>index+1).every(version=>versions.has(version)))v.invalid('图谱备份的修订历史不完整或重复。');
      const last=history.find(event=>event.snapshot.version===record.version)!.snapshot;
      const comparable=(value:RecordValue)=>JSON.stringify({...value,needsReview:false});
      if(comparable(last)!==comparable(record))v.invalid('图谱备份的当前记录与历史末版不一致。');
    }
    const view=v.object(row.view);if(view.bookId!==oldBookId)v.invalid('布局所属作品不正确。');const positions=v.object(view.positions);const remapped:AtlasView['positions']={};for(const [id,position] of Object.entries(positions))remapped[mapped(id)]=position as {x:number;y:number};
    const saved=this.saveView(newBookId,{positions:remapped,selectedNodeIds:ids(view.selectedNodeIds,'选中卡片',30).map(mapped),branch:view.branch,expectedVersion:0});saved.version=v.integer(view.version,'布局版本',0);saved.updatedAt=v.string(view.updatedAt,'布局时间',40);
    this.store.db.prepare('UPDATE atlas_views SET payload=? WHERE book_id=?').run(JSON.stringify(saved),newBookId);this.validateBook(newBookId);
  }
  validateBook(bookId:string):void{
    for(const node of this.nodes(bookId))this.validateCard(node);
    for(const edge of this.records(bookId,'relation'))this.validate('relation',edge,false);
    for(const state of this.records(bookId,'state'))this.validate('state',state,false);
  }
}
