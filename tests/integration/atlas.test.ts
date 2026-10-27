import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createServer,type Server } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { beforeEach,afterEach,describe,it,expect } from 'vitest';
import type { AiJob, AtlasBundle, AtlasRelation, AtlasState, Book, Chapter, ContextPreview, CreativeProfile, StoryEntry, WorkspaceBackup } from '@shujian/contracts';
import { storageHarness } from './storage-harness.js';

const harness=storageHarness('atlas');
describe('book setting cards, relation graphs and chapter states',()=>{
  let app:ReturnType<typeof harness.createApp>,fixture:Server,output:string,calls:number;
  beforeEach(async()=>{
    harness.reset();output='隔离讨论样本。';calls=0;
    fixture=createServer(async(req,res)=>{for await(const _part of req){/* local fixture only */}calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:output},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:20}}));});
    await new Promise<void>(done=>fixture.listen(0,'127.0.0.1',done));const address=fixture.address();if(!address||typeof address==='string')throw new Error('Fixture missing');
    const directory=await mkdtemp(resolve(import.meta.dirname,'../../../novel-qa-atlas-'));
    app=harness.createApp({dataDir:join(directory,'data'),credentialDir:join(directory,'private/credentials'),connectionsFile:join(directory,'private/connections.json')});await app.ready();
    const settings=(await ok<{settings:object}>('GET','/api/model')).settings;
    await ok('PUT','/api/model',{...settings,baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'LOCAL_ATLAS_FIXTURE',stream:false,contextWindow:24000,maxOutputTokens:768});
  });
  afterEach(async()=>{await app?.close();fixture.closeAllConnections();await new Promise<void>(done=>fixture.close(()=>done()));});
  async function ok<T>(method:'GET'|'POST'|'PUT',url:string,payload?:object):Promise<T>{const result=await app.inject({method,url,...(payload?{payload}:{})});expect(result.statusCode,result.body).toBeLessThan(300);return result.json<T>();}
  async function setup(){const {book}=await ok<{book:Book}>('POST','/api/books',{title:'图谱工程测试'});const {chapters}=await ok<{chapters:Chapter[]}>('GET',`/api/books/${book.id}/chapters`);const second=(await ok<{chapter:Chapter}>('POST',`/api/books/${book.id}/chapters`,{})).chapter;return {book,chapter:chapters[0]!,second};}
  async function card(bookId:string,title:string,extra:object={}){return (await ok<{entry:StoryEntry}>('POST',`/api/books/${bookId}/story`,{kind:'character',authority:'setting',title,content:title+'的基础设定',...extra})).entry;}
  async function edge(bookId:string,fromId:string,toId:string,extra:object={}){return (await ok<{record:AtlasRelation}>('POST',`/api/books/${bookId}/atlas/relations`,{fromId,toId,label:'认识',symmetric:false,...extra})).record;}
  async function state(bookId:string,nodeId:string,extra:object={}){return (await ok<{record:AtlasState}>('POST',`/api/books/${bookId}/atlas/states`,{nodeId,summary:'状态改变',changes:{},...extra})).record;}
  const bundle=(id:string)=>ok<AtlasBundle>('GET',`/api/books/${id}/atlas`);
  const preview=async(chapter:Chapter,extra:object={})=>(await ok<{preview:ContextPreview}>('POST','/api/jobs/preview',{requestId:randomUUID(),kind:'draft',chapterId:chapter.id,expectedVersion:chapter.version,instruction:'描写甲与乙，遵守本章材料。',...extra})).preview;
  async function finished(id:string){for(let i=0;i<150;i++){const {job}=await ok<{job:AiJob}>('GET',`/api/jobs/${id}`);if(!['queued','running'].includes(job.status))return job;await pause(10);}throw new Error('Fixture timeout');}
  async function backup(){return ok<WorkspaceBackup>('GET','/api/backup');}

  it('reuses existing story IDs for every entity kind and preserves structure through the original editor API',async()=>{
    const {book}=await setup();
    for(const kind of ['character','location','item','organization','scene','note'] as const){const node=await card(book.id,kind,{kind,status:kind==='note'?'idea':'confirmed',attributes:{identity:'结构化身份',secret:'作者秘密'}});const saved=(await ok<{entry:StoryEntry}>('PUT',`/api/story/${node.id}`,{kind,authority:'setting',title:node.title,content:'修改说明',expectedVersion:node.version})).entry;expect(saved.attributes).toEqual(node.attributes);expect(saved.status).toBe(node.status);}
    expect((await bundle(book.id)).nodes).toHaveLength(6);
    expect((await ok<{entries:StoryEntry[]}>('GET',`/api/books/${book.id}/story`)).entries).toHaveLength(5);
  });
  it('validates location containment, cycles, cross-book references and active child withdrawal',async()=>{
    const {book}=await setup(),other=(await setup()).book;
    const parent=await card(book.id,'校园',{kind:'location'});const child=await card(book.id,'教学楼',{kind:'location',links:{parentId:parent.id}});const outsider=await card(other.id,'外书地点',{kind:'location'});
    for(const target of [child.id,outsider.id]){const result=await app.inject({method:'PUT',url:`/api/story/${parent.id}`,payload:{...parent,links:{parentId:target},expectedVersion:parent.version}});expect(result.statusCode).toBe(400);}
    expect((await app.inject({method:'POST',url:`/api/story/${parent.id}/withdraw`,payload:{expectedVersion:parent.version}})).statusCode).toBe(409);
  });
  it('links existing voice cards and scene plans without duplicating them',async()=>{
    const {book,chapter}=await setup();const data=await ok<{profile:CreativeProfile}>('GET',`/api/books/${book.id}/creative`);
    const profile=(await ok<{profile:CreativeProfile}>('PUT',`/api/books/${book.id}/creative`,{...data.profile,expectedVersion:0,voices:[{id:'voice-a',name:'甲',aliases:[],traits:'简短',example:''}]})).profile;
    await card(book.id,'甲',{links:{voiceId:'voice-a'}});
    expect((await app.inject({method:'PUT',url:`/api/books/${book.id}/creative`,payload:{...profile,expectedVersion:profile.version,voices:[]}})).statusCode).toBe(409);
    const bookPlan=(await ok<{plan:{id:string}}>('POST',`/api/books/${book.id}/plans`,{parentId:null,chapterId:null,level:'book',title:'方向',content:'',position:1})).plan;
    const chapterPlan=(await ok<{plan:{id:string}}>('POST',`/api/books/${book.id}/plans`,{parentId:bookPlan.id,chapterId:chapter.id,level:'chapter',title:'章节',content:'',position:1})).plan;
    const scenePlan=(await ok<{plan:{id:string}}>('POST',`/api/books/${book.id}/plans`,{parentId:chapterPlan.id,chapterId:chapter.id,level:'scene',title:'雨天撤摊',content:'只在规划中维护这段内容',position:1})).plan;
    const first=await ok<{node:StoryEntry}>('POST',`/api/books/${book.id}/atlas/from-plan/${scenePlan.id}`,{}),again=await ok<{node:StoryEntry}>('POST',`/api/books/${book.id}/atlas/from-plan/${scenePlan.id}`,{});
    expect(first.node.id).toBe(again.node.id);expect(first.node.links?.planId).toBe(scenePlan.id);expect(first.node.status).toBe('idea');expect(first.node.content).not.toContain('只在规划中维护');
  });
  it('keeps directional and symmetric meanings explicit and rejects invalid endpoints',async()=>{
    const {book}=await setup(),other=(await setup()).book;const a=await card(book.id,'甲'),b=await card(book.id,'乙'),outsider=await card(other.id,'外书人物');
    const forward=await edge(book.id,a.id,b.id,{phase:'confirmed',label:'信任'});const reverse=await edge(book.id,b.id,a.id,{phase:'confirmed',label:'戒备'});const symmetric=await edge(book.id,a.id,b.id,{symmetric:true,label:'同班'});
    expect(forward.symmetric).toBe(false);expect(reverse.label).toBe('戒备');expect(symmetric.symmetric).toBe(true);
    for(const target of [a.id,outsider.id])expect((await app.inject({method:'POST',url:`/api/books/${book.id}/atlas/relations`,payload:{fromId:a.id,toId:target,label:'无效',symmetric:false}})).statusCode).toBe(400);
  });
  it('requires confirmed endpoints, CAS and reference handling before withdrawing nodes',async()=>{
    const {book}=await setup();const a=await card(book.id,'甲'),idea=await card(book.id,'设想中的人',{status:'idea'});
    expect((await app.inject({method:'POST',url:`/api/books/${book.id}/atlas/relations`,payload:{fromId:a.id,toId:idea.id,label:'伙伴',phase:'confirmed',symmetric:false}})).statusCode).toBe(400);
    const b=await card(book.id,'乙'),record=await edge(book.id,a.id,b.id,{phase:'confirmed'});
    expect((await app.inject({method:'PUT',url:`/api/atlas/relations/${record.id}`,payload:{...record,expectedVersion:99,label:'覆盖'}})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:`/api/story/${a.id}/withdraw`,payload:{expectedVersion:a.version}})).statusCode).toBe(409);
    await ok('POST',`/api/atlas/relations/${record.id}/withdraw`,{expectedVersion:record.version});await ok('POST',`/api/story/${a.id}/withdraw`,{expectedVersion:a.version});
  });
  it('records relationship evolution as separate chapter intervals and supports audited undo',async()=>{
    const {book,chapter,second}=await setup();const a=await card(book.id,'甲'),b=await card(book.id,'乙');const original=await edge(book.id,a.id,b.id,{phase:'confirmed',label:'陌生'});
    const next=(await ok<{record:AtlasRelation}>('POST',`/api/atlas/relations/${original.id}/evolve`,{...original,label:'搭档',fromChapter:2,expectedVersion:1})).record;
    const rows=(await bundle(book.id)).relations;expect(rows.find(row=>row.id===original.id)!.toChapter).toBe(1);expect(next.id).not.toBe(original.id);
    const messages=(value:ContextPreview)=>JSON.stringify(value.prompt.messages);
    expect(messages(await preview(chapter))).toContain('关系：陌生');expect(messages(await preview(chapter))).not.toContain('关系：搭档');expect(messages(await preview(second))).toContain('关系：搭档');
    const history=await ok<{events:import('@shujian/contracts').AtlasEvent[]}>('GET',`/api/atlas/relations/${original.id}/history`);expect(history.events).toHaveLength(2);
    const restored=await ok<{record:AtlasRelation}>('POST',`/api/atlas/relations/${original.id}/restore`,{eventId:history.events[0]!.id,expectedVersion:2});expect(restored.record.version).toBe(3);expect(restored.record.toChapter).toBeNull();
  });
  it('applies chapter states without rewriting static cards and excludes future or private changes',async()=>{
    const {book,chapter,second}=await setup();const a=await card(book.id,'甲',{attributes:{mood:'STATIC_CALM',secret:'NODE_SECRET'}});
    await state(book.id,a.id,{phase:'confirmed',fromChapter:2,summary:'VISIBLE_CHANGE',changes:{mood:'CURRENT_NERVOUS'}});
    await state(book.id,a.id,{phase:'confirmed',fromChapter:1,summary:'PRIVATE_CHANGE',visibility:'author',changes:{secret:'STATE_SECRET'}});
    const early=JSON.stringify((await preview(chapter)).prompt.messages),later=JSON.stringify((await preview(second)).prompt.messages);
    expect(early).toContain('STATIC_CALM');expect(early).not.toContain('VISIBLE_CHANGE');expect(later).toContain('CURRENT_NERVOUS');expect(later).not.toContain('PRIVATE_CHANGE');expect(later).not.toContain('NODE_SECRET');expect(later).not.toContain('STATE_SECRET');
    expect((await ok<{entry:StoryEntry}>('GET',`/api/story/${a.id}`)).entry.attributes?.mood).toBe('STATIC_CALM');
  });
  it('keeps ideas and branches out of default prompts, requiring explicit subgraph selection',async()=>{
    const {book,chapter}=await setup();const a=await card(book.id,'甲'),idea=await card(book.id,'构思甲',{status:'idea',branch:'方案A',content:'IDEA_A_ONLY'});await card(book.id,'构思乙',{status:'idea',branch:'方案B',content:'IDEA_B_ONLY'});
    const relation=await edge(book.id,a.id,idea.id,{branch:'方案A',label:'IDEA_RELATION'});
    expect(JSON.stringify((await preview(chapter)).prompt.messages)).not.toContain('IDEA_A_ONLY');
    const selected={nodeIds:[a.id,idea.id],relationIds:[relation.id],includeIdeas:true,branch:'方案A'};
    const text=JSON.stringify((await preview(chapter,{atlas:selected})).prompt.messages);expect(text).toContain('IDEA_A_ONLY');expect(text).toContain('IDEA_RELATION');expect(text).not.toContain('IDEA_B_ONLY');
    expect(JSON.stringify((await preview(chapter,{atlas:{...selected,includeIdeas:false}})).prompt.messages)).not.toContain('IDEA_A_ONLY');expect(calls).toBe(0);
  });
  it('stores layout independently, validates geometry and rejects cross-book selections',async()=>{
    const {book}=await setup(),other=(await setup()).book;const node=await card(book.id,'甲'),outsider=await card(other.id,'外书');
    const value={expectedVersion:0,positions:{[node.id]:{x:.2,y:.4}},selectedNodeIds:[node.id],branch:'主线'};
    await ok('PUT',`/api/books/${book.id}/atlas/view`,value);
    expect((await app.inject({method:'PUT',url:`/api/books/${book.id}/atlas/view`,payload:value})).statusCode).toBe(409);
    expect((await app.inject({method:'PUT',url:`/api/books/${book.id}/atlas/view`,payload:{...value,expectedVersion:1,positions:{[node.id]:{x:2,y:.4}}}})).statusCode).toBe(400);
    expect((await app.inject({method:'PUT',url:`/api/books/${book.id}/atlas/view`,payload:{...value,expectedVersion:1,selectedNodeIds:[outsider.id]}})).statusCode).toBe(400);
    expect((await ok<{entry:StoryEntry}>('GET',`/api/story/${node.id}`)).entry.version).toBe(1);
  });
  it('round trips relations, states, histories and layouts with remapped IDs and atomic corruption rejection',async()=>{
    const {book}=await setup();const a=await card(book.id,'甲'),b=await card(book.id,'道具',{kind:'item'});await edge(book.id,a.id,b.id,{phase:'confirmed',label:'持有'});await state(book.id,b.id,{phase:'confirmed',summary:'外观改变',changes:{appearance:'沾了雨水'}});
    await ok('PUT',`/api/books/${book.id}/atlas/view`,{expectedVersion:0,positions:{[a.id]:{x:.1,y:.2}},selectedNodeIds:[a.id],branch:'主线'});
    const value=await backup(),restored=await ok<{books:Book[]}>('POST','/api/backup/restore',{backup:value});const data=await bundle(restored.books[0]!.id);
    const newA=data.nodes.find(node=>node.title==='甲')!;expect(newA.id).not.toBe(a.id);expect(data.relations[0]!.fromId).toBe(newA.id);expect(data.states[0]!.nodeId).toBe(data.nodes.find(node=>node.kind==='item')!.id);expect(data.view.positions[newA.id]).toEqual({x:.1,y:.2});
    const damaged=structuredClone(value);(damaged.books[0]!.extensions!.atlas as unknown as {relations:AtlasRelation[]}).relations[0]!.toId='missing';const before=(await ok<{books:Book[]}>('GET','/api/books')).books.length;
    expect((await app.inject({method:'POST',url:'/api/backup/restore',payload:{backup:damaged}})).statusCode).toBe(400);expect((await ok<{books:Book[]}>('GET','/api/books')).books).toHaveLength(before);
  });
  it('imports only actual model suggestions as ideas and restores job selection references for retry',async()=>{
    const {book,chapter}=await setup();const a=await card(book.id,'甲'),b=await card(book.id,'乙');output=JSON.stringify({relations:[{fromId:a.id,toId:b.id,label:'模型建议的合作',description:'仅是提案'}]});
    const {job}=await ok<{job:AiJob}>('POST','/api/jobs',{requestId:randomUUID(),kind:'discuss',chapterId:chapter.id,expectedVersion:chapter.version,instruction:'按所选图谱提出关系建议。',atlas:{nodeIds:[a.id,b.id],relationIds:[],includeIdeas:false,branch:'主线'}});expect((await finished(job.id)).status).toBe('succeeded');
    const first=await ok<{relations:AtlasRelation[]}>('POST',`/api/books/${book.id}/atlas/import-job/${job.id}`,{});expect(first.relations[0]!.phase).toBe('idea');expect(first.relations[0]!.sourceJobId).toBe(job.id);await ok('POST',`/api/books/${book.id}/atlas/import-job/${job.id}`,{});expect((await bundle(book.id)).relations).toHaveLength(1);
    const restored=await ok<{books:Book[]}>('POST','/api/backup/restore',{backup:await backup()});const jobs=await ok<{jobs:AiJob[]}>('GET',`/api/books/${restored.books[0]!.id}/jobs`);const {job:retried}=await ok<{job:AiJob}>('POST',`/api/jobs/${jobs.jobs[0]!.id}/retry`,{});expect((await finished(retried.id)).status).toBe('succeeded');
  });
  it('preserves role knowledge boundaries even when the author selects hidden or future records',async()=>{
    const {book,chapter}=await setup();const a=await card(book.id,'甲'),b=await card(book.id,'乙');
    const hidden=await edge(book.id,a.id,b.id,{phase:'confirmed',label:'POV_ONLY_RELATION',visibility:'characters',knownBy:['乙']});
    const future=await card(book.id,'未来人物',{validFromChapter:2,content:'FUTURE_CARD_MARKER'});
    const selected={nodeIds:[a.id,b.id,future.id],relationIds:[hidden.id],includeIdeas:true,branch:'主线'};
    const text=JSON.stringify((await preview(chapter,{pov:'甲',atlas:selected})).prompt.messages);expect(text).not.toContain('POV_ONLY_RELATION');expect(text).not.toContain('FUTURE_CARD_MARKER');
    expect(JSON.stringify((await preview(chapter,{pov:'乙',atlas:selected})).prompt.messages)).toContain('POV_ONLY_RELATION');
    expect((await app.inject({method:'PUT',url:`/api/story/${a.id}`,payload:{...a,validFromChapter:2,expectedVersion:a.version}})).statusCode).toBe(400);
  });
  it('keeps model imports atomic, rejects invented IDs and refuses non-discussion jobs',async()=>{
    const {book,chapter}=await setup();const a=await card(book.id,'甲'),b=await card(book.id,'乙');
    output=JSON.stringify({relations:[{fromId:a.id,toId:b.id,label:'有效的第一条',phase:'confirmed',visibility:'public'}, {fromId:a.id,toId:'invented-id',label:'伪造的第二条'}]});
    const input={requestId:randomUUID(),kind:'discuss',chapterId:chapter.id,expectedVersion:chapter.version,instruction:'工程样本',atlas:{nodeIds:[a.id,b.id],relationIds:[],includeIdeas:false,branch:'主线'}};
    const {job}=await ok<{job:AiJob}>('POST','/api/jobs',input);await finished(job.id);
    expect((await app.inject({method:'POST',url:`/api/books/${book.id}/atlas/import-job/${job.id}`,payload:{}})).statusCode).toBe(400);expect((await bundle(book.id)).relations).toHaveLength(0);
    output=JSON.stringify({relations:[{fromId:a.id,toId:b.id,label:'不从正文起草任务导入'}]});
    const draft=(await ok<{job:AiJob}>('POST','/api/jobs',{...input,kind:'draft',requestId:randomUUID()})).job;await finished(draft.id);
    expect((await app.inject({method:'POST',url:`/api/books/${book.id}/atlas/import-job/${draft.id}`,payload:{}})).statusCode).toBe(400);
  });
  it('requires complete matching graph histories and rejects corrupt backups transactionally',async()=>{
    const {book}=await setup();const a=await card(book.id,'甲'),b=await card(book.id,'乙');await edge(book.id,a.id,b.id,{phase:'confirmed'});
    const value=await backup();const before=(await ok<{books:Book[]}>('GET','/api/books')).books;
    for(const mutation of ['missing','duplicate','changed'] as const){const damaged=structuredClone(value);const atlas=damaged.books[0]!.extensions!.atlas as unknown as {relations:AtlasRelation[];events:import('@shujian/contracts').AtlasEvent[]};
      if(mutation==='missing')atlas.events=[];else if(mutation==='duplicate')atlas.events.push({...atlas.events[0]!,id:randomUUID()});else atlas.events[0]!.snapshot={...atlas.events[0]!.snapshot,branch:'伪造历史'};
      expect((await app.inject({method:'POST',url:'/api/backup/restore',payload:{backup:damaged}})).statusCode).toBe(400);expect((await ok<{books:Book[]}>('GET','/api/books')).books).toEqual(before);
    }
  });
  it('maps voice, plan, parent and chapter links in card history as well as current records',async()=>{
    const {book,chapter}=await setup();const base=(await ok<{profile:CreativeProfile}>('GET',`/api/books/${book.id}/creative`)).profile;
    await ok('PUT',`/api/books/${book.id}/creative`,{...base,expectedVersion:0,voices:[{id:'original-voice',name:'甲',aliases:[],traits:'简短',example:''}]});
    const parent=await card(book.id,'校区',{kind:'location'}),child=await card(book.id,'活动室',{kind:'location',links:{parentId:parent.id,chapterIds:[chapter.id]}}),person=await card(book.id,'甲',{links:{voiceId:'original-voice'}});
    await ok('PUT',`/api/story/${child.id}`,{...child,title:'活动室新名称',expectedVersion:1});
    const restored=await ok<{books:Book[]}>('POST','/api/backup/restore',{backup:await backup()}),result=await bundle(restored.books[0]!.id);
    const newParent=result.nodes.find(node=>node.title==='校区')!,newChild=result.nodes.find(node=>node.title==='活动室新名称')!,newPerson=result.nodes.find(node=>node.title===person.title)!;
    expect(newChild.links?.parentId).toBe(newParent.id);expect(newChild.links?.chapterIds).not.toContain(chapter.id);expect(newPerson.links?.voiceId).toBe(result.voices[0]!.id);expect(newPerson.links?.voiceId).not.toBe('original-voice');
    const history=await ok<{events:Array<{entry:StoryEntry}>}>('GET',`/api/story/${newChild.id}/history`);expect(history.events.every(event=>event.entry.links?.parentId===newParent.id&&event.entry.links?.chapterIds?.[0]===newChild.links?.chapterIds?.[0])).toBe(true);
  });
});
