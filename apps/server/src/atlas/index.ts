import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AiJob,CreateAiJobInput } from '@shujian/contracts';
import type { Store } from '../store.js';
import type { StoryService } from '../story/service.js';
import type { CreativeService } from '../creative/service.js';
import type { PlanningService } from '../planning.js';
import * as v from '../validation.js';
import { AtlasService } from './service.js';

export function registerAtlasRoutes(app:FastifyInstance,store:Store,story:StoryService,plans:PlanningService,creative:CreativeService):AtlasService{
  const service=new AtlasService(store,story,plans,creative);
  const param=(request:FastifyRequest,key:string)=>v.string(v.object(request.params)[key],'记录ID',128,1);
  app.get('/api/books/:bookId/atlas',async request=>service.bundle(param(request,'bookId')));
  app.get('/api/books/:bookId/atlas/jobs',async request=>{
    const bookId=param(request,'bookId');store.getBook(bookId);
    const jobs=(store.db.prepare('SELECT job,input FROM ai_jobs WHERE book_id=? ORDER BY created_at DESC,rowid DESC').all(bookId) as Array<{job:string;input:string}>).filter(row=>{const input=JSON.parse(row.input) as CreateAiJobInput;return !!input.atlas&&input.kind==='discuss';}).slice(0,100).map(row=>{const job=JSON.parse(row.job) as AiJob;return {id:job.id,kind:job.kind,status:job.status,instruction:job.instruction,createdAt:job.createdAt};});
    return {jobs};
  });
  app.put('/api/books/:bookId/atlas/view',async request=>({view:service.saveView(param(request,'bookId'),request.body)}));
  app.post('/api/books/:bookId/atlas/from-plan/:planId',async request=>({node:service.fromPlan(param(request,'bookId'),param(request,'planId'))}));
  app.post('/api/books/:bookId/atlas/import-job/:jobId',async request=>({relations:service.importJob(param(request,'bookId'),param(request,'jobId'))}));
  app.get('/api/books/:bookId/atlas/nodes/:id/mentions',async request=>({chapters:service.mentions(param(request,'bookId'),param(request,'id'))}));
  app.post('/api/atlas/nodes/:id/restore',async request=>{
    const id=param(request,'id'),body=v.object(request.body);const eventId=v.string(body.eventId,'历史版本',128,1);
    const event=story.history(id).find(event=>event.id===eventId);if(!event)v.invalid('所选历史不属于此卡片。');
    return {node:story.saveEntry(event.bookId,{...event.entry,expectedVersion:v.integer(body.expectedVersion,'卡片版本',1)},id)};
  });
  for(const kind of ['relation','state'] as const){
    const plural=kind==='relation'?'relations':'states';
    app.post(`/api/books/:bookId/atlas/${plural}`,async(request,reply)=>reply.code(201).send({record:kind==='relation'?service.save(kind,param(request,'bookId'),request.body):service.save(kind,param(request,'bookId'),request.body)}));
    app.put(`/api/atlas/${plural}/:id`,async request=>{const id=param(request,'id'),record=service.get(kind,id);return {record:kind==='relation'?service.save(kind,record.bookId,request.body,id):service.save(kind,record.bookId,request.body,id)};});
    app.post(`/api/atlas/${plural}/:id/withdraw`,async request=>{const id=param(request,'id'),record=service.get(kind,id),input={...record,phase:'withdrawn',expectedVersion:v.integer(v.object(request.body).expectedVersion,'记录版本',1)};return {record:kind==='relation'?service.save(kind,record.bookId,input,id):service.save(kind,record.bookId,input,id)};});
    app.get(`/api/atlas/${plural}/:id/history`,async request=>({events:service.history(kind,param(request,'id'))}));
    app.post(`/api/atlas/${plural}/:id/restore`,async request=>{const body=v.object(request.body);return {record:service.restore(kind,param(request,'id'),v.string(body.eventId,'历史版本',128,1),v.integer(body.expectedVersion,'记录版本',1))};});
  }
  app.post('/api/atlas/relations/:id/evolve',async request=>({record:service.evolve(param(request,'id'),request.body)}));
  return service;
}
