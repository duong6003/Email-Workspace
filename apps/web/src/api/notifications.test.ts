import { describe, expect, it } from 'vitest';
import { notificationRealtimePatch, notificationUnreadCount } from './notifications.js';

describe('notification realtime reconciliation', () => {
  it('accepts an authoritative non-negative unread count', () => {
    expect(notificationUnreadCount({ event_type: 'notification.created', data: { unread_count: 101 } })).toBe(101);
    expect(notificationUnreadCount({ event_type: 'notification.read', data: { unread_count: 0 } })).toBe(0);
  });

  it('ignores malformed and unrelated events', () => {
    expect(notificationUnreadCount({ event_type: 'campaign.progress', data: { unread_count: 3 } })).toBeNull();
    expect(notificationUnreadCount({ event_type: 'notification.updated', data: { unread_count: -1 } })).toBeNull();
  });

  it('extracts an action-state patch from an update event', () => {
    expect(notificationRealtimePatch({ event_type: 'notification.updated', data: { notification_id: 'notification-1', unread_count: 2, action_state: 'resolved' } }))
      .toEqual({ notificationId: 'notification-1', actionState: 'resolved' });
    expect(notificationRealtimePatch({ event_type: 'campaign.progress', data: { notification_id: 'notification-1' } })).toBeNull();
  });
});
