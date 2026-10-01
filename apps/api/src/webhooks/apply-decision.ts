import { isLegalMessageTransition, type MessageStatus } from '../campaigns/send-state-machine.js';
import type { ProviderWebhookEvent } from '../sender-config/provider-adapter.js';
import type { SuppressionReason } from './suppression.js';

export type ApplyOutcome = 'applied' | 'ignored_out_of_order' | 'ignored_illegal_transition' | 'ignored_not_applicable';

export type ApplyDecision =
  | { outcome: 'applied'; nextStatus: MessageStatus | null; suppress: SuppressionReason | null }
  | { outcome: 'ignored_out_of_order' | 'ignored_illegal_transition' | 'ignored_not_applicable' };

/**
 * BR-SEND-008's decision table (M5-S4-WEBHOOK-PLAN.md SS3.4b). Pure and
 * DB-free by design: given the row already locked by the caller's own
 * `SELECT ... FOR UPDATE`, this is the entire rule for what a webhook event
 * is allowed to change, checkable exhaustively over the full grid without a
 * database (apply-decision.test.ts).
 *
 * Worker-native duplicate at
 * apps/worker/src/campaign-send/delivery-decision.ts (M6-S1 CP9, DEC-127):
 * progress-reconcile.ts reuses this exact decision table to repair drift
 * from the delivery_event ledger, rather than a second copy with its own
 * bugs (A16). ARCH-PROGRESS-PARITY keeps the two in step.
 *
 * Two independent guards. Order matters and is not arbitrary (D-110, found
 * while writing this checkpoint's own integration test for the ordering
 * case): `delivered`/`bounced` each have exactly one inbound edge
 * (`submitted->…`) and zero outbound edges, so the instant the first such
 * event applies, the row leaves `submitted` permanently -- a *second* event
 * of the same class, checked legality-first, would always fail
 * `isLegalMessageTransition` regardless of its own timestamp, making
 * `ignored_out_of_order` unreachable by any two sequential requests. Staleness
 * is therefore checked first: an event no newer than the row's own
 * `deliveryStateAt` is stale information and is reported as such whether or
 * not it would also have been an illegal transition. Only a genuinely newer
 * event goes on to ask whether the transition itself is legal.
 */
export function decideWebhookOutcome(
  eventType: ProviderWebhookEvent['type'],
  currentStatus: MessageStatus,
  occurredAt: Date,
  deliveryStateAt: Date | null,
): ApplyDecision {
  if (eventType === 'complaint') {
    return { outcome: 'applied', nextStatus: null, suppress: 'complaint' };
  }
  if (eventType === 'deferred' || eventType === 'unknown') {
    return { outcome: 'ignored_not_applicable' };
  }

  // eventType is 'delivered' or 'bounced' from here.
  if (deliveryStateAt !== null && occurredAt.getTime() <= deliveryStateAt.getTime()) {
    return { outcome: 'ignored_out_of_order' };
  }
  if (!isLegalMessageTransition(currentStatus, eventType)) {
    return { outcome: 'ignored_illegal_transition' };
  }

  return {
    outcome: 'applied',
    nextStatus: eventType,
    suppress: eventType === 'bounced' ? 'hard_bounce' : null,
  };
}
