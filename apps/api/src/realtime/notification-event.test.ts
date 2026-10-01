import { describe, expect, it } from 'vitest';
import { buildNotificationRealtimeEvent } from './notification-event.js';

describe('notification realtime envelope', () => {
  it('targets the affected user and carries only reconciliation identifiers', () => {
    expect(buildNotificationRealtimeEvent({ eventType: 'notification.created', tenantId: 'tenant-1', userId: 'user-1', notificationId: 'notification-1', unreadCount: 12 })).toMatchObject({
      event_type: 'notification.created',
      tenant_id: 'tenant-1',
      aggregate_id: 'user-1',
      data: { notification_id: 'notification-1', unread_count: 12 },
    });
  });

  it('carries action state for a realtime notification action update', () => {
    expect(buildNotificationRealtimeEvent({
      eventType: 'notification.updated', tenantId: 'tenant-1', userId: 'user-1',
      notificationId: 'notification-1', unreadCount: 3, actionState: 'resolved',
    }).data).toEqual({ notification_id: 'notification-1', unread_count: 3, action_state: 'resolved' });
  });
});
