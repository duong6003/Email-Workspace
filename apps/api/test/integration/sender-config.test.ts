import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { SenderConfigEntity } from '../../src/database/entities/sender-config.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testAppDatabaseUrl, testDatabaseUrl } from './test-database-url.js';

describe('M5-S1 sender config persistence and RLS', () => {
  let owner: DataSource; let app: DataSource; let tenantA: TenantEntity; let tenantB: TenantEntity;
  beforeAll(async () => { owner = createDataSource(testDatabaseUrl()); app = createDataSource(testAppDatabaseUrl()); await owner.initialize(); await app.initialize(); tenantA = await owner.getRepository(TenantEntity).save({ name: `sender-a-${randomUUID()}` }); tenantB = await owner.getRepository(TenantEntity).save({ name: `sender-b-${randomUUID()}` }); });
  afterAll(async () => { if (owner?.isInitialized) { await owner.query('DELETE FROM sender_config WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]); await owner.query('DELETE FROM sending_policy WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]); await owner.getRepository(TenantEntity).delete([tenantA.id, tenantB.id]); } await app?.destroy(); await owner?.destroy(); });
  it('grants app role and isolates sender rows by tenant', async () => {
    const [row] = await owner.query(`INSERT INTO sender_config (tenant_id, name, from_email, host, secret_ref) VALUES ($1, 'A', 'a@example.test', 'mailpit', 'EOW_SENDER_SECRET_TEST') RETURNING id`, [tenantA.id]);
    const visible = await app.transaction(async (manager) => { await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.id]); return manager.getRepository(SenderConfigEntity).find(); });
    expect(visible.map((item) => item.id)).toContain(row.id);
    await expect(app.transaction(async (manager) => { await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB.id]); return manager.getRepository(SenderConfigEntity).find(); })).resolves.toEqual([]);
  });
});
