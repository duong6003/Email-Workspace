import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { RoleEntity } from '../../src/database/entities/role.entity.js';
import { UserRoleEntity } from '../../src/database/entities/user-role.entity.js';
import { PermissionsService } from '../../src/auth/permissions.service.js';
import { testDatabaseUrl } from './test-database-url.js';

/**
 * Real-Postgres proof that PermissionsService resolves a user's effective
 * permission set through user_role -> role_permission -> permission, using
 * the role catalogue seeded by database/migrations/004_rbac.sql (M1-S2).
 */
describe('PermissionsService (integration, real PostgreSQL)', () => {
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const service = new PermissionsService();

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `permissions-svc-tenant-${randomUUID()}` });
  });

  afterAll(async () => {
    await dataSource.getRepository(UserRoleEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(TenantEntity).delete(tenant.id);
    await dataSource.destroy();
  });

  it("returns a viewer's permission set: session:manage, campaign:read, notification:read, content:read (and nothing else)", async () => {
    const user = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id,
      email: `viewer-${randomUUID()}@test.dev`,
      displayName: 'Viewer Test',
      role: 'viewer',
    });
    const viewerRole = await dataSource.getRepository(RoleEntity).findOneOrFail({ where: { key: 'viewer' } });
    await dataSource.getRepository(UserRoleEntity).save({ tenantId: tenant.id, userId: user.id, roleId: viewerRole.id });

    const permissions = await service.getPermissionsForUser(dataSource.manager, user.id);

    // content:read joined the viewer in 073_content_read_permission.sql --
    // browse template content, never change it.
    expect(permissions.sort()).toEqual(['campaign:read', 'content:read', 'notification:read', 'session:manage']);
  });

  it("returns an admin's permission set including settings:manage", async () => {
    const user = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id,
      email: `admin-${randomUUID()}@test.dev`,
      displayName: 'Admin Test',
      role: 'admin',
    });
    const adminRole = await dataSource.getRepository(RoleEntity).findOneOrFail({ where: { key: 'admin' } });
    await dataSource.getRepository(UserRoleEntity).save({ tenantId: tenant.id, userId: user.id, roleId: adminRole.id });

    const permissions = await service.getPermissionsForUser(dataSource.manager, user.id);

    expect(permissions).toContain('settings:manage');
    expect(permissions).toContain('campaign:manage');
  });

  it('falls back to the legacy app_user.role text column when a user has no explicit user_role row', async () => {
    // No user-creation API/flow exists yet that also inserts into
    // user_role, so this is the normal state for every user created via
    // AppUserEntity.save() directly (login fixtures, seed script) until an
    // explicit role-assignment step exists.
    const user = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id,
      email: `norole-${randomUUID()}@test.dev`,
      displayName: 'No Explicit Role Row',
      role: 'operator',
    });

    const permissions = await service.getPermissionsForUser(dataSource.manager, user.id);

    expect(permissions.sort()).toEqual([
      'campaign:manage',
      'campaign:read',
      'content:manage',
      'content:read',
      'history:export',
      'notification:read',
      'recipient:manage',
      'recipient:read',
      'session:manage',
    ]);
  });

  it('prefers an explicit user_role row over the legacy app_user.role text when both exist and disagree', async () => {
    const user = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id,
      email: `override-${randomUUID()}@test.dev`,
      displayName: 'Explicit Override',
      role: 'operator', // legacy text says operator
    });
    const viewerRole = await dataSource.getRepository(RoleEntity).findOneOrFail({ where: { key: 'viewer' } });
    await dataSource.getRepository(UserRoleEntity).save({ tenantId: tenant.id, userId: user.id, roleId: viewerRole.id }); // explicit row says viewer

    const permissions = await service.getPermissionsForUser(dataSource.manager, user.id);

    expect(permissions).not.toContain('content:manage');
    expect(permissions).not.toContain('campaign:manage');
    expect(permissions.sort()).toEqual(['campaign:read', 'content:read', 'notification:read', 'session:manage']);
  });
});
