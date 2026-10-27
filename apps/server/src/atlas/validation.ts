import type { AtlasPhase, AtlasSelection, SaveAtlasRelation, SaveAtlasState } from '@shujian/contracts';
import * as v from '../validation.js';
import { evidence, names, oneOf } from '../story/validation.js';
import { attributes, ids } from './card-validation.js';

export function selection(value:unknown):AtlasSelection{
  const row=v.object(value,'图谱材料');if(typeof row.includeIdeas!=='boolean')v.invalid('请选择是否使用构思。');
  return {nodeIds:ids(row.nodeIds,'选中卡片',30),relationIds:ids(row.relationIds,'选中关系',60),includeIdeas:row.includeIdeas,branch:v.string(row.branch??'主线','构思方案',80,1)};
}
export function base(value:unknown){
  const row=v.object(value,'图谱记录');const visibility=oneOf(row.visibility??'public',['public','author','characters'] as const,'知情范围');const knownBy=names(row.knownBy,'知情人物');
  if(visibility==='characters'&&!knownBy.length)v.invalid('请填写知情人物。');
  const phase:AtlasPhase=oneOf(row.phase??'idea',['idea','confirmed','withdrawn'] as const,'确认状态');
  return {phase,branch:v.string(row.branch??'主线','构思方案',80,1),fromChapter:v.integer(row.fromChapter??1,'生效章节',1,1000000),storyTime:v.string(row.storyTime??'','故事时间',300),visibility,knownBy,evidence:evidence(row.evidence),sourceJobId:row.sourceJobId==null?null:v.string(row.sourceJobId,'来源任务',128,1),...(row.expectedVersion===undefined?{}:{expectedVersion:v.integer(row.expectedVersion,'记录版本',1)})};
}
export function relation(value:unknown):SaveAtlasRelation{
  const row=v.object(value);const common=base(row);if(typeof row.symmetric!=='boolean')v.invalid('请选择关系方向。');
  const toChapter=row.toChapter==null?null:v.integer(row.toChapter,'结束章节',common.fromChapter,1000000);
  return {...common,fromId:v.string(row.fromId,'关系起点',128,1),toId:v.string(row.toId,'关系终点',128,1),label:v.string(row.label,'关系含义',100,1).trim(),description:v.string(row.description??'','关系说明',10000),symmetric:row.symmetric,toChapter};
}
export function state(value:unknown):SaveAtlasState{
  const row=v.object(value);return {...base(row),nodeId:v.string(row.nodeId,'卡片',128,1),summary:v.string(row.summary,'状态变化',2000,1).trim(),changes:attributes(row.changes??{})};
}
