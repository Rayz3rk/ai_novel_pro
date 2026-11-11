import type { AiJob, Chapter, ContextItem, ContextPreview, CreateAiJobInput, ModelSettings, PromptSnapshot, SkillSnapshot } from '@shujian/contracts';
import type { Store } from '../store.js';
import type { AiHooks } from './index.js';
import type { AiBudget } from './budget.js';
import type { Message } from './provider.js';
import { estimatedTokens } from './budget.js';
import { verifySelection } from './document.js';
import { creativeHash } from '../creative/definitions.js';
import { AppError, conflict } from '../errors.js';
import { prompt } from './prompts.js';
import { backfillPrompt } from './prompts.js';

export class AiContext {
  private readonly prompt = prompt;
  constructor(private readonly store: Store, private readonly hooks: AiHooks,
    private readonly listChapter: (id: string) => AiJob[], private readonly checkBudget: AiBudget['checkBudget']) {}
  private buildContext(input:CreateAiJobInput,chapter:Chapter,revisionId:string):ContextItem[] {
    const book=this.store.getBook(chapter.bookId);
    const source=input.kind==='extract'&&input.source!=='draft'?this.store.getRevision(chapter.id,revisionId):chapter;
    const structured=input.kind==='extract'||input.kind==='review';
    const context:ContextItem[]=[
      {id:'instruction',label:'作者本次要求',source:'instruction',text:input.instruction,required:true},
      {id:'chapter',label:`第${chapter.position}章 · ${source.title} · V${'sourceVersion' in source?source.sourceVersion:chapter.version}`,source:'chapter',text:structured?JSON.stringify(source.document):source.plainText,chapterId:chapter.id,revisionId,required:true},
      {id:'outline',label:'本章意图（规划，尚未发生）',source:'outline',text:source.outline,required:true},
      {id:'premise',label:'作品方向',source:'premise',text:`${book.title}\n${book.genre}\n${book.premise}`,required:true},
    ];
    if(input.selection)context.push({id:'selection',label:input.kind==='revise'?'仅替换这个选区':'作者选中的讨论片段',source:'chapter',text:input.selection.text,chapterId:chapter.id,revisionId,required:true});
    if(input.pov)context.push({id:'pov',label:'当前视角人物',source:'instruction',text:input.pov,required:true});
    context.push(...(this.hooks.context?.(input,chapter)??[]).filter((item)=>!item.entryId||!input.excludedEntryIds?.includes(item.entryId)));
    if(input.kind==='discuss'||input.kind==='plan'){
      const conversations=this.listChapter(chapter.id).filter((j)=>j.status==='succeeded'&&['discuss','plan'].includes(j.kind)).slice(0,6).reverse();
      for(const j of conversations)context.push({id:`chat:${j.id}`,label:'此前讨论（非正式资料）',source:'conversation',text:`作者：${j.instruction}\n助手：${j.output}`,required:false});
    }
    return context;
  }
  private boundedContext(settings:ModelSettings,kind:AiJob['kind'],items:ContextItem[]):Pick<ContextPreview,'included'|'omitted'|'blocked'> {
    let remaining=settings.contextWindow-settings.maxOutputTokens-estimatedTokens(this.prompt(kind))-128;
    const required=items.filter((item)=>item.required);
    remaining-=required.reduce((sum,item)=>sum+estimatedTokens(item.label+item.text),0);
    const blocked=remaining<0?{code:'CONTEXT_BUDGET',message:'本次要求、正文、技能或固定资料超过上下文预算。请减少材料或调整额度。'}:null;
    const included=[...required];const omitted:ContextPreview['omitted']=[];
    for(const item of items.filter((entry)=>!entry.required)){const cost=estimatedTokens(item.label+item.text);if(cost<=remaining){included.push(item);remaining-=cost;}else omitted.push({item,reason:'输入预算不足，保留必需材料后未能装入本条。'});}
    return {included,omitted,blocked};
  }
  preparePreview(input:CreateAiJobInput,settings:ModelSettings,replay?:SkillSnapshot[]):ContextPreview {
    const chapter=this.store.getChapter(input.chapterId);
    if(chapter.archivedAt)throw new AppError(409,'CHAPTER_ARCHIVED','此章已归档，请先取消归档后再发起任务。');
    if(chapter.version!==input.expectedVersion)conflict(chapter.version);
    if(input.selection)verifySelection(chapter.document,input.selection);
    if(input.kind==='extract'&&input.source!=='draft'&&!chapter.finalizedRevisionId)throw new AppError(422,'FINAL_REQUIRED','先为本章定稿，再从正式正文整理资料。');
    const revisionId=input.kind==='extract'&&input.source!=='draft'?chapter.finalizedRevisionId!:`preview:${chapter.id}:${chapter.version}`;
    const creative=this.hooks.creativity?.(input,chapter,replay)??{items:[],snapshot:{skills:[],profileVersion:0,profileHash:creativeHash({}),voiceIds:[],preferenceIds:[]}};
    const planned=this.boundedContext(settings,input.kind,[...this.buildContext(input,chapter,revisionId),...creative.items]);
    const messages:Message[]=[{role:'system',content:input.backfill?backfillPrompt:this.prompt(input.kind)},{role:'user',content:planned.included.map((item)=>`【${item.label}】\n${item.text}`).join('\n\n')}];
    const snapshot:PromptSnapshot={schema:1,hash:creativeHash({messages,creativity:creative.snapshot}),messages,creativity:creative.snapshot};
    let blocked=planned.blocked;let estimatedCost:number|null=null;
    if(!blocked){try{estimatedCost=this.checkBudget(settings,planned.included,0,messages);}catch(error){if(error instanceof AppError)blocked={code:error.code,message:error.message};else throw error;}}
    if(!blocked&&!settings.model)blocked={code:'MODEL_NOT_CONFIGURED',message:'请先保存模型名称，再开始协作。'};
    const inputTokens=estimatedTokens(messages.map((message)=>`${message.role}\n${message.content}`).join('\n'))+64;
    if(!blocked&&inputTokens+settings.maxOutputTokens>settings.contextWindow)blocked={code:'CONTEXT_BUDGET',message:'实际提示连同输出额度超过上下文窗口，请减少本次材料。'};
    const {requestId:_requestId,previewFingerprint:_previewFingerprint,...selection}=input;
    const fingerprint=creativeHash({selection,settings,prompt:snapshot,context:planned.included});
    return {fingerprint,chapterVersion:chapter.version,model:settings.model,modelConnectionId:settings.id,...planned,blocked,inputTokens,outputTokens:settings.maxOutputTokens,contextWindow:settings.contextWindow,estimatedCost,currency:'USD',prompt:snapshot};
  }
}
