import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiJob, Chapter, ModelSettings, WorkspaceBackup } from '@shujian/contracts';
import { storageHarness } from './storage-harness.js';

const harness = storageHarness('boundary_budget');
type SavedTask={job:AiJob&{billingSourceId?:string};calls:Array<{id:string;billingSourceId?:string;reservedCost?:number|null;estimatedCost:number|null}>;budgetReservation?:number|null};

describe('local request boundary and shared in-flight budget', () => {
  let app: ReturnType<typeof harness.createApp>;
  let fixture: Server;
  let directory: string;
  let settings: Omit<ModelSettings, 'id' | 'hasApiKey'>;
  let requests: number;
  let mode: 'normal' | 'hold' | 'repair' | 'truncated';
  const held: Array<{ response: ServerResponse; output: string }> = [];
  function respond(response: ServerResponse, output: string, tokens: number, reason='stop'): void {
    if (response.destroyed) return;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: reason }], usage: { prompt_tokens: 1, completion_tokens: tokens } }));
  }
  function release(tokens = 512): void { for (const item of held.splice(0)) respond(item.response, item.output, tokens); }
  async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await pause(10); }
    throw new Error('Isolated provider request did not arrive.');
  }
  async function chapter(): Promise<Chapter> {
    const result = await app.inject({ method: 'POST', url: '/api/books', payload: { title: 'Local boundary budget fixture' } });
    const id = result.json<{ book: { id: string } }>().book.id;
    const list = await app.inject(`/api/books/${id}/chapters`);
    const first = list.json<{ chapters: Chapter[] }>().chapters[0]!;
    return (await app.inject(`/api/chapters/${first.id}`)).json<{ chapter: Chapter }>().chapter;
  }
  async function start(target: Chapter, kind: 'draft' | 'review' = 'draft'): Promise<AiJob> {
    const result = await app.inject({ method: 'POST', url: '/api/jobs', payload: { requestId: randomUUID(), kind, chapterId: target.id, expectedVersion: target.version, instruction: 'Isolated budget fixture.' } });
    expect(result.statusCode, result.body).toBe(201); return result.json<{ job: AiJob }>().job;
  }
  async function finished(id: string): Promise<AiJob> {
    for (let attempt = 0; attempt < 300; attempt++) {
      const job = (await app.inject(`/api/jobs/${id}`)).json<{ job: AiJob }>().job;
      if (!['queued', 'running'].includes(job.status)) return job; await pause(10);
    }
    throw new Error('Budget fixture job did not finish.');
  }

  beforeEach(async () => {
    harness.reset(); directory = await mkdtemp(join(tmpdir(), 'shujian-boundary-budget-'));
    requests = 0; mode = 'normal'; held.length = 0;
    fixture = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Consume the local request. */ }
      requests++;
      if (mode === 'truncated') respond(response, 'partial fixture output', 1, 'length');
      else if (mode === 'repair' && requests === 1) respond(response, '{invalid', 512);
      else if (mode === 'hold' || mode === 'repair') held.push({ response, output: mode === 'repair' ? '{"issues":[]}' : 'fixture response' });
      else respond(response, 'fixture response', 1);
    });
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
    const address = fixture.address(); if (!address || typeof address === 'string') throw new Error('Fixture address');
    settings = { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'isolated-budget-fixture', stream: false, temperature: 0.7, maxOutputTokens: 512, contextWindow: 32768, inputPricePerMillion: 0, outputPricePerMillion: 1000, taskBudget: null, dailyBudget: 0.6 };
    app = harness.createApp({ dataDir: join(directory, 'data'), credentialDir: join(directory, 'credentials') }); await app.ready();
    expect((await app.inject({ method: 'PUT', url: '/api/model', payload: settings })).statusCode).toBe(200);
  });
  afterEach(async () => {
    release(); await app.close(); fixture.closeAllConnections(); await new Promise<void>((done) => fixture.close(() => done()));
    const safe = resolve(directory);
    if (dirname(safe) !== resolve(tmpdir()) || !basename(safe).startsWith('shujian-boundary-budget-')) throw new Error('Unexpected cleanup path');
    await rm(safe, { recursive: true, force: true });
  });

  it('rejects rebound Host and foreign Origin before exposing backup, mutating settings or forwarding a key', async () => {
    await app.inject({ method: 'PUT', url: '/api/model', payload: { ...settings, apiKey: 'isolated-fixture-key' } });
    const hostile = { host: 'attacker.invalid:4318', origin: 'http://attacker.invalid:4318' };
    expect((await app.inject({ url: '/api/backup', headers: hostile })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/books', headers: hostile, payload: { title: 'must not be saved' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/model', headers: hostile, payload: { ...settings, baseUrl: 'http://127.0.0.1:9/v1' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/model/test', headers: { host: 'localhost:4318', origin: 'http://attacker.invalid:4318' } })).statusCode).toBe(403);
    expect((await app.inject('/api/books')).json().books).toEqual([]);
    expect((await app.inject('/api/model')).json().settings.baseUrl).toBe(settings.baseUrl); expect(requests).toBe(0);
  });

  it('accepts local same-origin clients and the current Vite proxy while rejecting cross-origin ports and opaque origins', async () => {
    for (const host of ['localhost:4318', '127.0.0.1:4318', '[::1]:4318', 'localhost:5173']) {
      expect((await app.inject({ url: '/api/health', headers: { host, origin: `http://${host}` } })).statusCode).toBe(200);
    }
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    for (const origin of ['null', 'http://localhost:5173', 'https://localhost:4318', 'http://localhost.attacker.invalid:4318']) {
      expect((await app.inject({ url: '/api/health', headers: { host: 'localhost:4318', origin } })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: '/api/backup', headers: { host: 'localhost:4318', 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    const navigation={host:'localhost:4318','sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
    expect((await app.inject({url:'/',headers:navigation})).statusCode).not.toBe(403);
    expect((await app.inject({url:'/api/backup',headers:navigation})).statusCode).toBe(403);
  });

  it('reserves a connection test before sending it so a simultaneous test cannot overspend the day', async () => {
    mode = 'hold'; const first = app.inject({ method: 'POST', url: '/api/model/test' });
    await until(() => requests === 1);
    const second = await app.inject({ method: 'POST', url: '/api/model/test' });
    expect(second.statusCode).toBe(422); expect(second.json().error.code).toBe('DAILY_BUDGET'); expect(requests).toBe(1);
    release(); expect((await first).statusCode).toBe(200);
  });

  it('lets a completed small test release unused allowance while charging only its known use', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/model/test' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/model/test' })).statusCode).toBe(200);
    expect(requests).toBe(2);
  });

  it('releases unused allowance after a failed test whose provider usage is known', async () => {
    mode='truncated';
    expect((await app.inject({method:'POST',url:'/api/model/test'})).statusCode).toBe(502);
    mode='normal';
    expect((await app.inject({method:'POST',url:'/api/model/test'})).statusCode).toBe(200);
    expect(requests).toBe(2);
  });

  it('settles an aborted connection test before closing its database',async()=>{
    mode='hold';const pending=app.inject({method:'POST',url:'/api/model/test'});await until(()=>requests===1);
    await app.close();
    const result=await pending;expect(result.statusCode).toBe(502);expect(result.json().error.code).toBe('MODEL_TEST_FAILED');
  });

  it('shares in-flight allowance between regular jobs and connection tests, keeping unknown fees unknown after cancellation', async () => {
    mode = 'hold'; const job = await start(await chapter()); await until(() => requests === 1);
    const test = await app.inject({ method: 'POST', url: '/api/model/test' });
    expect(test.statusCode).toBe(422); expect(test.json().error.code).toBe('DAILY_BUDGET'); expect(requests).toBe(1);
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    const cancelled = await finished(job.id); expect(cancelled.status).toBe('cancelled'); expect(cancelled.usage.estimatedCost).toBeNull();
    release();
  });

  it('keeps the next repair request reserved even after an earlier request has known usage', async () => {
    settings.dailyBudget = 1.1; await app.inject({ method: 'PUT', url: '/api/model', payload: settings });
    mode = 'repair'; const job = await start(await chapter(), 'review'); await until(() => requests === 2);
    const during = (await app.inject(`/api/jobs/${job.id}`)).json<{ job: AiJob }>().job;
    expect(during.usage.estimatedCost).toBe(0.512);
    const test = await app.inject({ method: 'POST', url: '/api/model/test' }); expect(test.statusCode).toBe(422); expect(requests).toBe(2);
    release(); const done = await finished(job.id); expect(done.status).toBe('succeeded'); expect(done.usage.estimatedCost).toBe(1.024);
  });

  it.each(['current','legacy'] as const)('deduplicates %s history through repeated restores, while a real retry gets a new charge',async(format)=>{
    settings.dailyBudget=1.1;await app.inject({method:'PUT',url:'/api/model',payload:settings});
    mode='hold';const source=await start(await chapter());await until(()=>requests===1);release();
    const done=await finished(source.id);expect(done.usage.estimatedCost).toBe(0.512);
    const backup=(await app.inject('/api/backup')).json<WorkspaceBackup>();
    const history=backup.books[0]!.extensions!.ai as unknown as SavedTask[];
    if(format==='legacy'){
      delete history[0]!.job.billingSourceId;delete history[0]!.budgetReservation;
      for(const item of history[0]!.calls){delete item.billingSourceId;delete item.reservedCost;}
    }
    const restored=await app.inject({method:'POST',url:'/api/backup/restore',payload:{backup}});expect(restored.statusCode,restored.body).toBe(201);
    const copiedBook=restored.json<{books:Array<{id:string}>}>().books[0]!.id;
    const copy=(await app.inject(`/api/books/${copiedBook}/jobs`)).json<{jobs:Array<AiJob&{billingSourceId?:string}>}>().jobs[0]!;
    expect(copy.billingSourceId).toBe(source.id);expect(copy.usage).toEqual(done.usage);
    const again=(await app.inject('/api/backup')).json<WorkspaceBackup>();again.books=again.books.filter((book)=>book.book.id===copiedBook);
    expect((await app.inject({method:'POST',url:'/api/backup/restore',payload:{backup:again}})).statusCode).toBe(201);
    mode='normal';expect((await app.inject({method:'POST',url:'/api/model/test'})).statusCode).toBe(200);
    mode='hold';const retried=await app.inject({method:'POST',url:`/api/jobs/${copy.id}/retry`});expect(retried.statusCode,retried.body).toBe(201);
    const retry=retried.json<{job:AiJob&{billingSourceId?:string}}>().job;expect(retry.billingSourceId).toBe(retry.id);expect(retry.billingSourceId).not.toBe(source.id);
    await until(()=>requests===3);release();expect((await finished(retry.id)).usage.estimatedCost).toBe(0.512);
    expect((await app.inject({method:'POST',url:'/api/model/test'})).statusCode).toBe(422);expect(requests).toBe(3);
  });

  it('does not let a restored zero-cost copy erase the source request still in flight',async()=>{
    mode='hold';const source=await start(await chapter());await until(()=>requests===1);
    const backup=(await app.inject('/api/backup')).json<WorkspaceBackup>();
    const history=backup.books[0]!.extensions!.ai as unknown as SavedTask[];
    history[0]!.job.usage.estimatedCost=0;history[0]!.budgetReservation=0;
    for(const item of history[0]!.calls){item.estimatedCost=0;item.reservedCost=0;}
    expect((await app.inject({method:'POST',url:'/api/backup/restore',payload:{backup}})).statusCode).toBe(201);
    expect((await app.inject({method:'POST',url:'/api/model/test'})).statusCode).toBe(422);expect(requests).toBe(1);
    release(1);expect((await finished(source.id)).usage.estimatedCost).toBe(0.001);
    mode='normal';expect((await app.inject({method:'POST',url:'/api/model/test'})).statusCode).toBe(200);
  });
});
