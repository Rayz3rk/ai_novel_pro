import type { AiJob } from '@shujian/contracts';

export interface BillingJob extends AiJob { billingSourceId?: string }
export interface BillingCall {
  id: string; jobId: string | null; billingSourceId?: string; createdAt: string;
  status: string; estimatedCost: number | null; reservedCost?: number | null;
}
export interface JobBudgetRow { id: string; reserved_cost: number | null; job: Pick<BillingJob,'billingSourceId'|'createdAt'|'status'|'usage'> }
const active = (status: string) => status === 'queued' || status === 'running';

/** Actual usage stays separate from a conservative allowance for an unfinished/unknown call. */
export function callCommitment(call: BillingCall): number {
  return active(call.status) ? Math.max(call.estimatedCost ?? 0, call.reservedCost ?? 0)
    : call.estimatedCost ?? call.reservedCost ?? 0;
}

/** Restoring the same history is not a new provider request. Never let a cheaper copy erase a larger commitment. */
export function dailyCommitment(rows: JobBudgetRow[], calls: BillingCall[], day: string, excludePendingJobId?: string): number {
  const jobs = new Map(rows.map((row) => [row.id, row.job.billingSourceId ?? row.id]));
  const byJob = new Map<string, BillingCall[]>();
  const groups = new Map<string, { amount: number; jobs: Set<string> }>();
  for (const call of calls) {
    if (!call.createdAt.startsWith(day)) continue;
    const id = call.billingSourceId ?? call.id;
    const group = groups.get(id) ?? { amount: 0, jobs: new Set<string>() };
    group.amount = Math.max(group.amount, callCommitment(call));
    if (call.jobId) {
      const source = jobs.get(call.jobId) ?? call.jobId;
      group.jobs.add(source);
      const list = byJob.get(call.jobId) ?? []; list.push(call); byJob.set(call.jobId, list);
    }
    groups.set(id, group);
  }
  let total = 0;
  const perJob = new Map<string, number>();
  for (const group of groups.values()) {
    total += group.amount;
    for (const job of group.jobs) perJob.set(job, (perJob.get(job) ?? 0) + group.amount);
  }
  const floors = new Map<string, number>();
  for (const row of rows) {
    const source = row.job.billingSourceId ?? row.id;
    const related = byJob.get(row.id) ?? [];
    let floor = 0;
    if (active(row.job.status) && row.job.usage.attempts === 0 && related.length === 0 && row.id !== excludePendingJobId) {
      floor = row.reserved_cost ?? 0;
    } else if (related.some((call) => call.estimatedCost === null && call.reservedCost === undefined)) {
      // Legacy rows have only a cumulative job allowance. Retain its conservative upper bound.
      floor = row.reserved_cost ?? row.job.usage.estimatedCost ?? 0;
    } else if (related.length === 0 && row.job.createdAt.startsWith(day) && row.job.usage.attempts > 0) {
      floor = row.job.usage.estimatedCost ?? row.reserved_cost ?? 0;
    }
    floors.set(source, Math.max(floors.get(source) ?? 0, floor));
  }
  for (const [job, floor] of floors) total += Math.max(0, floor - (perJob.get(job) ?? 0));
  return total;
}
