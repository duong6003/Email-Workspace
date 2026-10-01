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

const PLANTED_CUSTOM_VALUE = `custom-value-${randomUUID()}`;
const PLANTED_EMAIL_BODY_MARKER = `email-body-${randomUUID()}`;
const PLANTED_RECIPIENT_EMAIL = `pii-${randomUUID()}@example.test`;

describe('M7-S2 PII response payload negatives (TC-SEC-003)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let userId: string;
  let cookie: string;
  let csrfToken: string;
  const email = `pii-payload-${randomUUID()}@test.dev`;
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'm7-s2-pii-payload-session-secret'.repeat(2);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `pii-payload-${randomUUID()}` });
    const user = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email, displayName: 'PII Payload Admin', role: 'admin',
      passwordHash: await hashPassword(password), status: 'active',
    });
    userId = user.id;
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(204);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    cookie = cookies.map((entry) => entry.split(';')[0]).join('; ');
    csrfToken = cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1]!;
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) return app?.close();
    await dataSource.query('DELETE FROM export_job WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  const malformedRequests = [
    { method: 'post', path: '/api/v1/recipients', body: { email: PLANTED_RECIPIENT_EMAIL, customData: { marker: PLANTED_CUSTOM_VALUE }, firstName: PLANTED_EMAIL_BODY_MARKER } },
    { method: 'post', path: '/api/v1/templates', body: { name: '', html: PLANTED_EMAIL_BODY_MARKER } },
    { method: 'post', path: '/api/v1/import-jobs', body: { fileName: PLANTED_RECIPIENT_EMAIL, rows: PLANTED_CUSTOM_VALUE } },
    { method: 'post', path: '/api/v1/bulk-jobs', body: { action: 'delete', recipientIds: PLANTED_CUSTOM_VALUE, actionPayload: { body: PLANTED_EMAIL_BODY_MARKER } } },
    { method: 'post', path: `/api/v1/campaigns/${randomUUID()}/exports`, body: { kind: PLANTED_CUSTOM_VALUE } },
    { method: 'patch', path: `/api/v1/custom-fields/${randomUUID()}`, body: { label: PLANTED_EMAIL_BODY_MARKER, unknown: PLANTED_CUSTOM_VALUE } },
  ] as const;

  it.each(malformedRequests)('keeps planted PII out of the Problem body for $method $path', async ({ method, path, body }) => {
    const response = await request(app.getHttpServer())
      [method](path)
      .set('Cookie', cookie)
      .set('x-csrf-token', csrfToken)
      .send(body);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const serialized = JSON.stringify(response.body ?? {});
    expect(serialized).not.toContain(PLANTED_CUSTOM_VALUE);
    expect(serialized).not.toContain(PLANTED_EMAIL_BODY_MARKER);
    expect(serialized).not.toContain(PLANTED_RECIPIENT_EMAIL);
    expect(serialized).not.toMatch(/\bat \w+ \(.*:\d+:\d+\)/);
  });

  it('refuses an expired completed export with 410 before considering artifact bytes', async () => {
    const campaignId = randomUUID();
    const exportId = randomUUID();
    await dataSource.query(
      `INSERT INTO campaign (id, tenant_id, name, subject, status, settings_json, audience_json, created_by, updated_by)
       VALUES ($1, $2, $3, '', 'draft', '{}'::jsonb, '{}'::jsonb, NULL, NULL)`,
      [campaignId, tenant.id, `pii-export-${randomUUID()}`],
    );
    await dataSource.query(
      `INSERT INTO export_job
       (id, tenant_id, campaign_id, kind, status, status_filter, row_count, artifact_bytes, artifact_filename, expires_at, created_by)
       VALUES ($1, $2, $3, 'campaign_recipients', 'completed', ARRAY[]::text[], 1, $4, 'expired.csv', now() - interval '1 hour', $5)`,
      [exportId, tenant.id, campaignId, Buffer.from('recipient_email\r\n', 'utf8'), userId],
    );
    // Migration 033's purge keeps the completed row but clears artifact_bytes.
    await dataSource.query('UPDATE export_job SET artifact_bytes = NULL WHERE id = $1', [exportId]);

    await request(app.getHttpServer())
      .get(`/api/v1/campaigns/${campaignId}/exports/${exportId}/file`)
      .set('Cookie', cookie)
      .expect(410);

    await dataSource.query('DELETE FROM export_job WHERE id = $1', [exportId]);
    await dataSource.query('DELETE FROM campaign WHERE id = $1', [campaignId]);
  });
});
