import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testAppDatabaseUrl, testDatabaseUrl } from './test-database-url.js';

describe('PostgreSQL tenant RLS', () => {
  let owner: DataSource;
  let app: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;

  beforeAll(async () => {
    owner = createDataSource(testDatabaseUrl());
    app = createDataSource(testAppDatabaseUrl());
    await owner.initialize();
    await app.initialize();

    tenantA = await owner.getRepository(TenantEntity).save({ name: `rls-a-${randomUUID()}` });
    tenantB = await owner.getRepository(TenantEntity).save({ name: `rls-b-${randomUUID()}` });
    await owner.getRepository(RecipientEntity).save([
      { tenantId: tenantA.id, email: `a-${randomUUID()}@rls.test` },
      { tenantId: tenantB.id, email: `b-${randomUUID()}@rls.test` },
    ]);
  });

  afterAll(async () => {
    await owner.getRepository(RecipientEntity).delete({ tenantId: tenantA.id });
    await owner.getRepository(RecipientEntity).delete({ tenantId: tenantB.id });
    await app.destroy();
    await owner.destroy();
  });

  it('filters the exact raw repository bypass pattern to the transaction tenant', async () => {
    const rows = await app.transaction(async (manager) => {
      await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.id]);
      return manager.getRepository(RecipientEntity).find();
    });

    expect(rows.map((row) => row.tenantId)).toEqual([tenantA.id]);
  });

  it('refuses cross-tenant inserts and updates through WITH CHECK', async () => {
    await expect(
      app.transaction(async (manager) => {
        await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.id]);
        await manager.getRepository(RecipientEntity).save({ tenantId: tenantB.id, email: `${randomUUID()}@rls.test` });
      }),
    ).rejects.toThrow(/row-level security policy/i);

    const tenantARecipient = await owner.getRepository(RecipientEntity).findOneByOrFail({ tenantId: tenantA.id });
    await expect(
      app.transaction(async (manager) => {
        await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB.id]);
        await manager.getRepository(RecipientEntity).update(tenantARecipient.id, { tenantId: tenantB.id });
      }),
    ).resolves.toBeUndefined();
    await expect(owner.getRepository(RecipientEntity).findOneByOrFail({ id: tenantARecipient.id })).resolves.toMatchObject({
      tenantId: tenantA.id,
    });
  });

  it('fails closed when no tenant context is set', async () => {
    await expect(app.getRepository(RecipientEntity).find()).resolves.toEqual([]);
  });

  it('documents that the owner role bypasses RLS and must not be used at runtime', async () => {
    const rows = await owner.getRepository(RecipientEntity).findBy([{ tenantId: tenantA.id }, { tenantId: tenantB.id }]);
    expect(new Set(rows.map((row) => row.tenantId))).toEqual(new Set([tenantA.id, tenantB.id]));
  });

  it('keeps audit immutability active beneath the tenant policy', async () => {
    const [audit] = await owner.query(
      `INSERT INTO audit_log (tenant_id, action, entity_type, trace_id)
       VALUES ($1, 'rls.proof', 'recipient', $2) RETURNING id`,
      [tenantA.id, `rls-${randomUUID()}`],
    );

    await expect(
      app.transaction(async (manager) => {
        await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.id]);
        await manager.query(`UPDATE audit_log SET action = 'changed' WHERE id = $1`, [audit.id]);
      }),
    ).rejects.toThrow(/immutable/i);
  });
});
