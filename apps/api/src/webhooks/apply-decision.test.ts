import { describe, expect, it } from 'vitest';
import { decideWebhookOutcome } from './apply-decision.js';
import type { MessageStatus } from '../campaigns/send-state-machine.js';
import type { ProviderWebhookEvent } from '../sender-config/provider-adapter.js';

const ALL_MESSAGE_STATUSES: MessageStatus[] = [
  'pending', 'queued', 'submitted', 'delivered', 'bounced', 'failed', 'skipped', 'cancelled',
];
const EVENT_TYPES: ProviderWebhookEvent['type'][] = ['delivered', 'bounced', 'complaint', 'deferred', 'unknown'];

const NOW = new Date('2026-08-18T10:00:00.000Z');
const EARLIER = new Date('2026-08-18T09:00:00.000Z');
const LATER = new Date('2026-08-18T11:00:00.000Z');

/**
 * M5-S4 CP4, RED first (BR-SEND-008, SS3.4b's decision table). Exhaustive
 * over the full event-type x current-status grid -- "a delivered event for a
 * failed recipient changes nothing" is a claim about every illegal pair, not
 * just the ones someone thought to write down (same discipline as M5-S3's
 * own send-state-machine.test.ts).
 */
describe('decideWebhookOutcome (M5-S4 CP4, SS3.4b)', () => {
  it('admits delivered/bounced only from submitted, and refuses every other pair as ignored_illegal_transition', () => {
    const legalFrom: MessageStatus = 'submitted';
    const mismatches: string[] = [];
    for (const status of ALL_MESSAGE_STATUSES) {
      for (const type of ['delivered', 'bounced'] as const) {
        const decision = decideWebhookOutcome(type, status, NOW, null);
        const expectLegal = status === legalFrom;
        const actualLegal = decision.outcome === 'applied';
        if (expectLegal !== actualLegal) {
          mismatches.push(`${type} from ${status}: expected applied=${expectLegal}, got outcome=${decision.outcome}`);
        }
        if (!expectLegal) expect(decision.outcome, `${type} from ${status}`).toBe('ignored_illegal_transition');
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('a delivered event applies status=delivered and delivery_state_at=occurredAt, no suppression', () => {
    const decision = decideWebhookOutcome('delivered', 'submitted', NOW, null);
    expect(decision).toEqual({ outcome: 'applied', nextStatus: 'delivered', suppress: null });
  });

  it('a bounced event applies status=bounced, delivery_state_at=occurredAt, and hard_bounce suppression', () => {
    const decision = decideWebhookOutcome('bounced', 'submitted', NOW, null);
    expect(decision).toEqual({ outcome: 'applied', nextStatus: 'bounced', suppress: 'hard_bounce' });
  });

  it('a delivered/bounced event no newer than the last-applied delivery_state_at is ignored_out_of_order, for every legal starting status', () => {
    expect(decideWebhookOutcome('delivered', 'submitted', EARLIER, NOW)).toEqual({ outcome: 'ignored_out_of_order' });
    expect(decideWebhookOutcome('bounced', 'submitted', EARLIER, NOW)).toEqual({ outcome: 'ignored_out_of_order' });
    // Exactly-equal timestamps are also out of order -- "newer than", not "at least as new as".
    expect(decideWebhookOutcome('delivered', 'submitted', NOW, NOW)).toEqual({ outcome: 'ignored_out_of_order' });
  });

  it('a delivered/bounced event strictly newer than delivery_state_at still applies', () => {
    expect(decideWebhookOutcome('delivered', 'submitted', LATER, NOW).outcome).toBe('applied');
  });

  it('D-110: the ordering check runs before the illegal-transition check -- a stale event for an already-terminal recipient reads as out-of-order, not illegal-transition, even though it would also be illegal', () => {
    // 'delivered' from 'bounced' is not a legal edge either (only
    // submitted->delivered/bounced exist), so this event is illegal on BOTH
    // counts -- the point of this test is that staleness is checked first and
    // wins, per D-110's own finding: checking legality first would make
    // ignored_out_of_order unreachable by any two sequential requests, since
    // the row is already terminal by the time a second event arrives.
    const decision = decideWebhookOutcome('delivered', 'bounced', EARLIER, NOW);
    expect(decision.outcome).toBe('ignored_out_of_order');
  });

  it('an illegal transition with no prior delivery_state_at (the realistic never-applied case) is still reported as illegal, not out-of-order', () => {
    const decision = decideWebhookOutcome('delivered', 'failed', NOW, null);
    expect(decision.outcome).toBe('ignored_illegal_transition');
  });

  it('an illegal transition that is also newer than the last-applied event reads as illegal, not out-of-order', () => {
    const decision = decideWebhookOutcome('delivered', 'bounced', LATER, NOW);
    expect(decision.outcome).toBe('ignored_illegal_transition');
  });

  it('a complaint event always applies as complaint-only suppression, regardless of current status, and never changes message status', () => {
    for (const status of ALL_MESSAGE_STATUSES) {
      const decision = decideWebhookOutcome('complaint', status, NOW, null);
      expect(decision, `complaint from ${status}`).toEqual({ outcome: 'applied', nextStatus: null, suppress: 'complaint' });
    }
  });

  it('deferred and unknown events are always ignored_not_applicable, regardless of current status or ordering', () => {
    for (const status of ALL_MESSAGE_STATUSES) {
      for (const type of ['deferred', 'unknown'] as const) {
        expect(decideWebhookOutcome(type, status, NOW, null), `${type} from ${status}`).toEqual({ outcome: 'ignored_not_applicable' });
      }
    }
  });

  it('exhaustive: every (eventType, status) pair over the full grid is covered by exactly one branch, none throws', () => {
    for (const status of ALL_MESSAGE_STATUSES) {
      for (const type of EVENT_TYPES) {
        expect(() => decideWebhookOutcome(type, status, NOW, null)).not.toThrow();
      }
    }
  });
});
