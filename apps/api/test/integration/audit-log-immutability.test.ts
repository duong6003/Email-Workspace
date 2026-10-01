import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { AuditLogEntity } from '../../src/database/entities/audit-log.entity.js';
import { testDatabaseUrl } from './test-database-url.js';

/**
 * database/migrations/005_audit_log_immutability.sql (M1-S3 / BR-SEC-002:
 * "Ghi immutable audit ..."). A trigger, not an application-layer check, is
 * the only thing that can actually guarantee no code path -- present or
 * future, this app or a stray psql session -- can silently tamper with an
 * audit_log row.
 */
describe('audit_log immutability trigger (integration, real PostgreSQL)', () => {
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let row: AuditLogEntity;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `audit-immutability-tenant-${randomUUID()}` });
    row = await dataSource.getRepository(AuditLogEntity).save({
      tenantId: tenant.id,
      actorId: null,
      action: 'test.immutability_probe',
      entityType: 'probe',
      entityId: null,
      traceId: randomUUID(),
      metadata: {},
      occurredAt: new Date(),
    });
  });

  afterAll(async () => {
    // Deliberately does not delete `row` or `tenant` -- that is the point of
    // this test. Left behind like every other audit fixture (see
    // auth-service.test.ts's afterAll comment).
    await dataSource.destroy();
  });

  it('rejects an UPDATE against an existing row', async () => {
    await expect(dataSource.query('UPDATE audit_log SET action = $1 WHERE id = $2', ['tampered', row.id])).rejects.toThrow(/immutable/i);
  });

  it('rejects a DELETE against an existing row', async () => {
    await expect(dataSource.query('DELETE FROM audit_log WHERE id = $1', [row.id])).rejects.toThrow(/immutable/i);
  });

  it('still allows a fresh INSERT (the trigger only guards UPDATE/DELETE)', async () => {
    const inserted = await dataSource.getRepository(AuditLogEntity).save({
      tenantId: tenant.id,
      actorId: null,
      action: 'test.immutability_probe_insert',
      entityType: 'probe',
      entityId: null,
      traceId: randomUUID(),
      metadata: {},
      occurredAt: new Date(),
    });
    expect(inserted.id).toBeDefined();
  });
});
