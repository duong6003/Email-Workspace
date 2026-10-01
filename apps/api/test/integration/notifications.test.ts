import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { NotificationEntity } from '../../src/database/entities/notification.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { UserNotificationEntity } from '../../src/database/entities/user-notification.entity.js';
import { NotificationsService } from '../../src/notifications/notifications.service.js';
import { testDatabaseUrl } from './test-database-url.js';

describe('Notification center (M6-S2: BR-NOT-001..016)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;
  let userA: AppUserEntity;
  let userA2: AppUserEntity;
  let userB: AppUserEntity;
  let service: NotificationsService;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `notification-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `notification-b-${randomUUID()}` });
    const users = dataSource.getRepository(AppUserEntity);
    userA = await users.save({ tenantId: tenantA.id, email: `notification-a-${randomUUID()}@example.test`, displayName: 'A', role: 'viewer' });
    userA2 = await users.save({ tenantId: tenantA.id, email: `notification-a2-${randomUUID()}@example.test`, displayName: 'A2', role: 'viewer' });
    userB = await users.save({ tenantId: tenantB.id, email: `notification-b-${randomUUID()}@example.test`, displayName: 'B', role: 'viewer' });
    service = new NotificationsService(dataSource, { publish: async () => undefined } as never);
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM notification_preference WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM user_notification WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM notification WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM bulk_job WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM import_job WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.getRepository(AppUserEntity).delete([userA.id, userA2.id, userB.id]);
    await dataSource.getRepository(TenantEntity).delete([tenantA.id, tenantB.id]);
    await dataSource.destroy();
  });

  it('TC-NOT-001/002/006: persists one tenant-scoped notification and deduplicates the same source event', async () => {
    const input = { sourceEventId: `import.completed:${randomUUID()}`, type: 'import_completed', severity: 'success' as const, title: 'Import xong', body: 'Đã xử lý', category: 'import', userIds: [userA.id, userA2.id, userB.id], messageKey: 'import.completed', params: { count: 2 }, deepLinkRoute: '/recipients/imports/example', entityId: randomUUID() };
    const firstId = await service.createForUsers(tenantA.id, input);
    const duplicateId = await service.createForUsers(tenantA.id, input);
    expect(firstId).toEqual(expect.any(String));
    expect(duplicateId).toBe(firstId);
    expect(await dataSource.getRepository(NotificationEntity).count({ where: { tenantId: tenantA.id, sourceEventId: input.sourceEventId } })).toBe(1);
    expect(await dataSource.getRepository(UserNotificationEntity).count({ where: { notificationId: firstId! } })).toBe(2);
    expect(await dataSource.getRepository(UserNotificationEntity).count({ where: { tenantId: tenantB.id } })).toBe(0);
  });

  it('TC-NOT-004/005/012: read, read-all and action state are user-scoped, idempotent and API-authoritative', async () => {
    const notificationId = await service.createForUsers(tenantA.id, { sourceEventId: `bulk.completed:${randomUUID()}`, type: 'bulk_update_completed', severity: 'success', title: 'Bulk xong', body: 'Đã xử lý', category: 'bulk', userIds: [userA.id, userA2.id], messageKey: 'bulk.completed', params: {} });
    expect((await service.list(tenantA.id, userA.id, { unread: true, limit: 50 })).unread).toBeGreaterThanOrEqual(1);
    await service.markRead(tenantA.id, userA.id, notificationId!);
    await service.markRead(tenantA.id, userA.id, notificationId!);
    const persistedRead = await dataSource.query('SELECT notification_id, user_id, read_at FROM user_notification WHERE notification_id = $1 AND user_id = $2', [notificationId, userA.id]);
    expect(persistedRead[0]?.read_at).not.toBeNull();
    const unreadAfterRead = await service.list(tenantA.id, userA.id, { unread: true, limit: 50 });
    expect(unreadAfterRead.items.some((item) => item.id === notificationId)).toBe(false);
    await service.updateActionState(tenantA.id, userA.id, notificationId!, { actionState: 'resolved' });
    const own = await service.list(tenantA.id, userA.id, { limit: 50 });
    expect(own.items.find((item) => item.id === notificationId)?.actionState).toBe('resolved');
    await service.markAllRead(tenantA.id, userA.id);
    await service.markAllRead(tenantA.id, userA.id);
    expect((await service.list(tenantA.id, userA2.id, { unread: true, limit: 50 })).items.some((item) => item.id === notificationId)).toBe(true);
  });

  it('TC-NOT-003/008/010: wrong tenant and muted optional categories cannot receive payloads', async () => {
    const category = `optional-${randomUUID()}`;
    await service.updatePreference(tenantA.id, userA.id, { category, enabled: false });
    const muted = await service.createForUsers(tenantA.id, { sourceEventId: `muted:${randomUUID()}`, type: 'optional', severity: 'info', title: 'Muted', body: 'Hidden', category, userIds: [userA.id], messageKey: 'optional', params: {} });
    expect(muted).toBeNull();
    await expect(service.createForUsers(tenantB.id, { sourceEventId: `foreign:${randomUUID()}`, type: 'foreign', severity: 'info', title: 'Foreign', body: 'Hidden', category: 'import', userIds: [userA.id], messageKey: 'foreign', params: {} })).resolves.toBeNull();
    await expect(service.updatePreference(tenantA.id, userA.id, { category: 'security', enabled: false })).rejects.toMatchObject({ status: 404 });
  });

  it('TC-NOT-011: N similar events inside the batch window collapse into one summary notification, and a repeated event id does not double-count', async () => {
    const groupKey = `bounce-storm-${randomUUID()}`;
    const base = { type: 'recipient_bounced', severity: 'warning' as const, title: 'Nhiều email bị trả lại', body: 'Xem chi tiết', category: 'import', userIds: [userA.id], messageKey: 'recipient.bounced', groupKey, batchWindowSeconds: 300 };
    const firstEvent = `bounce:${randomUUID()}`;
    const secondEvent = `bounce:${randomUUID()}`;
    const firstId = await service.createForUsers(tenantA.id, { ...base, sourceEventId: firstEvent, params: { count: 1 } });
    const secondId = await service.createForUsers(tenantA.id, { ...base, sourceEventId: secondEvent, params: {} });
    const secondRetryId = await service.createForUsers(tenantA.id, { ...base, sourceEventId: secondEvent, params: {} });
    expect(secondId).toBe(firstId);
    expect(secondRetryId).toBe(firstId);
    expect(await dataSource.getRepository(NotificationEntity).count({ where: { tenantId: tenantA.id, groupKey } })).toBe(1);
    const [row] = await dataSource.query('SELECT params_json FROM notification WHERE id = $1', [firstId]);
    expect(row.params_json.count).toBe(2);
    expect(row.params_json.mergedEventIds).toEqual([firstEvent, secondEvent]);
  });

  it('TC-NOT-016: notification creation and read actions emit a metric log with ids but no unmasked recipient PII', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const notificationId = await service.createForUsers(tenantA.id, { sourceEventId: `metric:${randomUUID()}`, type: 'import_completed', severity: 'success', title: 'Import xong', body: 'Đã xử lý', category: 'import', userIds: [userA.id], messageKey: 'import.completed', params: {} });
      await service.markRead(tenantA.id, userA.id, notificationId!);
      const emitted = logSpy.mock.calls.map((call) => call[0]);
      const createdMetric = emitted.find((entry: any) => entry?.action === 'created');
      const readMetric = emitted.find((entry: any) => entry?.action === 'read');
      expect(createdMetric).toMatchObject({ notification_id: notificationId, action: 'created' });
      expect(readMetric).toMatchObject({ notification_id: notificationId, action: 'read' });
      const serialized = JSON.stringify(emitted);
      expect(serialized).not.toContain(userA.email);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('Opening a notification deep link rechecks current permission; payload must not reveal data the user can no longer access.', async () => {
    const [target] = await dataSource.query(
      `INSERT INTO import_job (tenant_id, file_name, total_rows) VALUES ($1, $2, 0) RETURNING id`,
      [tenantA.id, `deep-link-${randomUUID()}.csv`],
    );
    const notificationId = await service.createForUsers(tenantA.id, {
      sourceEventId: `deep-link:${randomUUID()}`, type: 'import_completed', severity: 'success', title: 'Import xong', body: 'Đã xử lý', category: 'import', userIds: [userA.id], messageKey: 'import.completed', params: { jobId: target.id }, deepLinkRoute: '/recipients', entityType: 'import_job', entityId: target.id,
    });
    await expect(service.resolveDeepLink(tenantA.id, userA.id, ['notification:read'], notificationId!)).resolves.toEqual({ state: 'unavailable', reason: 'permission_revoked' });
  });

  it('Each actionable notification has a stable route and resource ID; invalid/deleted targets show a safe explanatory state.', async () => {
    const [target] = await dataSource.query(
      `INSERT INTO bulk_job (tenant_id, action, action_payload, selection_snapshot, resolved_count) VALUES ($1, 'add_tag', '{}'::jsonb, '[]'::jsonb, 0) RETURNING id`,
      [tenantA.id],
    );
    const notificationId = await service.createForUsers(tenantA.id, {
      sourceEventId: `deep-link-deleted:${randomUUID()}`, type: 'bulk_update_completed', severity: 'success', title: 'Bulk xong', body: 'Đã xử lý', category: 'bulk', userIds: [userA.id], messageKey: 'bulk_update.completed', params: { jobId: target.id }, deepLinkRoute: '/recipients', entityType: 'bulk_job', entityId: target.id,
    });
    await expect(service.resolveDeepLink(tenantA.id, userA.id, ['notification:read', 'recipient:read'], notificationId!)).resolves.toEqual({ state: 'available', route: '/recipients' });
    await dataSource.query('DELETE FROM bulk_job WHERE tenant_id = $1 AND id = $2', [tenantA.id, target.id]);
    await expect(service.resolveDeepLink(tenantA.id, userA.id, ['notification:read', 'recipient:read'], notificationId!)).resolves.toEqual({ state: 'unavailable', reason: 'target_deleted' });
  });

  it("purgeExpired returns the exact count of purged notifications, not the raw query result's row count", async () => {
    const countTenant = await dataSource.getRepository(TenantEntity).save({ name: `notification-purge-count-${randomUUID()}` });
    const countUser = await dataSource.getRepository(AppUserEntity).save({ tenantId: countTenant.id, email: `notification-purge-count-${randomUUID()}@example.test`, displayName: 'Purge Count', role: 'viewer' });
    const expiredIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await service.createForUsers(countTenant.id, { sourceEventId: `purge-count-${i}-${randomUUID()}`, type: 'import_completed', severity: 'success', title: `Expired ${i}`, body: 'Đã xử lý', category: 'import', userIds: [countUser.id], messageKey: 'import.completed', params: {} });
      expiredIds.push(id!);
    }
    await dataSource.query('UPDATE notification SET expires_at = now() - interval \'1 second\' WHERE id = ANY($1)', [expiredIds]);

    await expect(service.purgeExpired(countTenant.id)).resolves.toBe(3);
  });

  it('Notification retention and PII minimization are configurable; deletion of notification does not delete audit events.', async () => {
    const retainedTenant = await dataSource.getRepository(TenantEntity).save({ name: `notification-retention-${randomUUID()}` });
    const retainedUser = await dataSource.getRepository(AppUserEntity).save({ tenantId: retainedTenant.id, email: `notification-retention-${randomUUID()}@example.test`, displayName: 'Retention', role: 'viewer' });
    const notificationId = await service.createForUsers(retainedTenant.id, {
      sourceEventId: `retention:${randomUUID()}`, type: 'import_completed', severity: 'success', title: 'Đã hết hạn', body: 'PII tối thiểu', category: 'import', userIds: [retainedUser.id], messageKey: 'import.completed', params: {},
    });
    await dataSource.query('UPDATE notification SET expires_at = now() - interval \'1 second\' WHERE id = $1', [notificationId]);
    await dataSource.query(
      `INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, trace_id, metadata)
       VALUES ($1, 'notification.created', 'notification', $2, $3, '{}'::jsonb)`,
      [retainedTenant.id, notificationId, `retention-${randomUUID()}`],
    );
    await expect(service.purgeExpired(retainedTenant.id)).resolves.toBeGreaterThanOrEqual(1);
    expect(await dataSource.getRepository(NotificationEntity).count({ where: { id: notificationId! } })).toBe(0);
    expect(await dataSource.getRepository(UserNotificationEntity).count({ where: { notificationId: notificationId! } })).toBe(0);
    expect((await dataSource.query('SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND entity_id = $2', [retainedTenant.id, notificationId]))[0].count).toBe(1);
  });
});
