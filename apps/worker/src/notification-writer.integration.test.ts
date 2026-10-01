import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { writeJobNotification } from './notification-writer.js';
import { testOwnerDatabaseUrl } from './test-urls.js';

/**
 * BR-NOT-002: recipients are resolved automatically by role/status/preference,
 * not sender-picked. apps/api/test/integration/notifications.test.ts only
 * exercises NotificationsService.createForUsers, which takes recipients as an
 * explicit input array -- it never calls writeJobNotification, so the role/
 * status/preference JOIN this function actually runs was previously untested.
 */
describe('writeJobNotification recipient resolution (021_notification_center.sql, 004_rbac.sql)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let viewerRoleId: string;
  let noRoleUserId: string;
  let activeViewerUserId: string;
  let inactiveViewerUserId: string;
  let mutedViewerUserId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`writer-recipients-${randomUUID()}`])).rows[0].id;
    viewerRoleId = (await pool.query<{ id: string }>(`SELECT id FROM role WHERE key = 'viewer'`)).rows[0].id;

    const users = await pool.query<{ id: string }>(
      `INSERT INTO app_user (tenant_id, email, display_name, role, status) VALUES
         ($1, $2, 'No role', 'viewer', 'active'),
         ($1, $3, 'Active viewer', 'viewer', 'active'),
         ($1, $4, 'Inactive viewer', 'viewer', 'invited'),
         ($1, $5, 'Muted viewer', 'viewer', 'active')
       RETURNING id`,
      [tenantId, `no-role-${randomUUID()}@example.test`, `active-${randomUUID()}@example.test`, `inactive-${randomUUID()}@example.test`, `muted-${randomUUID()}@example.test`],
    );
    [noRoleUserId, activeViewerUserId, inactiveViewerUserId, mutedViewerUserId] = users.rows.map((row) => row.id);

    // Only 3 of the 4 users get the role that grants notification:read -- noRoleUserId is deliberately left unassigned.
    await pool.query(
      `INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3), ($1, $4, $3), ($1, $5, $3)`,
      [tenantId, activeViewerUserId, viewerRoleId, inactiveViewerUserId, mutedViewerUserId],
    );
    await pool.query(
      `INSERT INTO notification_preference (tenant_id, user_id, category, enabled, muteable) VALUES ($1, $2, 'import', false, true)`,
      [tenantId, mutedViewerUserId],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM user_notification WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM notification WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM notification_preference WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM user_role WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM app_user WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  it('notifies only the active, role-permitted, non-muted user -- excludes no-role, inactive and muted users', async () => {
    const sourceEventId = `import.completed:${randomUUID()}`;
    const published: Record<string, unknown>[] = [];
    await writeJobNotification(pool, {
      tenantId, sourceEventId, type: 'import_completed', severity: 'success', title: 'Import xong', body: 'Da xu ly',
      category: 'import', messageKey: 'import.completed', params: {}, deepLinkRoute: '/recipients', entityType: 'import_job', entityId: randomUUID(),
    }, async (event) => { published.push(event); });
    const notificationId = (await pool.query<{ id: string }>('SELECT id FROM notification WHERE tenant_id = $1 AND source_event_id = $2', [tenantId, sourceEventId])).rows[0].id;
    const recipientIds = (await pool.query<{ user_id: string }>('SELECT user_id FROM user_notification WHERE notification_id = $1', [notificationId])).rows.map((row) => row.user_id);
    expect(recipientIds).toEqual([activeViewerUserId]);
    expect(recipientIds).not.toContain(noRoleUserId);
    expect(recipientIds).not.toContain(inactiveViewerUserId);
    expect(recipientIds).not.toContain(mutedViewerUserId);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ event_type: 'notification.created', aggregate_id: activeViewerUserId, data: { notification_id: notificationId, unread_count: 1 } });
  });

  it('a category-disabled preference is bypassed for critical_delivery_failure -- the non-muteable override applies at resolution time too', async () => {
    const sourceEventId = `delivery.failed:${randomUUID()}`;
    await writeJobNotification(pool, {
      tenantId, sourceEventId, type: 'critical_delivery_failure', severity: 'critical', title: 'Gui that bai', body: 'Kiem tra lai',
      category: 'critical_delivery_failure', messageKey: 'delivery.failed', params: {}, deepLinkRoute: '/campaigns', entityType: 'import_job', entityId: randomUUID(),
    });
    const notificationId = (await pool.query<{ id: string }>('SELECT id FROM notification WHERE tenant_id = $1 AND source_event_id = $2', [tenantId, sourceEventId])).rows[0].id;
    const recipientIds = (await pool.query<{ user_id: string }>('SELECT user_id FROM user_notification WHERE notification_id = $1', [notificationId])).rows.map((row) => row.user_id);
    expect(recipientIds).toEqual(expect.arrayContaining([activeViewerUserId, mutedViewerUserId]));
  });

  it('swallows a failure inside the transaction instead of throwing, so the caller job can still commit', async () => {
    await expect(writeJobNotification(pool, {
      tenantId: 'not-a-uuid', sourceEventId: `broken:${randomUUID()}`, type: 'import_completed', severity: 'success',
      title: 'x', body: 'y', category: 'import', messageKey: 'import.completed', params: {}, deepLinkRoute: '/recipients', entityType: 'import_job', entityId: randomUUID(),
    })).resolves.toBeUndefined();
  });
});
