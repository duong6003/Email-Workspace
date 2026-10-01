import { describe, expect, it } from 'vitest';
import { isCategoryMuteable, NOTIFICATION_TRIGGERS, renderNotificationMessage, severityPresentation, withinBatchWindow } from './notification-rules.js';
import { notificationMetric } from './notification-metrics.js';

/**
 * Pure-function coverage only. Rules whose behaviour is durability, tenant/user
 * scoping, dedup, read-state or action-state have no meaningful pure-function
 * shape to assert on here — asserting on a JS literal (e.g. `new Set(['read',
 * 'read']).size`) would pass regardless of whether the real code is correct, so
 * those rules are proven instead by apps/api/test/integration/notifications.test.ts
 * (TC-NOT-001/002/006, TC-NOT-004/005/012, TC-NOT-003/008/010, TC-NOT-011,
 * TC-NOT-016) and apps/api/test/integration/notification-preference-rls.test.ts.
 * See the M6-S2 review inbox entry for the rule -> evidence mapping, including
 * the two rules (BR-NOT-003 deep-link revocation, BR-NOT-013 retention/purge)
 * that remain open gaps rather than closed.
 */
describe('M6-S2 notification rules (authored in run)', () => {
  it('BR-NOT-007: Severity is info, success, warning or critical and controls icon/color only; it does not replace event type.', () => {
    expect(severityPresentation('critical')).toEqual({ icon: 'critical', color: 'red' });
    expect(severityPresentation('info')).toEqual({ icon: 'info', color: 'blue' });
  });
  it('BR-NOT-008: Users may mute optional event categories; security, permission and critical delivery failures cannot be muted unless policy allows.', () => {
    expect(isCategoryMuteable('import')).toBe(true);
    expect(isCategoryMuteable('security')).toBe(false);
    expect(isCategoryMuteable('permission')).toBe(false);
    expect(isCategoryMuteable('critical_delivery_failure')).toBe(false);
  });
  it('BR-NOT-011: High-volume similar events are grouped into one summary notification within a configured window.', () => {
    expect(withinBatchWindow(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:04:00Z'), 300)).toBe(true);
    expect(withinBatchWindow(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:06:00Z'), 300)).toBe(false);
  });
  it('BR-NOT-014: Campaign completion/failure, schedule dispatch/miss, import/bulk completion, sender failure and quota thresholds have explicit trigger definitions.', () => {
    expect(NOTIFICATION_TRIGGERS.map((trigger) => trigger.sourceEvent)).toEqual(
      expect.arrayContaining(['campaign.completed', 'campaign.failed', 'schedule.dispatch', 'schedule.miss', 'import.completed', 'bulk_update.completed', 'sender.failed', 'quota.threshold_reached']),
    );
    // BR-NOT-014's "explicit" requirement extends to registering, not fabricating,
    // triggers whose source event doesn't exist yet (plan §1 hard non-goal).
    const unwired = NOTIFICATION_TRIGGERS.filter((trigger) => !trigger.wired);
    expect(unwired.every((trigger) => typeof trigger.owner === 'string' && trigger.owner.length > 0)).toBe(true);
  });
  it('BR-NOT-015: Store message key and structured parameters, not only rendered text, so UI can render the user\'s locale.', () => {
    expect(renderNotificationMessage({ messageKey: 'job.done', params: { count: 2 }, fallback: 'Đã xử lý {count}' })).toBe('Đã xử lý 2');
  });
  it('BR-NOT-016: Notification creation, socket delivery, channel attempt and read action emit metrics with notification/event IDs but no unmasked PII.', () => {
    const metric = notificationMetric({ notificationId: 'n1', eventId: 'e1', action: 'read', recipient: 'hidden@example.test' });
    expect(metric).toEqual({ notification_id: 'n1', event_id: 'e1', action: 'read' });
  });
});
