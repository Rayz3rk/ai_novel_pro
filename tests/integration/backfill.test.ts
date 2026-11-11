import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { storageHarness } from './storage-harness.js';
import type { AiJob, Chapter, Book, ContextPreview, WorkspaceBackup, AtlasBundle } from '@shujian/contracts';
const harness=storageHarness('backfill');
describe('grounded manuscript backfill',()=>{
  let root:string,app:ReturnType<typeof harness.createApp>,server:Server,output:unknown;
  beforeEach(async()=>{
    harness.reset();root=await mkdtemp(join(tmpdir(),'shujian-backfill-'));
    const evidence=[{paragraphId:'p1',quote:'林砚把钥匙交给陈舟。'}];
    output={entries:[{key:'a',kind:'character',title:'林砚',content:'交出钥匙',evidence},{key:'b',kind:'character',title:'陈舟',content:'收到钥匙',evidence}],relations:[{fromKey:'a',toKey:'b',label:'交付',description:'交付钥匙',symmetric:false,evidence}],states:[{nodeKey:'b',summary:'持有钥匙',changes:{status:'持有钥匙'},evidence}]};
    server=createServer((request,response)=>{request.resume();request.on('end',()=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:100}}));});});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('fixture');
    app=harness.createApp({dataDir:join(root,'data'),credentialDir:join(root,'credentials')});await app.ready();
    await api('PUT','/api/model',{baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'fixture',stream:false,temperature:0.7,maxOutputTokens:2048,contextWindow:32768,inputPricePerMillion:1,outputPricePerMillion:1,taskBudget:null,dailyBudget:null});
  });
  afterEach(async()=>{await app.close();await new Promise<void>(resolve=>server.close(()=>resolve()));if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('shujian-backfill-'))throw Error('Unsafe test path');await rm(root,{recursive:true,force:true});});
  async function api<T>(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:object):Promise<T>{const response=await app.inject({method,url,...(payload?{payload}:{})});expect(response.statusCode,response.body).toBeGreaterThanOrEqual(200);expect(response.statusCode,response.body).toBeLessThan(300);return response.json<T>();}
  async function setup(){const {book}=await api<{book:Book}>('POST','/api/books',{title:'正文回填测试'});const {chapters}=await api<{chapters:Chapter[]}>('GET',`/api/books/${book.id}/chapters`);const chapter=(await api<{chapter:Chapter}>('PUT',`/api/chapters/${chapters[0]!.id}/draft`,{expectedVersion:1,title:'交付',outline:'',document:{type:'doc',content:[{type:'paragraph',attrs:{uid:'p1'},content:[{type:'text',text:'林砚把钥匙交给陈舟。'}]}]}})).chapter;await api('POST',`/api/chapters/${chapter.id}/finalize`,{expectedVersion:chapter.version});return {book,chapter};}
  async function analyze(chapter:Chapter){const {preview}=await api<{preview:ContextPreview}>('POST',`/api/chapters/${chapter.id}/backfill/preview`,{});expect(preview.prompt.messages[0]?.content).toContain('fromKey');let {job}=await api<{job:AiJob}>('POST',`/api/chapters/${chapter.id}/backfill/start`,{fingerprint:preview.fingerprint});for(let attempt=0;attempt<100&&['queued','running'].includes(job.status);attempt++){await delay(20);job=(await api<{job:AiJob}>('GET',`/api/jobs/${job.id}`)).job;}return job;}
  it('matches knowledge, applies evidence-backed graph changes once, and preserves ledger through backup/restore',async()=>{
    const {book,chapter}=await setup();await api('POST',`/api/books/${book.id}/story`,{kind:'character',authority:'setting',title:'林砚',content:'已有角色档案'});
    const job=await analyze(chapter);expect(job.status,job.error??'').toBe('succeeded');
    const preview=await api<{fingerprint:string;entries:Array<{matches:unknown[]}>}>('GET',`/api/jobs/${job.id}/backfill`);expect(preview.entries[0]!.matches).toHaveLength(1);
    expect((await api<AtlasBundle>('GET',`/api/books/${book.id}/atlas`)).relations).toHaveLength(0);
    await api('POST',`/api/jobs/${job.id}/backfill/apply`,{fingerprint:preview.fingerprint});
    expect((await api<{alreadyApplied:boolean}>('POST',`/api/jobs/${job.id}/backfill/apply`,{fingerprint:preview.fingerprint})).alreadyApplied).toBe(true);
    const graph=await api<AtlasBundle>('GET',`/api/books/${book.id}/atlas`);expect(graph.nodes).toHaveLength(2);expect(graph.relations).toHaveLength(1);expect(graph.states).toHaveLength(2);expect(graph.nodes.find(node=>node.title==='林砚')?.content).toContain('已有角色档案');expect(graph.relations[0]?.evidence[0]?.quote).toBe('林砚把钥匙交给陈舟。');
    const backup=await api<WorkspaceBackup>('GET','/api/backup');const restored=await api<{books:Book[]}>('POST','/api/backup/restore',{backup});const plan=await api<{chapters:Array<{applied:boolean}>}>('GET',`/api/books/${restored.books[0]!.id}/backfill`);expect(plan.chapters[0]?.applied).toBe(true);
    expect((await api<{chapter:Chapter}>('GET',`/api/chapters/${chapter.id}`)).chapter.plainText).toBe('林砚把钥匙交给陈舟。');
    await api('DELETE',`/api/books/${book.id}`,{title:book.title});
  });
  it('rejects invented quotes before any knowledge or graph writes',async()=>{const {book,chapter}=await setup();output={entries:[{key:'a',kind:'character',title:'不存在',content:'猜测',evidence:[{paragraphId:'p1',quote:'从未出现的原句'}]}],relations:[],states:[]};const job=await analyze(chapter);expect(job.status).toBe('failed');expect((await api<AtlasBundle>('GET',`/api/books/${book.id}/atlas`)).nodes).toHaveLength(0);});
  it('rejects changed graph previews and changed source revisions, marks updated chapters for incremental analysis',async()=>{const {book,chapter}=await setup();const job=await analyze(chapter);const preview=await api<{fingerprint:string}>('GET',`/api/jobs/${job.id}/backfill`);await api('POST',`/api/books/${book.id}/story`,{kind:'note',authority:'setting',title:'并发更新',content:'新资料'});expect((await app.inject({method:'POST',url:`/api/jobs/${job.id}/backfill/apply`,payload:{fingerprint:preview.fingerprint}})).statusCode).toBe(409);const fresh=await api<{fingerprint:string}>('GET',`/api/jobs/${job.id}/backfill`);await api('POST',`/api/jobs/${job.id}/backfill/apply`,{fingerprint:fresh.fingerprint});const changed=(await api<{chapter:Chapter}>('PUT',`/api/chapters/${chapter.id}/draft`,{expectedVersion:chapter.version,title:chapter.title,outline:'新增',document:chapter.document})).chapter;await api('POST',`/api/chapters/${chapter.id}/finalize`,{expectedVersion:changed.version});expect((await api<{chapters:Array<{applied:boolean}>}>('GET',`/api/books/${book.id}/backfill`)).chapters[0]?.applied).toBe(false);expect((await app.inject({method:'GET',url:`/api/jobs/${job.id}/backfill`})).statusCode).toBe(409);});
});
