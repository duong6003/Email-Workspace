import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { NotificationPreferenceEntity } from '../../src/database/entities/notification-preference.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testAppDatabaseUrl, testDatabaseUrl } from './test-database-url.js';

/**
 * M6-S2 CP1 required an eow_app-connected test for the new notification_preference
 * table, named after M3-S3 shipping a migration with zero grants that an
 * owner-connected test could not see (owner bypasses RLS and ignores GRANT).
 * The service-level notifications.test.ts intentionally connects as owner, so
 * this is the only coverage that exercises the real runtime role.
 */
describe('notification_preference RLS + eow_app grant (021_notification_center.sql)', () => {
  let owner: DataSource;
  let app: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;
  let userA: AppUserEntity;

  beforeAll(async () => {
    owner = createDataSource(testDatabaseUrl());
    app = createDataSource(testAppDatabaseUrl());
    await owner.initialize();
    await app.initialize();
    const tenants = owner.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `notif-pref-rls-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `notif-pref-rls-b-${randomUUID()}` });
    userA = await owner.getRepository(AppUserEntity).save({ tenantId: tenantA.id, email: `notif-pref-rls-${randomUUID()}@example.test`, displayName: 'A', role: 'viewer' });
  });

  afterAll(async () => {
    await owner.getRepository(NotificationPreferenceEntity).delete({ tenantId: tenantA.id });
    await owner.getRepository(NotificationPreferenceEntity).delete({ tenantId: tenantB.id });
    await owner.getRepository(AppUserEntity).delete(userA.id);
    await owner.getRepository(TenantEntity).delete([tenantA.id, tenantB.id]);
    await app.destroy();
    await owner.destroy();
  });

  it('eow_app can insert and read its own tenant rows (proves the GRANT is real, not just present in the migration file)', async () => {
    const userId = userA.id;
    await app.transaction(async (manager) => {
      await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.id]);
      await manager.getRepository(NotificationPreferenceEntity).save({ tenantId: tenantA.id, userId, category: 'import', enabled: false, muteable: true });
    });
    const rows = await owner.getRepository(NotificationPreferenceEntity).findBy({ tenantId: tenantA.id, userId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enabled: false });
  });

  it('refuses a cross-tenant insert through WITH CHECK', async () => {
    await expect(
      app.transaction(async (manager) => {
        await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.id]);
        await manager.getRepository(NotificationPreferenceEntity).save({ tenantId: tenantB.id, userId: userA.id, category: 'import', enabled: false, muteable: true });
      }),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('fails closed when no tenant context is set', async () => {
    await expect(app.getRepository(NotificationPreferenceEntity).find()).resolves.toEqual([]);
  });
});
