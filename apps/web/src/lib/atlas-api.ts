import type { AiJob, AtlasBundle, AtlasEvent, AtlasRelation, AtlasSelection, AtlasState, AtlasView, ChapterSummary, SaveAtlasRelation, SaveAtlasState, SaveStoryEntryInput, StoryEntry } from '@shujian/contracts';
import { request } from './api';

export interface AtlasLaunch { kind:'discuss'|'draft'; instruction:string; atlas:AtlasSelection; voiceIds:string[] }
export const atlasKinds:Record<StoryEntry['kind'],string>={character:'人物',location:'地点',item:'道具',organization:'组织',scene:'剧情场景',note:'构思便签',rule:'世界规则',event:'事件',foreshadow:'伏笔',plan:'剧情计划'};
export const atlasPhases={idea:'构思中',confirmed:'已确认',withdrawn:'已撤回'};
export const attributeLabels:Record<string,string>={identity:'身份与角色',age:'年龄 / 年级',appearance:'外观',personality:'性格与反差',motivation:'动机与追求',background:'经历与背景',secret:'仅作者知道的秘密',environment:'环境与氛围',accessRules:'出入与使用规则',function:'用途与特点',status:'剧情状态',goal:'目标',obstacle:'阻力',turn:'转折与结果',rules:'规则与约定'};
export const atlasFields:Record<StoryEntry['kind'],string[]>={character:['identity','age','appearance','personality','motivation','background','secret'],location:['environment','accessRules','background'],item:['appearance','function','status'],organization:['goal','rules','background'],scene:['goal','obstacle','turn'],note:[],rule:['rules'],event:['goal','turn'],foreshadow:['goal','turn'],plan:['goal']};
export const atlasApi={
  data:(bookId:string)=>request<AtlasBundle>(`/books/${bookId}/atlas`),
  node:(id:string)=>request<{entry:StoryEntry}>(`/story/${id}`),
  saveNode:(bookId:string,value:SaveStoryEntryInput,id?:string)=>request<{entry:StoryEntry}>(id?`/story/${id}`:`/books/${bookId}/story`,value,id?'PUT':'POST'),
  saveRelation:(bookId:string,value:SaveAtlasRelation,id?:string,evolve=false)=>request<{record:AtlasRelation}>(evolve?`/atlas/relations/${id}/evolve`:id?`/atlas/relations/${id}`:`/books/${bookId}/atlas/relations`,value,evolve||!id?'POST':'PUT'),
  saveState:(bookId:string,value:SaveAtlasState,id?:string)=>request<{record:AtlasState}>(id?`/atlas/states/${id}`:`/books/${bookId}/atlas/states`,value,id?'PUT':'POST'),
  withdraw:(kind:'relation'|'state',id:string,expectedVersion:number)=>request<{record:AtlasRelation|AtlasState}>(`/atlas/${kind==='relation'?'relations':'states'}/${id}/withdraw`,{expectedVersion},'POST'),
  history:(kind:'relation'|'state',id:string)=>request<{events:AtlasEvent[]}>(`/atlas/${kind==='relation'?'relations':'states'}/${id}/history`),
  restore:(kind:'relation'|'state',id:string,eventId:string,expectedVersion:number)=>request<{record:AtlasRelation|AtlasState}>(`/atlas/${kind==='relation'?'relations':'states'}/${id}/restore`,{eventId,expectedVersion},'POST'),
  restoreNode:(id:string,eventId:string,expectedVersion:number)=>request<{node:StoryEntry}>(`/atlas/nodes/${id}/restore`,{eventId,expectedVersion},'POST'),
  saveView:(bookId:string,view:AtlasView)=>request<{view:AtlasView}>(`/books/${bookId}/atlas/view`,{...view,expectedVersion:view.version},'PUT'),
  fromPlan:(bookId:string,id:string)=>request<{node:StoryEntry}>(`/books/${bookId}/atlas/from-plan/${id}`,{},'POST'),
  importJob:(bookId:string,id:string)=>request<{relations:AtlasRelation[]}>(`/books/${bookId}/atlas/import-job/${id}`,{},'POST'),
  jobs:(bookId:string)=>request<{jobs:Pick<AiJob,'id'|'kind'|'status'|'instruction'|'createdAt'>[]}>(`/books/${bookId}/atlas/jobs`),
  mentions:(bookId:string,id:string)=>request<{chapters:ChapterSummary[]}>(`/books/${bookId}/atlas/nodes/${id}/mentions`),
};
