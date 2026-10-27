import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { UpdateModelSettings } from '@shujian/contracts';
import { AppError } from '../errors.js';
import * as v from '../validation.js';
import { modelSettings } from './validation.js';

export function readConnectionsFile(path:string,defaults:Omit<import('@shujian/contracts').ModelSettings,'hasApiKey'>):{hash:string;activeId:string;connections:Array<{id:string;settings:UpdateModelSettings}>}|null {
  if(!existsSync(path))return null;
  try {
    if(statSync(path).size>256*1024)throw new Error('oversize');
    const text=readFileSync(path,'utf8').replace(/^\uFEFF/,'');
    const source=v.object(JSON.parse(text) as unknown,'本机连接配置');
    if(!Array.isArray(source.connections)||source.connections.length<1||source.connections.length>30)v.invalid('connections 应包含 1–30 个连接。');
    const ids=new Set<string>();
    const connections=source.connections.map((value)=>{const row=v.object(value);const id=v.string(row.id,'连接 ID',128,1);if(!/^[a-zA-Z0-9-]+$/.test(id)||ids.has(id))v.invalid('连接 ID 必须由英文字母、数字或短横线组成且不能重复。');ids.add(id);return{id,settings:modelSettings({...defaults,...row})};});
    const activeId=v.string(source.activeConnection??connections[0]!.id,'当前连接 ID',128,1);
    if(!ids.has(activeId))v.invalid('activeConnection 必须对应一个连接 ID。');
    return{hash:createHash('sha256').update(text).digest('hex'),activeId,connections};
  }catch(error){
    const hint=error instanceof AppError?error.message:'请检查 JSON 格式、文件大小与读取权限。';
    throw new AppError(400,'LOCAL_MODEL_CONFIG',`本机模型配置无法读取：${path}。${hint}`);
  }
}
