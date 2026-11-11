import type { AiJob, ContextItem, ModelSettings } from '@shujian/contracts';
import type { Store } from '../store.js';
import type { AiCall } from './index.js';
import type { Message } from './provider.js';
import { AppError } from '../errors.js';
import { callCommitment, dailyCommitment, type BillingJob } from './budget-ledger.js';
const timestamp = () => new Date().toISOString();
function estimatedTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, 'utf8') / 2) + 16; }
function price(settings: ModelSettings, input: number | null, output: number | null): number | null {
  return input === null || output === null || settings.inputPricePerMillion === null || settings.outputPricePerMillion === null ? null
    : (input * settings.inputPricePerMillion + output * settings.outputPricePerMillion) / 1_000_000;
}
export { estimatedTokens, price };
export class AiBudget {
  constructor(private readonly store: Store, private readonly calls: (id: string) => AiCall[], private readonly prompt: () => string) {}
  callDateExpression():string {return this.store.db.kind==='postgresql'?"payload::jsonb->>'createdAt'":"json_extract(payload,'$.createdAt')";}
  dailyCommitted(excludeJobId?:string):number {
    const day=timestamp().slice(0,10);
    const start=`${day}T00:00:00.000Z`;
    const end=new Date(Date.parse(start)+86_400_000).toISOString();
    const date=this.callDateExpression();
    const calls=this.store.db.prepare(`SELECT payload FROM ai_calls WHERE ${date}>=? AND ${date}<?`).all(start,end) as Array<{payload:string}>;
    const rows=this.store.db.prepare(`SELECT id,reserved_cost,job FROM ai_jobs WHERE created_at>=? OR status IN ('queued','running') OR id IN (SELECT job_id FROM ai_calls WHERE ${date}>=? AND ${date}<?)`).all(start,start,end) as Array<{id:string;reserved_cost:number|null;job:string}>;
    return dailyCommitment(rows.map((row)=>({...row,job:JSON.parse(row.job) as BillingJob})),calls.map((row)=>JSON.parse(row.payload) as AiCall),day,excludeJobId);
  }
  checkBudget(settings:ModelSettings,context:ContextItem[],reservedElsewhere=0,messages?:Message[]):number|null {
    const tokens=messages?estimatedTokens(messages.map((message)=>`${message.role}\n${message.content}`).join('\n'))+64:context.reduce((sum,item)=>sum+estimatedTokens(item.label+item.text),estimatedTokens(this.prompt()));
    const reservation=price(settings,tokens,settings.maxOutputTokens);
    if((settings.taskBudget!==null||settings.dailyBudget!==null)&&reservation===null)throw new AppError(422,'PRICE_REQUIRED','设置费用上限时，需要填写输入和输出单价；未知价格无法可靠限制预算。');
    if(settings.taskBudget!==null&&reservation!==null&&reservation>settings.taskBudget)throw new AppError(422,'TASK_BUDGET','本次调用的预留费用超过任务预算，请缩小范围或调整预算。');
    if(settings.dailyBudget!==null&&reservation!==null){
      const spent=reservedElsewhere+this.dailyCommitted();
      if(spent+reservation>settings.dailyBudget)throw new AppError(422,'DAILY_BUDGET','今日用量和在途任务已达到预算，暂不新增模型调用。');
    }
    return reservation;
  }

  checkRetryBudget(settings:ModelSettings,job:AiJob,messages:Message[]):number|null {
    const tokens=estimatedTokens(messages.map((message)=>`${message.role}\n${message.content}`).join('\n'))+64;
    if(tokens+settings.maxOutputTokens>settings.contextWindow)throw new AppError(422,'CONTEXT_BUDGET','本次调用或格式修正超过上下文窗口，已停止新增调用，原始结果保留在调用记录中。');
    const next=price(settings,tokens,settings.maxOutputTokens);
    if(next===null)return null;
    const prior=this.calls(job.id).reduce((sum,call)=>sum+callCommitment(call),0);
    const total=prior+next;
    if(settings.taskBudget!==null&&total>settings.taskBudget)throw new AppError(422,'TASK_BUDGET','继续调用会超过任务预算，已停止新增调用。');
    if(settings.dailyBudget!==null){
      const spent=this.dailyCommitted(job.id);
      if(spent+next>settings.dailyBudget)throw new AppError(422,'DAILY_BUDGET','今日用量和在途任务已达到预算，暂不新增调用。');
    }
    this.store.db.prepare('UPDATE ai_jobs SET reserved_cost=? WHERE id=?').run(total,job.id);
    return next;
  }
}
