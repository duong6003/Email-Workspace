import { parseErrorResponse } from './problem.js';
const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';
export type Notification = { id: string; type: string; severity: 'info'|'success'|'warning'|'critical'; title: string; body: string; readAt: string|null; actionState: 'open'|'resolved'|'expired'; messageKey: string; params: Record<string, unknown>; deepLinkRoute: string|null; entityId: string|null; createdAt: string };
export type NotificationDeepLink = { state: 'available'; route: string } | { state: 'unavailable'; reason: 'not_actionable'|'permission_revoked'|'target_deleted'|'unsupported_target' };
export type NotificationRealtimeEvent = { event_type: 'notification.created'|'notification.updated'|'notification.read'; data: { notification_id: string|null; unread_count: number; action_state?: string } };
export type NotificationRealtimePatch = { notificationId: string; actionState: Notification['actionState'] | null };
export function notificationUnreadCount(event: unknown): number | null {
  if (!event || typeof event !== 'object') return null;
  const envelope = event as { event_type?: unknown; data?: { unread_count?: unknown } };
  if (!['notification.created', 'notification.updated', 'notification.read'].includes(String(envelope.event_type))) return null;
  const count = envelope.data?.unread_count;
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
}
export function notificationRealtimePatch(event: unknown): NotificationRealtimePatch | null {
  if (!event || typeof event !== 'object') return null;
  const envelope = event as { event_type?: unknown; data?: { notification_id?: unknown; action_state?: unknown } };
  if (!['notification.created', 'notification.updated', 'notification.read'].includes(String(envelope.event_type))) return null;
  const notificationId = envelope.data?.notification_id;
  if (typeof notificationId !== 'string' || !notificationId) return null;
  const actionState = envelope.data?.action_state;
  return {
    notificationId,
    actionState: actionState === 'open' || actionState === 'resolved' || actionState === 'expired' ? actionState : null,
  };
}
function csrfHeaders(): Record<string,string> { const token = document.cookie.split('; ').find((row) => row.startsWith('eow_csrf='))?.split('=')[1]; return { 'content-type': 'application/json', ...(token ? {'x-csrf-token': token} : {}) }; }
async function request<T>(path: string, init?: RequestInit): Promise<T> { const response = await fetch(`${base}${path}`, { credentials: 'include', ...init }); if (!response.ok) await parseErrorResponse(response); return response.status === 204 ? undefined as T : response.json() as Promise<T>; }
export function listNotifications(unread = false): Promise<{items: Notification[]; unread: number; nextCursor: string|null}> { return request(`/notifications?unread=${unread}&limit=50`); }
export function markNotificationRead(id: string): Promise<void> { return request(`/notifications/${id}/read`, { method: 'PUT', headers: csrfHeaders() }); }
export function markAllNotificationsRead(): Promise<void> { return request('/notifications/read-all', { method: 'PUT', headers: csrfHeaders() }); }
export function resolveNotificationDeepLink(id: string): Promise<NotificationDeepLink> { return request(`/notifications/${id}/deep-link`); }
export function updateNotificationActionState(id: string, actionState: Notification['actionState']): Promise<void> { return request(`/notifications/${id}/action-state`, { method: 'PATCH', headers: csrfHeaders(), body: JSON.stringify({ actionState }) }); }
