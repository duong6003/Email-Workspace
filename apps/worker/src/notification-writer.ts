import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runInTenantTransaction } from './tenant-database.js';
import { jobMetrics } from './observability/job-metrics.js';

const DEFAULT_NOTIFICATION_RETENTION_DAYS = 90;
function notificationExpiresAt(now: Date, configuredDays: string | undefined): Date {
  const days = configuredDays === undefined || configuredDays === '' ? DEFAULT_NOTIFICATION_RETENTION_DAYS : Number(configuredDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('NOTIFICATION_RETENTION_DAYS must be an integer between 1 and 3650.');
  const expiresAt = new Date(now);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + days);
  return expiresAt;
}

type JobNotification = {
  tenantId: string;
  sourceEventId: string;
  type: string;
  severity: 'success' | 'critical';
  title: string;
  body: string;
  category: string;
  messageKey: string;
  params: Record<string, unknown>;
  deepLinkRoute: string;
  entityType: 'import_job' | 'bulk_job' | 'campaign';
  entityId: string;
};
export type NotificationEventPublisher = (event: Record<string, unknown>) => Promise<void>;

/** Persist first, then let the realtime layer/API reconcile. Notification failure is isolated from job completion. */
export async function writeJobNotification(pool: pg.Pool, notification: JobNotification, publish?: NotificationEventPublisher): Promise<void> {
  try {
    const persisted = await runInTenantTransaction(pool, notification.tenantId, async (client) => {
      await client.query(
        `DELETE FROM user_notification un
         USING notification n
         WHERE un.tenant_id = $1 AND n.tenant_id = $1
           AND un.notification_id = n.id AND n.expires_at <= now()`,
        [notification.tenantId],
      );
      await client.query(`DELETE FROM notification WHERE tenant_id = $1 AND expires_at <= now()`, [notification.tenantId]);
      const users = await client.query<{ id: string }>(
        `SELECT DISTINCT u.id::text AS id
         FROM app_user u
         JOIN user_role ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
         JOIN role_permission rp ON rp.role_id = ur.role_id
         JOIN permission p ON p.id = rp.permission_id AND p.key = 'notification:read'
         LEFT JOIN notification_preference np ON np.tenant_id = u.tenant_id AND np.user_id = u.id AND np.category = $2
         WHERE u.tenant_id = $1 AND u.status = 'active' AND (np.enabled IS DISTINCT FROM false OR $2 = 'critical_delivery_failure')`,
        [notification.tenantId, notification.category],
      );
      if (users.rows.length === 0) return { notificationId: null, recipients: [] };
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO notification (tenant_id, source_event_id, type, severity, title, body, message_key, params_json, deep_link_route, entity_type, entity_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
         ON CONFLICT (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [notification.tenantId, notification.sourceEventId, notification.type, notification.severity, notification.title, notification.body, notification.messageKey, JSON.stringify(notification.params), notification.deepLinkRoute, notification.entityType, notification.entityId, notificationExpiresAt(new Date(), process.env.NOTIFICATION_RETENTION_DAYS)],
      );
      const notificationId = inserted.rows[0]?.id;
      if (!notificationId) return { notificationId: null, recipients: [] };
      jobMetrics.notificationCreated();
      jobMetrics.notificationDelivered('stored');
      for (const user of users.rows) {
        await client.query(
          `INSERT INTO user_notification (tenant_id, notification_id, user_id) VALUES ($1,$2,$3) ON CONFLICT (notification_id,user_id) DO NOTHING`,
          [notification.tenantId, notificationId, user.id],
        );
      }
      const recipients = await Promise.all(users.rows.map(async (user) => ({
        userId: user.id,
        unreadCount: Number((await client.query<{ count: string }>('SELECT count(*)::text AS count FROM user_notification WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL', [notification.tenantId, user.id])).rows[0].count),
      })));
      return { notificationId, recipients };
    });
    if (publish && persisted.notificationId) {
      await Promise.all(persisted.recipients.map((recipient) => publish({
        event_id: randomUUID(),
        event_type: 'notification.created',
        occurred_at: new Date().toISOString(),
        tenant_id: notification.tenantId,
        aggregate_id: recipient.userId,
        version: Date.now(),
        data: { notification_id: persisted.notificationId, unread_count: recipient.unreadCount },
      })));
      jobMetrics.notificationDelivered('socket');
    }
  } catch {
    // Notification delivery is auxiliary; the committed job remains authoritative.
  }
}
