import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { In } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

/**
 * M6-S4 CP3 (BR-HIS-006, A9/A10/A11/A12): GET/PUT /retention-policy --
 * default read for a tenant with no policy row, admin-only write behind
 * settings:manage, audit on write, and RLS-scoped tenant isolation.
 */
describe('Retention policy HTTP (M6-S4 CP3)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let otherTenant: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const adminEmail = `retention-admin-${randomUUID()}@test.dev`;
  const operatorEmail = `retention-operator-${randomUUID()}@test.dev`;
  const viewerEmail = `retention-viewer-${randomUUID()}@test.dev`;
  const otherAdminEmail = `retention-other-admin-${randomUUID()}@test.dev`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());

    tenant = await dataSource.getRepository(TenantEntity).save({ name: `retention-http-${randomUUID()}` });
    otherTenant = await dataSource.getRepository(TenantEntity).save({ name: `retention-http-other-${randomUUID()}` });

    const passwordHash = await hashPassword(password);
    await dataSource.getRepository(AppUserEntity).save([
      { tenantId: tenant.id, email: adminEmail, displayName: 'Retention Admin', role: 'admin', passwordHash, status: 'active' },
      { tenantId: tenant.id, email: operatorEmail, displayName: 'Retention Operator', role: 'operator', passwordHash, status: 'active' },
      { tenantId: tenant.id, email: viewerEmail, displayName: 'Retention Viewer', role: 'viewer', passwordHash, status: 'active' },
      { tenantId: otherTenant.id, email: otherAdminEmail, displayName: 'Other Tenant Admin', role: 'admin', passwordHash, status: 'active' },
    ]);
  });

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.query('DELETE FROM retention_policy WHERE tenant_id = ANY($1::uuid[])', [[tenant.id, otherTenant.id]]);
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: In([tenant.id, otherTenant.id]) });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: In([tenant.id, otherTenant.id]) });
    // Tenant and audit_log rows are left in place: login() writes an
    // audit_log row and audit_log is immutable (BR-SEC-002, no DELETE ever),
    // so a probe tenant with a login audit trail can never be fully deleted
    // -- expected and harmless, matching realtime-campaign.test.ts's own
    // established norm for every login-exercising integration test.
    await app.close();
  });

  async function login(email: string): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return {
      cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
  }

  it('A9: returns the env default for a tenant with no policy row', async () => {
    const admin = await login(adminEmail);
    const response = await request(app.getHttpServer())
      .get('/api/v1/retention-policy')
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(response.body).toEqual({ messageEventRetentionDays: 365, source: 'default' });
  });

  it('A9/A11: stores an admin update and audits it', async () => {
    const admin = await login(adminEmail);
    const response = await request(app.getHttpServer())
      .put('/api/v1/retention-policy')
      .set('Cookie', admin.cookie).set('x-csrf-token', admin.csrfToken)
      .send({ messageEventRetentionDays: 90 })
      .expect(200);
    expect(response.body).toEqual({ messageEventRetentionDays: 90, source: 'policy' });

    const audit = await dataSource.query(
      `SELECT action, metadata FROM audit_log WHERE tenant_id = $1 AND action = 'retention_policy.updated' ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.id],
    );
    expect(audit[0].metadata.messageEventRetentionDays).toBe(90);
  });

  it('A10: rejects 29 with 400, not a database error', async () => {
    const admin = await login(adminEmail);
    await request(app.getHttpServer())
      .put('/api/v1/retention-policy')
      .set('Cookie', admin.cookie).set('x-csrf-token', admin.csrfToken)
      .send({ messageEventRetentionDays: 29 })
      .expect(400);
  });

  it('A10: denies operator and viewer', async () => {
    const viewer = await login(viewerEmail);
    const operator = await login(operatorEmail);
    await request(app.getHttpServer()).get('/api/v1/retention-policy').set('Cookie', viewer.cookie).expect(403);
    await request(app.getHttpServer())
      .put('/api/v1/retention-policy')
      .set('Cookie', operator.cookie).set('x-csrf-token', operator.csrfToken)
      .send({ messageEventRetentionDays: 120 })
      .expect(403);
  });

  it('A12: another tenant still reads the default', async () => {
    const admin = await login(adminEmail);
    await request(app.getHttpServer())
      .put('/api/v1/retention-policy')
      .set('Cookie', admin.cookie).set('x-csrf-token', admin.csrfToken)
      .send({ messageEventRetentionDays: 200 })
      .expect(200);

    const otherAdmin = await login(otherAdminEmail);
    const response = await request(app.getHttpServer())
      .get('/api/v1/retention-policy')
      .set('Cookie', otherAdmin.cookie)
      .expect(200);
    expect(response.body).toEqual({ messageEventRetentionDays: 365, source: 'default' });
  });
});
