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
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

describe('Campaign drafts HTTP (M4-S1: BR-CMP-001/011/012)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let operatorUser: AppUserEntity;
  const password = 'correct-horse-battery-staple';
  const operator = `campaign-operator-${randomUUID()}@test.dev`;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `campaign-http-${randomUUID()}` });
    operatorUser = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Campaign Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
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

  it('creates, lists and fetches a tenant draft with ETag', async () => {
    const session = await login();
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: '  August draft  ', subject: 'Hello', audience: { recipientIds: [randomUUID()] } });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name: 'August draft', completeness: 60, version: 0, ownerId: operatorUser.id });
    expect(created.headers.etag).toBe('"0"');
    const listed = await request(app.getHttpServer()).get('/api/v1/campaigns').set('Cookie', session.cookie);
    expect(listed.body.items).toEqual([expect.objectContaining({ id: created.body.id, completeness: 60 })]);
    const fetched = await request(app.getHttpServer()).get(`/api/v1/campaigns/${created.body.id}`).set('Cookie', session.cookie);
    expect(fetched.headers.etag).toBe('"0"');
  });

  it('creates a new draft without auto-filling a campaign name', async () => {
    const session = await login();
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: '' });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name: '', completeness: 0, version: 0, ownerId: operatorUser.id });
  });

  it('defaults to my drafts and rejects tenant-wide scope for an operator', async () => {
    const session = await login();
    await dataSource.query("INSERT INTO campaign (tenant_id, name, status, created_by) VALUES ($1, $2, 'draft', NULL)", [tenant.id, `Legacy draft ${randomUUID()}`]);

    const mine = await request(app.getHttpServer()).get('/api/v1/campaigns?scope=mine').set('Cookie', session.cookie);
    expect(mine.status).toBe(200);
    expect(mine.body.items.every((item: { ownerId: string | null }) => item.ownerId === operatorUser.id)).toBe(true);

    const all = await request(app.getHttpServer()).get('/api/v1/campaigns?scope=all').set('Cookie', session.cookie);
    expect(all.status).toBe(403);
    expect(all.body.code).toBe('DRAFT_SCOPE_FORBIDDEN');
  });

  it('lists only draft campaigns by default and honours the bounded list query', async () => {
    const session = await login();
    const draftNames = ['Newest draft', 'Older draft'];
    for (const name of draftNames) {
      const response = await request(app.getHttpServer()).post('/api/v1/campaigns')
        .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    await dataSource.query("INSERT INTO campaign (tenant_id, name, status) VALUES ($1, $2, 'completed')", [tenant.id, `Completed ${randomUUID()}`]);

    const defaults = await request(app.getHttpServer()).get('/api/v1/campaigns').set('Cookie', session.cookie);
    expect(defaults.status).toBe(200);
    expect(defaults.body.items).toEqual(expect.arrayContaining(draftNames.map((name) => expect.objectContaining({ name, status: 'draft' }))));
    expect(defaults.body.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: 'completed' })]));

    const one = await request(app.getHttpServer()).get('/api/v1/campaigns?status=draft&limit=1').set('Cookie', session.cookie);
    expect(one.status).toBe(200);
    expect(one.body.items).toHaveLength(1);
  });

  it('requires If-Match and applies 404 then 409 then 412 precedence', async () => {
    const session = await login();
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: `Concurrency ${randomUUID()}` });
    const noMatch = await request(app.getHttpServer()).patch(`/api/v1/campaigns/${created.body.id}`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ subject: 'Missing header' });
    expect(noMatch.status).toBe(428);
    const missing = await request(app.getHttpServer()).patch(`/api/v1/campaigns/${randomUUID()}`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('If-Match', '"0"').send({ subject: 'Unknown' });
    expect(missing.status).toBe(404);
    const first = await request(app.getHttpServer()).patch(`/api/v1/campaigns/${created.body.id}`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('If-Match', '"0"').send({ subject: 'Fresh' });
    expect(first.status).toBe(200);
    const stale = await request(app.getHttpServer()).patch(`/api/v1/campaigns/${created.body.id}`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('If-Match', '"0"').send({ subject: 'Stale' });
    expect(stale.status).toBe(412);
    expect((await request(app.getHttpServer()).get(`/api/v1/campaigns/${created.body.id}`).set('Cookie', session.cookie)).body.subject).toBe('Fresh');

    await dataSource.query("UPDATE campaign SET status = 'sending' WHERE id = $1", [created.body.id]);
    const lockedEvenWhenStale = await request(app.getHttpServer()).patch(`/api/v1/campaigns/${created.body.id}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('If-Match', '"0"').send({ subject: 'Must stay locked' });
    expect(lockedEvenWhenStale.status).toBe(409);
  });
});
