import { randomUUID } from 'node:crypto';
import { progressPercent, rollupCounts, type EtaEstimate, type ProgressCounts } from './progress-math.js';

/**
 * campaign.progress's AsyncAPI EventEnvelope, built once here and once at
 * apps/worker/src/campaign-send/progress-event.ts (DEC-107/DEC-123
 * transliteration precedent -- ARCH-PROGRESS-PARITY keeps the two in step).
 * `version` is campaign_execution.progress_seq, never campaign.version
 * (D-116/DEC-122): campaign.version only bumps on status transitions, so
 * during 'sending' it stays constant and would collide as a dedupe key
 * across every progress event in the run.
 */
export type ProgressEvent = {
  event_id: string;
  event_type: 'campaign.progress';
  occurred_at: string;
  tenant_id: string;
  aggregate_id: string;
  version: number;
  data: {
    campaign_id: string; execution_id: string; status: string;
    total: number; actionable: number; percent: number;
    counts: ProgressCounts;
    queued: number; sent: number; delivered: number; failed: number;
    eta: EtaEstimate | null;
  };
};

export type ResyncEvent = {
  event_id: string;
  event_type: 'rt.resync_required';
  occurred_at: string;
  tenant_id: string;
  aggregate_id: string;
  version: number;
  data: { campaign_id: string };
};

export type CampaignEventPublisher = (event: ProgressEvent | ResyncEvent) => Promise<void>;

export function buildProgressEvent(input: {
  tenantId: string; campaignId: string; executionId: string;
  progressSeq: number; counts: ProgressCounts; actionable: number;
  totalSnapshot: number; status: string; eta: EtaEstimate | null;
}): ProgressEvent {
  const rollups = rollupCounts(input.counts);
  return {
    event_id: randomUUID(),
    event_type: 'campaign.progress',
    occurred_at: new Date().toISOString(),
    tenant_id: input.tenantId,
    aggregate_id: input.campaignId,
    version: input.progressSeq,
    data: {
      campaign_id: input.campaignId,
      execution_id: input.executionId,
      status: input.status,
      total: input.totalSnapshot,
      actionable: input.actionable,
      percent: progressPercent(input.counts, input.actionable),
      counts: input.counts,
      ...rollups,
      eta: input.eta,
    },
  };
}
