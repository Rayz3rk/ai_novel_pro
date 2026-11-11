import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AiJob, ModelSettings } from '@shujian/contracts';
import type { Store } from '../store.js';
import type { Credentials } from './credentials.js';
import type { AiHooks, AiCall } from './index.js';
import { AppError } from '../errors.js';
import { complete, ProviderError, type Message } from './provider.js';
import { price } from './budget.js';
import { prompt } from './prompts.js';
import { creativeHash } from '../creative/definitions.js';
const timestamp = () => new Date().toISOString();
const active = (status: AiJob['status']) => status === 'queued' || status === 'running';
export function safeError(error: unknown): string {
  if (error instanceof AppError || error instanceof ProviderError) return error.message;
  return '任务未完成，收到的文字已经保留。请检查模型连接后重试。';
}
function parseStructured(output: string): boolean {
  try { JSON.parse(output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); return true; } catch { return false; }
}
interface RunnerDependencies {
  store: Store; credentials: Credentials; controllers: Map<string, AbortController>; hooks: AiHooks;
  get: (id: string) => AiJob; write: (job: AiJob) => void; writeCall: (call: AiCall) => void;
  calls: (id: string) => AiCall[]; checkRetryBudget: (settings: ModelSettings, job: AiJob, messages: Message[]) => number | null;
  isClosed: () => boolean;
}
export class AiRunner {
  constructor(private readonly dependencies: RunnerDependencies) {}
  async execute(id:string):Promise<void> {
    const controller=new AbortController();this.dependencies.controllers.set(id,controller);
    let job=this.dependencies.get(id);job.status='running';this.dependencies.write(job);
    const row=this.dependencies.store.db.prepare('SELECT settings FROM ai_jobs WHERE id=?').get(id) as {settings:string|null};
    if(!row.settings){job.status='interrupted';job.error='恢复的任务没有绑定模型连接，请创建新任务。';this.dependencies.write(job);this.dependencies.controllers.delete(id);return;}
    const settings=JSON.parse(row.settings) as ModelSettings;
    const messages:Message[]=job.promptSnapshot?structuredClone(job.promptSnapshot.messages):[{role:'system',content:prompt(job.kind)},{role:'user',content:job.context.map((item)=>`【${item.label}】\n${item.text}`).join('\n\n')}];
    let inputTotal:number|null=null;let outputTotal:number|null=null;let totalCost:number|null=null;let repaired=false;
    try {
      const apiKey=this.dependencies.credentials.get(settings.id);
      for(let attempt=1;attempt<=3;attempt++){
        if(controller.signal.aborted||!active(this.dependencies.get(id).status))return;
        const reservedCost=this.dependencies.checkRetryBudget(settings,this.dependencies.get(id),messages);
        const callId=randomUUID();
        const call:AiCall={id:callId,billingSourceId:callId,jobId:id,attempt,model:settings.model,status:'running',inputTokens:null,outputTokens:null,estimatedCost:null,reservedCost,error:null,createdAt:timestamp(),updatedAt:timestamp()};
        call.requestMessages=structuredClone(messages);call.promptHash=creativeHash(call.requestMessages);
        this.dependencies.writeCall(call);job=this.dependencies.get(id);job.usage.attempts=attempt;this.dependencies.write(job);
        let received=false;
        try {
          await complete({settings,apiKey,messages,signal:controller.signal,onText:(text)=>{
            call.output=(call.output??'')+text;
            const current=this.dependencies.get(id);if(!active(current.status)||controller.signal.aborted)return;received=true;current.output+=text;this.dependencies.write(current);
          },onUsage:(u)=>{call.inputTokens=u.inputTokens;call.outputTokens=u.outputTokens;}});
          if(!active(this.dependencies.get(id).status)||controller.signal.aborted){call.status='cancelled';return;}
          call.status='succeeded';call.estimatedCost=price(settings,call.inputTokens,call.outputTokens);
          inputTotal=call.inputTokens===null?null:(inputTotal??0)+call.inputTokens;outputTotal=call.outputTokens===null?null:(outputTotal??0)+call.outputTokens;
          totalCost=call.estimatedCost===null?null:(totalCost??0)+call.estimatedCost;
          job=this.dependencies.get(id);job.usage={...job.usage,inputTokens:inputTotal,outputTokens:outputTotal,estimatedCost:totalCost};
          try {
            if((job.kind==='review'||job.kind==='extract')&&!parseStructured(job.output))throw new AppError(422,'STRUCTURED_OUTPUT','模型结果不是有效 JSON，原始结果已保留。');
            this.dependencies.hooks.completed?.(job);
          } catch (error) {
            if(['review','extract'].includes(job.kind)&&error instanceof AppError&&error.statusCode<500&&!repaired&&attempt<3){
              const repair:Message[]=[...messages,{role:'assistant',content:job.output},{role:'user',content:`上个结果未符合结构或证据要求：${safeError(error)}。请只输出符合约定的完整JSON，不编造引文或ID。`}];
              this.dependencies.writeCall(call);
              this.dependencies.checkRetryBudget(settings,job,repair);repaired=true;messages.splice(0,messages.length,...repair);
              this.dependencies.store.db.transaction(()=>{this.dependencies.writeCall(call);job.output='';this.dependencies.write(job);})();continue;
            }
            throw error;
          }
          job.status='succeeded';job.error=null;this.dependencies.write(job);return;
        } catch(error){
          call.status=controller.signal.aborted?'cancelled':'failed';call.error=controller.signal.aborted?'任务已停止。':safeError(error);call.estimatedCost=price(settings,call.inputTokens,call.outputTokens);
          if(controller.signal.aborted||!active(this.dependencies.get(id).status))return;
          if(error instanceof ProviderError&&error.retryable&&!received&&attempt<2){this.dependencies.writeCall(call);this.dependencies.checkRetryBudget(settings,this.dependencies.get(id),messages);await delay(500*attempt,undefined,{signal:controller.signal});continue;}
          throw error;
        }finally{call.updatedAt=timestamp();this.dependencies.writeCall(call);}
      }
    }catch(error){job=this.dependencies.get(id);if(active(job.status)){job.status=this.dependencies.isClosed()?'interrupted':'failed';job.error=safeError(error);this.dependencies.write(job);}}
    finally{
      const current=this.dependencies.get(id);const calls=this.dependencies.calls(id);
      const known=calls.length>0&&calls.every((c)=>c.inputTokens!==null&&c.outputTokens!==null);
      current.usage.inputTokens=known?calls.reduce((sum,c)=>sum+c.inputTokens!,0):null;
      current.usage.outputTokens=known?calls.reduce((sum,c)=>sum+c.outputTokens!,0):null;
      current.usage.estimatedCost=calls.length>0&&calls.every((c)=>c.estimatedCost!==null)?calls.reduce((sum,c)=>sum+c.estimatedCost!,0):null;
      this.dependencies.write(current);this.dependencies.controllers.delete(id);
    }
  }
}
