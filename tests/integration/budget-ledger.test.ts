import { describe, expect, it } from 'vitest';
import { dailyCommitment, type BillingCall, type JobBudgetRow } from '../../apps/server/src/ai/budget-ledger.js';

const day='2026-10-26';
const call=(id:string,cost:number|null,reserved:number|undefined,status='succeeded',jobId:string|null='job'):BillingCall=>({
  id,jobId,status,createdAt:day+'T01:00:00.000Z',estimatedCost:cost,...(reserved===undefined?{}:{reservedCost:reserved}),
});
const job=(id:string,source=id):JobBudgetRow=>({id,reserved_cost:0.8,job:{billingSourceId:source,createdAt:day+'T00:00:00.000Z',status:'running',usage:{inputTokens:null,outputTokens:null,estimatedCost:null,attempts:1,currency:'USD'}}});

describe('stable provider billing provenance',()=>{
  it('does not count restoration as another call or let a cheaper copy erase an unfinished allowance',()=>{
    const original={...call('source-call',null,0.8,'running'),billingSourceId:'source-call'};
    const copy={...call('restored-call',0,0,'interrupted','copy'),billingSourceId:'source-call'};
    expect(dailyCommitment([job('job'),job('copy','job')],[original,copy],day)).toBe(0.8);
    expect(dailyCommitment([job('job'),job('copy','job')],[{...original,status:'succeeded',estimatedCost:0.5},copy],day)).toBe(0.5);
    expect(dailyCommitment([job('job')],[{...original,status:'succeeded',estimatedCost:0.5},call('real-retry',0.2,0.8)],day)).toBe(0.7);
  });
  it('charges a cross-midnight repair on its own UTC request day, not the parent task day',()=>{
    const prior={...call('yesterday',0.4,0.8),createdAt:'2026-10-25T23:59:50.000Z'};
    const repair=call('today',null,0.6,'running');
    const record=job('job');record.job.createdAt='2026-10-25T23:59:40.000Z';
    expect(dailyCommitment([record],[prior,repair],day)).toBe(0.6);
  });
  it('preserves legacy cumulative bounds without multiplying them across restored jobs',()=>{
    const original=call('old-call',null,undefined,'interrupted');
    const copy={...call('copy-call',null,undefined,'interrupted','copy'),billingSourceId:'old-call'};
    expect(dailyCommitment([job('job'),job('copy','job')],[original,copy],day)).toBe(0.8);
  });
  it('reserves queued work but does not count its own placeholder again when opening a request',()=>{
    const queued=job('queued');queued.job.usage.attempts=0;
    expect(dailyCommitment([queued],[],day)).toBe(0.8);
    expect(dailyCommitment([queued],[],day,'queued')).toBe(0);
    queued.job.status='cancelled';
    expect(dailyCommitment([queued],[],day)).toBe(0);
  });
});
