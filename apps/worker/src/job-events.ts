import { randomUUID } from 'node:crypto';

export type JobEventInput = {
  tenantId: string;
  jobId: string;
  eventType: 'import.progress' | 'import.completed' | 'bulk_update.progress' | 'bulk_update.completed' | 'export.completed';
  version: number;
  data: Record<string, unknown>;
};

export function buildJobEvent(input: JobEventInput): Record<string, unknown> {
  return {
    event_id: randomUUID(),
    event_type: input.eventType,
    occurred_at: new Date().toISOString(),
    tenant_id: input.tenantId,
    aggregate_id: input.jobId,
    version: input.version,
    data: input.data,
  };
}

export function shouldEmitProgress(lastEmittedAt: Date | null, now = new Date()): boolean {
  return lastEmittedAt === null || now.getTime() - lastEmittedAt.getTime() >= 1_000;
}
