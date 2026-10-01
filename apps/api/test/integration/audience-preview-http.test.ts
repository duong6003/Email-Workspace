import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { RecipientListEntity } from '../../src/database/entities/recipient-list.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

/**
 * M4-S2 (BR-SEG-008/009, BR-CMP-002/003/009, BR-REC-003) via a real Nest HTTP
 * stack: A6 (over-limit 422 body shape) and A10 (cross-tenant/unknown
 * campaignId 404) from M4-S2-AUDIENCE-PLAN.md, plus a real end-to-end
 * preview through the actual endpoint.
 */
describe('Campaign audience preview HTTP (M4-S2)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const operator = `audience-operator-${randomUUID()}@test.dev`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    // Set low deliberately, matching how every sibling HTTP test file already
    // fixes process.env before AppModule is imported: ConfigModule.forRoot's
    // validate() reads it once at module-compile time, so this test file's own
    // AppModule instance sees this value without a 100,000-row fixture.
    process.env.CAMPAIGN_AUDIENCE_LIMIT = '2';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `audience-http-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Audience Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  async function login(): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: operator, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return {
      cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
  }

  async function createDraft(session: { cookie: string; csrfToken: string }) {
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: `Audience draft ${randomUUID()}` });
    return created.body.id as string;
  }

  it('resolves a real audience end-to-end through the actual endpoint', async () => {
    const session = await login();
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `member-${randomUUID()}@example.test` });
    const list = await dataSource.getRepository(RecipientListEntity).save({ tenantId: tenant.id, name: `list-${randomUUID()}` });
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenant.id, list.id, recipient.id, 'manual'],
    );
    const campaignId = await createDraft(session);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/audience/preview`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ audience: { listIds: [list.id] } });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ totalUnique: 1, actionable: 1, skipped: 0 });
  });

  it('A10: 404s for an unknown campaign id, never leaking whether a real audience would have matched', async () => {
    const session = await login();
    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${randomUUID()}/audience/preview`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ audience: {} });

    expect(response.status).toBe(404);
  });

  it('A6: an over-limit audience returns 422 with limit, current and requested in the problem body', async () => {
    // CAMPAIGN_AUDIENCE_LIMIT is fixed at 2 for this test file (see beforeAll)
    // specifically so this case is provable without a 100,000-row fixture.
    const session = await login();
    const campaignId = await createDraft(session);
    const recipients = await Promise.all(
      Array.from({ length: 3 }, () => dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `over-limit-${randomUUID()}@example.test` })),
    );

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/audience/preview`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ audience: { recipientIds: recipients.map((r) => r.id) } });

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body).toMatchObject({ limit: 2, current: 0, requested: 3 });
  });
});
