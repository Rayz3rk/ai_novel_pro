import type { AtlasLinks } from '@shujian/contracts';
import * as v from '../validation.js';

export function attributes(value: unknown): Record<string, string> {
  const row=v.object(value,'卡片属性');
  if(Object.keys(row).length>32)v.invalid('每张卡片最多 32 个属性。');
  const result:Record<string,string>={};
  for(const [key,text] of Object.entries(row)){
    if(['__proto__','constructor','prototype'].includes(key))v.invalid('属性名称不支持。');
    v.string(key,'属性名称',60,1);Object.defineProperty(result,key,{value:v.string(text,'属性内容',4000),enumerable:true});
  }
  if(JSON.stringify(result).length>40000)v.invalid('卡片属性过长。');return result;
}
export function ids(value:unknown,label:string,maximum=100):string[]{
  if(!Array.isArray(value)||value.length>maximum)v.invalid(`${label}格式不正确。`);
  const values=value.map(item=>v.string(item,label,128,1));if(new Set(values).size!==values.length)v.invalid(`${label}不可重复。`);return values;
}
export function links(value:unknown):AtlasLinks{
  const row=v.object(value,'卡片关联');if(Object.keys(row).some(key=>!['voiceId','planId','parentId','chapterIds'].includes(key)))v.invalid('卡片关联字段不支持。');
  return {...(row.voiceId===undefined?{}:{voiceId:v.string(row.voiceId,'人物声音',128,1)}),...(row.planId===undefined?{}:{planId:v.string(row.planId,'场景规划',128,1)}),...(row.parentId===undefined?{}:{parentId:v.string(row.parentId,'上级卡片',128,1)}),...(row.chapterIds===undefined?{}:{chapterIds:ids(row.chapterIds,'关联章节')})};
}
