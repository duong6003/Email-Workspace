import { AsyncLocalStorage } from 'node:async_hooks';

export type JobContext = {
  traceId: string;
  tenantId: string | null;
  jobName: string;
  jobId: string | null;
  campaignId?: string | null;
};

const jobContext = new AsyncLocalStorage<JobContext>();

export function runWithJobContext<T>(context: JobContext, work: () => T): T {
  return jobContext.run(context, work);
}

export function getJobContext(): JobContext | undefined {
  return jobContext.getStore();
}

export function updateJobContext(values: Partial<JobContext>): void {
  const context = jobContext.getStore();
  if (context) Object.assign(context, values);
}
