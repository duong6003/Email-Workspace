export type NotificationMetric = { notificationId: string; eventId: string | null; action: 'created' | 'socket_delivered' | 'channel_attempt' | 'read'; recipient?: string };

/** Emits identifiers only; recipient addresses and names are intentionally excluded. */
export function notificationMetric(metric: NotificationMetric): Record<string, string | null> {
  return { notification_id: metric.notificationId, event_id: metric.eventId, action: metric.action };
}
