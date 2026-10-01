import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { hashPassword } from '../../src/auth/password.service.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from '../integration/test-database-url.js';
import { testRedisUrl } from '../integration/test-redis-url.js';

const PLANTED_SECRET = `PLANTED-SMTP-SECRET-${randomUUID()}`;

describe('M7-S2 plaintext-secret exposure scan (TC-SEC-001 / TC-CFG-008)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let cookie: string;
  let csrfToken: string;
  let senderId: string;
  const email = `secret-scan-${randomUUID()}@test.dev`;
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'm7-s2-secret-exposure-session'.repeat(2);
    process.env.SENDER_CREDENTIAL_KEY = 'b'.repeat(64);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `secret-scan-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email, displayName: 'Secret Scan Admin', role: 'admin',
      passwordHash: await hashPassword(password), status: 'active',
    });
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(204);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    cookie = cookies.map((entry) => entry.split(';')[0]).join('; ');
    csrfToken = cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1]!;
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) return app?.close();
    await dataSource.query('DELETE FROM sender_credential WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM sender_config WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  }, 30_000);

  it('TC-CFG-008: no sender-config response contains the plaintext secret', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/sender-configs')
      .set('Cookie', cookie).set('x-csrf-token', csrfToken)
      .send({
        name: `secret-probe-${randomUUID()}`, fromName: 'Probe', fromEmail: `probe-${randomUUID()}@example.test`,
        provider: 'smtp', host: '127.0.0.1', port: 1, username: 'probe-user', secret: PLANTED_SECRET,
      })
      .expect(201);
    senderId = created.body.id as string;
    expect(JSON.stringify(created.body)).not.toContain(PLANTED_SECRET);
    expect(created.body.secretRef).toMatch(/••••/);

    for (const url of ['/api/v1/sender-configs', `/api/v1/sender-configs/${senderId}`]) {
      const response = await request(app.getHttpServer()).get(url).set('Cookie', cookie).expect(200);
      expect(JSON.stringify(response.body)).not.toContain(PLANTED_SECRET);
    }
  }, 30_000);

  it('TC-SEC-001: the plaintext secret is in no tenant-visible database column', async () => {
    const columns: Array<{ table_name: string; column_name: string }> = await dataSource.query(
      `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
         AND c.data_type IN ('text', 'character varying', 'jsonb')`,
    );
    const hits: string[] = [];
    for (const { table_name, column_name } of columns) {
      // Identifiers come from PostgreSQL's own catalogue, never a request;
      // the searched value remains parameterized as $1.
      const found = await dataSource.query(
        `SELECT 1 FROM "${table_name}" WHERE "${column_name}"::text LIKE $1 LIMIT 1`,
        [`%${PLANTED_SECRET}%`],
      );
      if (found.length > 0) hits.push(`${table_name}.${column_name}`);
    }
    expect(hits).toEqual([]);
  }, 60_000);

  it('TC-SEC-001: a connection-test response never echoes a candidate secret', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/sender-configs/${senderId}/test-connection`)
      .set('Cookie', cookie).set('x-csrf-token', csrfToken).set('Idempotency-Key', randomUUID())
      .send({ secret: PLANTED_SECRET });
    expect([200, 201, 400, 503]).toContain(response.status);
    expect(JSON.stringify(response.body ?? {})).not.toContain(PLANTED_SECRET);
  }, 30_000);

  it('TC-SEC-001: sender audit metadata contains classification only, never the secret', async () => {
    const audit = await dataSource.query(
      `SELECT metadata FROM audit_log
       WHERE tenant_id = $1 AND action LIKE 'sender_config.%'
       ORDER BY occurred_at DESC LIMIT 10`,
      [tenant.id],
    );
    expect(JSON.stringify(audit)).not.toContain(PLANTED_SECRET);
  });
});
