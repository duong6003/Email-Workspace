import { randomUUID } from 'node:crypto';

export type QuotaThresholdEventInput = {
  tenantId: string;
  periodKey: string;
  threshold: number;
  used: number;
  limit: number;
  campaignId: string | null;
  traceId?: string;
};

export function buildQuotaThresholdEvent(input: QuotaThresholdEventInput) {
  return {
    event_id: randomUUID(),
    event_type: 'quota.threshold_reached',
    occurred_at: new Date().toISOString(),
    tenant_id: input.tenantId,
    aggregate_id: input.campaignId,
    version: 1,
    trace_id: input.traceId ?? null,
    data: { period_key: input.periodKey, threshold: input.threshold, used: input.used, limit: input.limit },
  };
}
