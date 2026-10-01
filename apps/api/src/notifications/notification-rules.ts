export const NON_MUTEABLE_CATEGORIES = new Set(['security', 'permission', 'critical_delivery_failure']);

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';
export type NotificationMessage = { messageKey: string; params: Record<string, unknown>; fallback: string };

export function renderNotificationMessage(message: NotificationMessage, locale = 'vi-VN'): string {
  // Rendering is deliberately deterministic and locale-ready: the persisted key
  // and structured params remain authoritative, while fallback keeps old clients safe.
  void locale;
  return Object.entries(message.params).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    message.fallback,
  );
}

export function severityPresentation(severity: NotificationSeverity): { icon: string; color: string } {
  return { info: { icon: 'info', color: 'blue' }, success: { icon: 'check', color: 'green' }, warning: { icon: 'warning', color: 'amber' }, critical: { icon: 'critical', color: 'red' } }[severity];
}

export function isCategoryMuteable(category: string): boolean { return !NON_MUTEABLE_CATEGORIES.has(category); }

export function withinBatchWindow(createdAt: Date, now: Date, windowSeconds: number): boolean {
  return now.getTime() - createdAt.getTime() <= windowSeconds * 1000;
}

export type NotificationTrigger = { sourceEvent: string; type: string; severity: NotificationSeverity; category: string; wired: boolean; owner?: string };
export const NOTIFICATION_TRIGGERS: NotificationTrigger[] = [
  { sourceEvent: 'import.completed', type: 'import_completed', severity: 'success', category: 'import', wired: true },
  { sourceEvent: 'import.failed', type: 'import_failed', severity: 'critical', category: 'critical_delivery_failure', wired: true },
  { sourceEvent: 'bulk_update.completed', type: 'bulk_update_completed', severity: 'success', category: 'bulk', wired: true },
  { sourceEvent: 'bulk_update.failed', type: 'bulk_update_failed', severity: 'critical', category: 'critical_delivery_failure', wired: true },
  { sourceEvent: 'campaign.completed', type: 'campaign_completed', severity: 'success', category: 'campaign', wired: false, owner: 'M5' },
  { sourceEvent: 'campaign.failed', type: 'campaign_failed', severity: 'critical', category: 'critical_delivery_failure', wired: false, owner: 'M5' },
  { sourceEvent: 'schedule.dispatch', type: 'schedule_dispatch', severity: 'info', category: 'schedule', wired: false, owner: 'M5' },
  { sourceEvent: 'schedule.miss', type: 'schedule_miss', severity: 'warning', category: 'schedule', wired: false, owner: 'M5' },
  { sourceEvent: 'sender.failed', type: 'sender_failed', severity: 'critical', category: 'critical_delivery_failure', wired: false, owner: 'M5' },
  { sourceEvent: 'quota.threshold_reached', type: 'quota_threshold', severity: 'warning', category: 'quota', wired: true },
  { sourceEvent: 'export.completed', type: 'export_completed', severity: 'success', category: 'export', wired: true },
];
