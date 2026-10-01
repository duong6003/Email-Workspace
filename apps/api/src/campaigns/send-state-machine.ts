import type { CampaignStatus } from '../database/entities/campaign.entity.js';

export type MessageStatus = 'pending' | 'queued' | 'submitted' | 'delivered' | 'bounced' | 'failed' | 'skipped' | 'cancelled';

/**
 * BR-SEND-001/BR-SEND-009. The ten execution-phase edges this module owns
 * (SS3.3 plus ADR-027's pause/resume pair), not a general campaign-status
 * machine: draft/scheduled/blocked/missed and their own transitions belong
 * to M4-S1/M5-S2's already-closed code paths and are deliberately absent
 * here. `sending->paused`/`paused->sending` are the only edges touching
 * `paused` (M6-S3, ADR-027) -- no `paused->cancelled` edge exists, since no
 * rule asks for cancelling from a paused state and this table is a
 * specification, not a convenience.
 */
const LEGAL_CAMPAIGN_EXECUTION_EDGES: ReadonlySet<string> = new Set([
  'queued->validating',
  'validating->sending',
  'validating->failed',
  'validating->completed',
  'sending->completed',
  'sending->partial_failed',
  'sending->failed',
  'sending->cancelled',
  'sending->paused',
  'paused->sending',
]);

export function isLegalCampaignExecutionTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return LEGAL_CAMPAIGN_EXECUTION_EDGES.has(`${from}->${to}`);
}

/**
 * BR-SEND-002. 'skipped' is set only at freeze (an INSERT), never entered
 * via an UPDATE transition (D-88) -- it has no legal inbound edge here even
 * though it is a real, reachable status. 'delivered'/'bounced' are legal but
 * unreached until M5-S4 owns the webhook that calls this function with them
 * (DEC-096).
 */
const LEGAL_MESSAGE_EDGES: ReadonlySet<string> = new Set([
  'pending->queued',
  'pending->cancelled',
  'queued->submitted',
  'queued->failed',
  'submitted->delivered',
  'submitted->bounced',
]);

export function isLegalMessageTransition(from: MessageStatus, to: MessageStatus): boolean {
  return LEGAL_MESSAGE_EDGES.has(`${from}->${to}`);
}
