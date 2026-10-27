import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Chapter, ContextItem, JsonValue, PlanNode, SavePlanInput } from '@shujian/contracts';
import { AppError, notFound } from './errors.js';
import type { Store } from './store.js';
import * as v from './validation.js';

function parse(value: unknown): SavePlanInput {
  const row = v.object(value, '剧情规划');
  const level = v.string(row.level, '规划层级', 20);
  if (!['book', 'arc', 'chapter', 'scene'].includes(level)) v.invalid('规划层级不正确。');
  return { level: level as PlanNode['level'], parentId: row.parentId == null ? null : v.string(row.parentId, '上级规划', 128, 1),
    chapterId: row.chapterId == null ? null : v.string(row.chapterId, '关联章节', 128, 1),
    title: v.string(row.title, '规划名称', 200, 1).trim(), content: v.string(row.content, '规划内容', 20_000),
    position: v.integer(row.position ?? 1, '规划顺序', 1, 100_000),
    ...(row.expectedVersion === undefined ? {} : { expectedVersion: v.integer(row.expectedVersion, '规划版本', 1) }) };
}

export class PlanningService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES books(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_history(id TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES books(id),plan_id TEXT NOT NULL REFERENCES plans(id),payload TEXT NOT NULL);`);
  }
  list(bookId: string): PlanNode[] {
    this.store.getBook(bookId);
    return (this.store.db.prepare('SELECT payload FROM plans WHERE book_id=? ORDER BY rowid').all(bookId) as Array<{payload:string}>)
      .map((row) => JSON.parse(row.payload) as PlanNode).sort((a,b) => a.position-b.position);
  }
  get(id: string): PlanNode {
    const row=this.store.db.prepare('SELECT payload FROM plans WHERE id=?').get(id) as {payload:string}|undefined;
    return row ? JSON.parse(row.payload) as PlanNode : notFound('剧情规划');
  }
  save(bookId: string, value: unknown, id?: string): PlanNode {
    const input=parse(value);
    return this.store.db.transaction(() => {
      this.store.getBook(bookId);
      const previous=id?this.get(id):null;
      if(previous?.bookId && previous.bookId!==bookId)v.invalid('规划不属于当前作品。');
      if(previous && previous.version!==input.expectedVersion)throw new AppError(409,'VERSION_CONFLICT','规划已经更新，请重新打开。',previous.version);
      if(input.chapterId && this.store.getChapter(input.chapterId).bookId!==bookId)v.invalid('关联章节不属于当前作品。');
      if(input.parentId){
        const parent=this.get(input.parentId);
        if(parent.bookId!==bookId)v.invalid('上级规划不属于当前作品。');
        const allowed:Record<PlanNode['level'],PlanNode['level'][]>={book:[],arc:['book'],chapter:['book','arc'],scene:['chapter']};
        if(!allowed[input.level].includes(parent.level))v.invalid('规划层级应为全书、故事弧、章节、场景的顺序。');
        if(input.level==='scene' && input.chapterId && parent.chapterId && input.chapterId!==parent.chapterId)v.invalid('场景必须与上级章节规划关联同一章节。');
      } else if(input.level==='scene')v.invalid('场景需要归属一份章节规划。');
      if(input.level==='book' && input.chapterId)v.invalid('全书方向不能只关联一章。');
      if(previous && previous.level!==input.level && this.list(bookId).some((node)=>node.parentId===id))v.invalid('已有下级规划时，请保留当前层级。');
      const time=new Date().toISOString();
      const node:PlanNode={...input,id:previous?.id??randomUUID(),bookId,version:(previous?.version??0)+1,createdAt:previous?.createdAt??time,updatedAt:time};
      this.put(node);
      this.store.db.prepare('INSERT INTO plan_history(id,book_id,plan_id,payload) VALUES(?,?,?,?)').run(randomUUID(),bookId,node.id,JSON.stringify(node));
      return node;
    })();
  }
  private put(node:PlanNode):void {
    this.store.db.prepare('INSERT INTO plans(id,book_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(node.id,node.bookId,JSON.stringify(node));
  }
  context(chapter:Chapter):ContextItem[] {
    const nodes=this.list(chapter.bookId); const included=new Set(nodes.filter((node)=>node.chapterId===chapter.id).map((node)=>node.id));
    let changed=true;
    while(changed){changed=false;for(const node of nodes)if(included.has(node.id)&&node.parentId&&!included.has(node.parentId)){included.add(node.parentId);changed=true;}}
    return nodes.filter((node)=>node.level==='book'||included.has(node.id)).map((node)=>({id:`plan:${node.id}:v${node.version}`,label:`作者确认的未来规划 · ${node.title}（尚未发生）`,source:'outline',text:node.content,required:false}));
  }
  exportBook(bookId:string):JsonValue {
    const history=this.store.db.prepare('SELECT id,plan_id,payload FROM plan_history WHERE book_id=? ORDER BY rowid').all(bookId);
    return JSON.parse(JSON.stringify({version:1,nodes:this.list(bookId),history})) as JsonValue;
  }
  restoreBook(oldBookId:string,newBookId:string,ids:Record<string,string>,payload:unknown):void {
    if(payload===undefined)return;
    const raw=v.object(payload,'规划备份');if(raw.version!==1||!Array.isArray(raw.nodes)||raw.nodes.length>10000||!Array.isArray(raw.history)||raw.history.length>100000)v.invalid('规划备份格式不正确。');
    const nodes=raw.nodes.map((value)=>{
      const item=v.object(value);const input=parse(item);const id=v.string(item.id,'规划ID',128,1);
      if(item.bookId!==oldBookId||ids[id])v.invalid('规划备份所属作品或ID不正确。');ids[id]=randomUUID();
      return {...input,id,version:v.integer(item.version,'规划版本',1),createdAt:v.string(item.createdAt,'创建时间',40,1),updatedAt:v.string(item.updatedAt,'更新时间',40,1)};
    });
    const mapNode=(node:Omit<PlanNode,'bookId'>):PlanNode=>{
      if(node.parentId&&!nodes.some((parent)=>parent.id===node.parentId))v.invalid('规划上级引用缺失。');
      const result={...node,id:ids[node.id]!,bookId:newBookId,parentId:node.parentId?ids[node.parentId]!:null,chapterId:node.chapterId?ids[node.chapterId]??null:null};
      if(node.chapterId&&(!result.chapterId||this.store.getChapter(result.chapterId).bookId!==newBookId))v.invalid('规划关联章节缺失。');
      return result;
    };
    for(const node of nodes)this.put(mapNode(node));
    for(const node of nodes){const restored=this.get(ids[node.id]!);const parent=restored.parentId?this.get(restored.parentId):null;
      const allowed:Record<PlanNode['level'],PlanNode['level'][]>={book:[],arc:['book'],chapter:['book','arc'],scene:['chapter']};
      if((parent&&!allowed[restored.level].includes(parent.level))||(!parent&&restored.level==='scene'))v.invalid('规划备份层级不正确。');
    }
    for(const value of raw.history){const row=v.object(value);const content=v.object(JSON.parse(v.string(row.payload,'规划历史',100000,1)) as unknown);const source=nodes.find((node)=>node.id===row.plan_id);
      if(!source||content.id!==source.id||content.bookId!==oldBookId)v.invalid('规划历史引用缺失。');
      const node=mapNode({...parse(content),id:source.id,version:v.integer(content.version,'历史版本',1),createdAt:v.string(content.createdAt,'创建时间',40,1),updatedAt:v.string(content.updatedAt,'更新时间',40,1)});
      this.store.db.prepare('INSERT INTO plan_history(id,book_id,plan_id,payload) VALUES(?,?,?,?)').run(randomUUID(),newBookId,node.id,JSON.stringify(node));
    }
  }
}

export function registerPlanningRoutes(app:FastifyInstance,store:Store):PlanningService {
  const plans=new PlanningService(store);
  const id=(request:FastifyRequest,key:string)=>v.string(v.object(request.params)[key],'记录ID',128,1);
  app.get('/api/books/:bookId/plans',async(request)=>({plans:plans.list(id(request,'bookId'))}));
  app.post('/api/books/:bookId/plans',async(request,reply)=>reply.code(201).send({plan:plans.save(id(request,'bookId'),request.body)}));
  app.put('/api/plans/:id',async(request)=>{const key=id(request,'id');return {plan:plans.save(plans.get(key).bookId,request.body,key)};});
  return plans;
}
