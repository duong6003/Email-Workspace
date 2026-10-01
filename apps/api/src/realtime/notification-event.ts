import { randomUUID } from 'node:crypto';

export type NotificationRealtimeEventType = 'notification.created' | 'notification.updated' | 'notification.read';

export type NotificationRealtimeEvent = {
  event_id: string;
  event_type: NotificationRealtimeEventType;
  occurred_at: string;
  tenant_id: string;
  aggregate_id: string;
  version: number;
  data: { notification_id: string | null; unread_count: number; action_state?: string };
};

export function buildNotificationRealtimeEvent(input: {
  eventType: NotificationRealtimeEventType;
  tenantId: string;
  userId: string;
  notificationId: string | null;
  unreadCount: number;
  actionState?: string;
}): NotificationRealtimeEvent {
  return {
    event_id: randomUUID(),
    event_type: input.eventType,
    occurred_at: new Date().toISOString(),
    tenant_id: input.tenantId,
    aggregate_id: input.userId,
    version: Date.now(),
    data: {
      notification_id: input.notificationId,
      unread_count: input.unreadCount,
      ...(input.actionState ? { action_state: input.actionState } : {}),
    },
  };
}
