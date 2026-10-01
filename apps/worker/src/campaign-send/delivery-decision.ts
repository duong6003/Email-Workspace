import { isLegalMessageTransition, type MessageStatus } from './send-state-machine.js';

export type { MessageStatus };
export type SuppressionReason = 'hard_bounce' | 'complaint';
export type DeliveryEventType = 'delivered' | 'bounced' | 'complaint' | 'deferred' | 'unknown';

export type ApplyOutcome = 'applied' | 'ignored_out_of_order' | 'ignored_illegal_transition' | 'ignored_not_applicable';

export type ApplyDecision =
  | { outcome: 'applied'; nextStatus: MessageStatus | null; suppress: SuppressionReason | null }
  | { outcome: 'ignored_out_of_order' | 'ignored_illegal_transition' | 'ignored_not_applicable' };

/**
 * BR-SEND-008's decision table (M5-S4-WEBHOOK-PLAN.md SS3.4b), worker-native
 * duplicate of apps/api/src/webhooks/apply-decision.ts's decideWebhookOutcome
 * (DEC-107/DEC-127 transliteration precedent -- neither app can import the
 * other's source). ARCH-PROGRESS-PARITY keeps the two in step. Used by
 * progress-reconcile.ts to apply the identical ordering/legal-transition
 * guard the live webhook path uses, rather than a second copy of that logic
 * with its own bugs (A16).
 */
export function decideWebhookOutcome(
  eventType: DeliveryEventType,
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
