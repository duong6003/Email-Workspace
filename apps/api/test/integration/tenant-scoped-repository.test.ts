import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantScopedRepository } from '../../src/database/tenant-scoped.repository.js';
import { testDatabaseUrl } from './test-database-url.js';

describe('TenantScopedRepository', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `test-tenant-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `test-tenant-b-${randomUUID()}` });
  });

  afterAll(async () => {
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(TenantEntity).delete(tenantA.id);
    await dataSource.getRepository(TenantEntity).delete(tenantB.id);
    await dataSource.destroy();
  });

  it('does not return another tenant\'s row by id', async () => {
    const users = dataSource.getRepository(AppUserEntity);
    const victim = await users.save({
      tenantId: tenantA.id,
      email: 'victim@tenant-a.test',
      displayName: 'Victim',
      role: 'operator',
    });

    const asTenantB = new TenantScopedRepository(users, tenantB.id);
    const result = await asTenantB.findOne({ id: victim.id } as never);

    expect(result).toBeNull();
  });

  it('returns the row when scoped to the owning tenant', async () => {
    const users = dataSource.getRepository(AppUserEntity);
    const owned = await users.save({
      tenantId: tenantA.id,
      email: 'owner@tenant-a.test',
      displayName: 'Owner',
      role: 'operator',
    });

    const asTenantA = new TenantScopedRepository(users, tenantA.id);
    const result = await asTenantA.findOne({ id: owned.id } as never);

    expect(result?.id).toBe(owned.id);
  });

  it('stamps the scoped tenantId on save even if the caller passes a different one', async () => {
    const users = dataSource.getRepository(AppUserEntity);
    const asTenantA = new TenantScopedRepository(users, tenantA.id);

    const saved = await asTenantA.save({
      tenantId: tenantB.id, // attempted cross-tenant write
      email: 'attempted-cross-tenant@test',
      displayName: 'Attempted',
      role: 'operator',
    } as never);

    expect(saved.tenantId).toBe(tenantA.id);
  });

  it('does not leak another tenant\'s row into a scoped find()', async () => {
    const users = dataSource.getRepository(AppUserEntity);
    await users.save({
      tenantId: tenantB.id,
      email: 'other-tenant-only@test',
      displayName: 'Other',
      role: 'operator',
    });

    const asTenantA = new TenantScopedRepository(users, tenantA.id);
    const rows = await asTenantA.find();

    expect(rows.every((row) => row.tenantId === tenantA.id)).toBe(true);
  });
});
