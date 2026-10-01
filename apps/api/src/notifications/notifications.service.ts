import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { UserNotificationEntity } from '../database/entities/user-notification.entity.js';
import { NotificationsRepository } from './notifications.repository.js';
import type { NotificationListQueryDto, UpdateActionStateDto, UpdatePreferenceDto } from './dto/notification.dto.js';
import { isCategoryMuteable } from './notification-rules.js';
import { notificationMetric } from './notification-metrics.js';
import { metrics } from '../observability/metrics-registry.js';
import { buildNotificationRealtimeEvent, type NotificationRealtimeEventType } from '../realtime/notification-event.js';
import { RedisUserPublisher } from '../realtime/redis-user-publisher.js';

const DEFAULT_NOTIFICATION_RETENTION_DAYS = 90;
function notificationExpiresAt(now: Date, configuredDays: string | undefined): Date {
  const days = configuredDays === undefined || configuredDays === '' ? DEFAULT_NOTIFICATION_RETENTION_DAYS : Number(configuredDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('NOTIFICATION_RETENTION_DAYS must be an integer between 1 and 3650.');
  const expiresAt = new Date(now);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + days);
  return expiresAt;
}

export type NotificationDeepLink =
  | { state: 'available'; route: string }
  | { state: 'unavailable'; reason: 'not_actionable' | 'permission_revoked' | 'target_deleted' | 'unsupported_target' };

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly realtime: RedisUserPublisher) {}
  async list(tenantId: string, userId: string, query: NotificationListQueryDto) {
    await this.purgeExpired(tenantId);
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new NotificationsRepository(manager, tenantId);
      let items: Array<Record<string, any>>;
      try { items = await repository.listForUser(userId, query.unread, query.limit, query.cursor); }
      catch (error) { if (error instanceof Error && error.message === 'Invalid notification cursor.') throw new BadRequestException(error.message); throw error; }
      const { count } = await repository.unreadCount(userId);
      const mapped = items.map((item) => { const raw = item as unknown as Record<string, any>; return { id: raw.id, type: raw.type, severity: raw.severity, title: raw.title, body: raw.body, readAt: raw.readat ?? null, actionState: raw.actionstate, messageKey: raw.messagekey, params: raw.paramsjson ?? {}, deepLinkRoute: raw.deeplinkroute ?? null, entityId: raw.entityid ?? null, createdAt: raw.createdat }; });
      const last = mapped.at(-1);
      const nextCursor = mapped.length === query.limit && last ? Buffer.from(`${new Date(last.createdAt).toISOString()}|${last.id}`).toString('base64url') : null;
      return { items: mapped, unread: Number(count), nextCursor };
    });
  }
  async createForUsers(tenantId: string, input: { sourceEventId: string; type: string; severity: 'info'|'success'|'warning'|'critical'; title: string; body: string; category: string; userIds: string[]; messageKey?: string; params?: Record<string, unknown>; deepLinkRoute?: string | null; entityType?: 'import_job' | 'bulk_job' | 'campaign' | null; entityId?: string | null; groupKey?: string | null; batchWindowSeconds?: number; }): Promise<string | null> {
    await this.purgeExpired(tenantId);
    const result = await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const recipients = await manager.query(
        `SELECT u.id::text AS id
         FROM app_user u
         LEFT JOIN notification_preference p ON p.tenant_id = u.tenant_id AND p.user_id = u.id AND p.category = $2
         WHERE u.tenant_id = $1 AND u.id = ANY($3::uuid[]) AND u.status = 'active'
           AND (p.enabled IS DISTINCT FROM false OR $2 IN ('security','permission','critical_delivery_failure'))`,
        [tenantId, input.category, [...new Set(input.userIds)]],
      );
      const recipientRows = recipients as Array<{ id: string }>;
      if (recipientRows.length === 0) return { notificationId: null, created: false, updated: false, unreadCounts: [] };
      let notificationId: string | undefined;
      let created = false;
      let updated = false;

      // BR-NOT-011: merge into an existing same-type/same-group notification created
      // within its batch window instead of inserting a new row. `mergedEventIds`
      // keeps every joining source event's dedup key on the shared row, since the
      // (tenant_id, source_event_id) unique index can only hold the first one.
      if (input.groupKey) {
        const [group] = await manager.query(
          `SELECT id, params_json, source_event_id FROM notification
           WHERE tenant_id = $1 AND group_key = $2 AND type = $3
             AND created_at > now() - make_interval(secs => $4::double precision)
           ORDER BY created_at DESC LIMIT 1`,
          [tenantId, input.groupKey, input.type, input.batchWindowSeconds ?? 300],
        );
        if (group) {
          const params = (group.params_json ?? {}) as Record<string, unknown>;
          const mergedEventIds = Array.isArray(params.mergedEventIds) ? (params.mergedEventIds as string[]) : [group.source_event_id].filter(Boolean);
          if (mergedEventIds.includes(input.sourceEventId)) {
            notificationId = group.id as string;
          } else {
            const nextParams = { ...params, ...(input.params ?? {}), count: mergedEventIds.length + 1, mergedEventIds: [...mergedEventIds, input.sourceEventId] };
            await manager.query(`UPDATE notification SET params_json = $2::jsonb WHERE id = $1`, [group.id, JSON.stringify(nextParams)]);
            notificationId = group.id as string;
            updated = true;
          }
        }
      }

      if (!notificationId) {
        const result = await manager.query(
          `INSERT INTO notification (tenant_id, source_event_id, type, severity, title, body, message_key, params_json, deep_link_route, entity_type, entity_id, group_key, batch_window_seconds, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [tenantId, input.sourceEventId, input.type, input.severity, input.title, input.body, input.messageKey ?? 'notification.generic', JSON.stringify(input.params ?? {}), input.deepLinkRoute ?? null, input.entityType ?? null, input.entityId ?? null, input.groupKey ?? null, input.batchWindowSeconds ?? 300, notificationExpiresAt(new Date(), process.env.NOTIFICATION_RETENTION_DAYS)],
        );
        notificationId = result[0]?.id as string | undefined;
        if (notificationId) created = true;
        if (!notificationId) {
          const existing = await manager.query(`SELECT id FROM notification WHERE tenant_id = $1 AND source_event_id = $2`, [tenantId, input.sourceEventId]);
          notificationId = existing[0]?.id as string | undefined;
        }
      }
      if (!notificationId) return { notificationId: null, created: false, updated: false, unreadCounts: [] };
      for (const userId of recipientRows.map((recipient) => recipient.id)) {
        await manager.query(`INSERT INTO user_notification (tenant_id, notification_id, user_id)
          SELECT $1, $2, id FROM app_user WHERE id = $3 AND tenant_id = $1
          ON CONFLICT (notification_id,user_id) DO NOTHING`, [tenantId, notificationId, userId]);
      }
      if (created) {
        this.logger.log(notificationMetric({ notificationId, eventId: input.sourceEventId, action: 'created' }));
        metrics.notificationCreated();
        metrics.notificationDelivered('stored');
      }
      const unreadCounts = await Promise.all(recipientRows.map(async (recipient) => ({
        userId: recipient.id,
        unreadCount: Number((await new NotificationsRepository(manager, tenantId).unreadCount(recipient.id)).count),
      })));
      return { notificationId, created, updated, unreadCounts };
    });
    if (result.notificationId && (result.created || result.updated)) {
      await this.publishHints(result.created ? 'notification.created' : 'notification.updated', tenantId, result.notificationId, result.unreadCounts);
    }
    return result.notificationId;
  }
  async markRead(tenantId: string, userId: string, id: string) {
    await this.mutateUserNotification(tenantId, userId, id, { readAt: new Date() });
    this.logger.log(notificationMetric({ notificationId: id, eventId: null, action: 'read' }));
    metrics.notificationRead();
    await this.publishCurrentUnread('notification.read', tenantId, userId, id);
  }
  async markAllRead(tenantId: string, userId: string) {
    const affected = await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const result = await manager.createQueryBuilder().update(UserNotificationEntity).set({ readAt: new Date() }).where('tenant_id = :tenantId AND user_id = :userId AND read_at IS NULL', { tenantId, userId }).execute();
      return result.affected ?? 0;
    });
    if (affected > 0) metrics.notificationRead(affected);
    await this.publishHint('notification.read', tenantId, userId, null, 0);
  }
  async updateActionState(tenantId: string, userId: string, id: string, body: UpdateActionStateDto) {
    await this.mutateUserNotification(tenantId, userId, id, { actionState: body.actionState });
    const unreadCount = await this.currentUnread(tenantId, userId);
    await this.publishHint('notification.updated', tenantId, userId, id, unreadCount, body.actionState);
  }
  async preferences(tenantId: string, userId: string) { return runInTenantContext(this.dataSource, tenantId, async (manager) => manager.query('SELECT category, enabled, muteable FROM notification_preference WHERE tenant_id = $1 AND user_id = $2 ORDER BY category', [tenantId, userId])); }
  async updatePreference(tenantId: string, userId: string, body: UpdatePreferenceDto) { if (!isCategoryMuteable(body.category)) throw new NotFoundException('This category cannot be muted.'); return runInTenantContext(this.dataSource, tenantId, async (manager) => manager.query('INSERT INTO notification_preference (tenant_id,user_id,category,enabled,muteable) VALUES ($1,$2,$3,$4,true) ON CONFLICT (tenant_id,user_id,category) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now() RETURNING category, enabled, muteable', [tenantId, userId, body.category, body.enabled])); }
  async resolveDeepLink(tenantId: string, userId: string, permissions: readonly string[], id: string): Promise<NotificationDeepLink> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const [notification] = await manager.query(
        `SELECT n.entity_type, n.entity_id, n.deep_link_route
         FROM notification n
         INNER JOIN user_notification un ON un.notification_id = n.id AND un.tenant_id = n.tenant_id
         WHERE n.tenant_id = $1 AND n.id = $2 AND un.user_id = $3
           AND (n.expires_at IS NULL OR n.expires_at > now())`,
        [tenantId, id, userId],
      ) as Array<{ entity_type: string | null; entity_id: string | null; deep_link_route: string | null }>;
      if (!notification) throw new NotFoundException('Notification was not found.');
      if (!notification.deep_link_route || !notification.entity_type || !notification.entity_id) return { state: 'unavailable', reason: 'not_actionable' };
      if (!permissions.includes('recipient:read')) return { state: 'unavailable', reason: 'permission_revoked' };
      const targetTable = notification.entity_type === 'import_job' ? 'import_job' : notification.entity_type === 'bulk_job' ? 'bulk_job' : null;
      if (!targetTable) return { state: 'unavailable', reason: 'unsupported_target' };
      const [target] = await manager.query(`SELECT id FROM ${targetTable} WHERE tenant_id = $1 AND id = $2`, [tenantId, notification.entity_id]);
      if (!target) return { state: 'unavailable', reason: 'target_deleted' };
      return { state: 'available', route: notification.deep_link_route };
    });
  }
  async purgeExpired(tenantId: string, now = new Date()): Promise<number> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await manager.query(
        `DELETE FROM user_notification un
         USING notification n
         WHERE un.tenant_id = $1 AND n.tenant_id = $1
           AND un.notification_id = n.id AND n.expires_at <= $2`,
        [tenantId, now],
      );
      const [rows] = (await manager.query(
        `DELETE FROM notification WHERE tenant_id = $1 AND expires_at <= $2 RETURNING id`,
        [tenantId, now],
      )) as [Array<{ id: string }>, number];
      return rows.length;
    });
  }
  private async mutateUserNotification(tenantId: string, userId: string, id: string, values: Partial<UserNotificationEntity>) { return runInTenantContext(this.dataSource, tenantId, async (manager) => { const updated = await new NotificationsRepository(manager, tenantId).updateForUser(userId, id, values); if (!updated) throw new NotFoundException('Notification was not found.'); }); }
  private async currentUnread(tenantId: string, userId: string): Promise<number> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => Number((await new NotificationsRepository(manager, tenantId).unreadCount(userId)).count));
  }
  private async publishCurrentUnread(eventType: NotificationRealtimeEventType, tenantId: string, userId: string, notificationId: string | null): Promise<void> {
    await this.publishHint(eventType, tenantId, userId, notificationId, await this.currentUnread(tenantId, userId));
  }
  private async publishHints(eventType: NotificationRealtimeEventType, tenantId: string, notificationId: string, recipients: Array<{ userId: string; unreadCount: number }>): Promise<void> {
    await Promise.all(recipients.map((recipient) => this.publishHint(eventType, tenantId, recipient.userId, notificationId, recipient.unreadCount)));
  }
  private async publishHint(eventType: NotificationRealtimeEventType, tenantId: string, userId: string, notificationId: string | null, unreadCount: number, actionState?: string): Promise<void> {
    try {
      await this.realtime.publish(buildNotificationRealtimeEvent({ eventType, tenantId, userId, notificationId, unreadCount, actionState }));
      metrics.notificationDelivered('socket');
    } catch {
      this.logger.warn(notificationMetric({ notificationId: notificationId ?? 'all', eventId: null, action: 'channel_attempt' }));
    }
  }
}
