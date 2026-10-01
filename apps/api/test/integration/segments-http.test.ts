import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { RecipientListEntity } from '../../src/database/entities/recipient-list.entity.js';
import { TagEntity } from '../../src/database/entities/tag.entity.js';
import { AuditLogEntity } from '../../src/database/entities/audit-log.entity.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

describe('Segments HTTP (M2-S2)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const email = `http-segments-${randomUUID()}@test.dev`;
  const password = 'correct-horse-battery-staple';

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `http-segment-tenant-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({ tenantId: tenant.id, email, displayName: 'Segment Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active' });
  });

  afterAll(async () => {
    if (!dataSource || !tenant) { await app?.close(); return; }
    await dataSource.query('DELETE FROM recipient_tag WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(TagEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  async function auth(): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    const setCookie = response.headers['set-cookie'] as unknown as string[];
    return { cookie: setCookie.map((entry) => entry.split(';')[0]).join('; '), csrfToken: setCookie.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1] };
  }

  it('returns the shared master-data catalog only to authenticated readers', async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/recipient-lists')).status).toBe(401);
    const session = await auth();
    const response = await request(app.getHttpServer()).get('/api/v1/recipient-lists').set('Cookie', session.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ items: expect.any(Array), nextCursor: null, total: expect.any(Number) });
  });

  it('enforces CSRF, palette validation and normalized-name conflict on mutations', async () => {
    const session = await auth();
    const noCsrf = await request(app.getHttpServer()).post('/api/v1/recipient-lists').set('Cookie', session.cookie).send({ name: 'Customers' });
    expect(noCsrf.status).toBe(403);

    const created = await request(app.getHttpServer()).post('/api/v1/recipient-lists').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: '  Customers  ', description: 'Reusable list' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Customers', memberCount: 0 });

    const duplicate = await request(app.getHttpServer()).post('/api/v1/recipient-lists').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: 'customers' });
    expect(duplicate.status).toBe(409);

    const invalidColor = await request(app.getHttpServer()).post('/api/v1/tags').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: 'Priority', color: '#000000' });
    expect(invalidColor.status).toBe(400);
  });

  it('audits tag deletion with the number of memberships removed', async () => {
    const session = await auth();
    const created = await request(app.getHttpServer()).post('/api/v1/tags').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: `Disposable ${randomUUID()}`, color: '#7356c8' });
    expect(created.status).toBe(201);

    const deleted = await request(app.getHttpServer()).delete(`/api/v1/tags/${created.body.id}`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(deleted.status).toBe(204);
    const audit = await dataSource.getRepository(AuditLogEntity).findOne({ where: { tenantId: tenant.id, action: 'tag.deleted', entityId: created.body.id }, order: { occurredAt: 'DESC' } });
    expect(audit?.metadata).toMatchObject({ removedMembershipCount: 0 });
  });

  /**
   * Found while seeding M4-S2's visual-evidence fixtures: addListMembers/
   * removeListMembers/updateList/addTagMembers/removeTagMembers/updateTag all
   * declared `@UsePipes(new ZodValidationPipe(bodySchema))` at the method
   * level alongside a `@Param('id')` argument. NestJS runs method-level pipes
   * against every resolved parameter (not just @Body), so the route id string
   * was validated against the body's object schema and every real call 400'd
   * with "(body): Invalid input: expected object, received string" -- these
   * six mutations were unreachable over HTTP since M2-S2 shipped them, masked
   * because every prior test called `SegmentsService` directly instead of
   * through the controller. Fixed by moving each pipe onto its own `@Body()`
   * parameter, matching campaigns.controller.ts's established pattern.
   */
  it('adds and removes list/tag members and updates list/tag names over real HTTP (regression: method-level @UsePipes validated the :id param too)', async () => {
    const session = await auth();
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `segments-http-member-${randomUUID()}@test.dev` });
    const list = await request(app.getHttpServer()).post('/api/v1/recipient-lists').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: `Regression list ${randomUUID()}` });
    const tag = await request(app.getHttpServer()).post('/api/v1/tags').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: `Regression tag ${randomUUID()}`, color: '#278b6e' });

    const renamedList = await request(app.getHttpServer()).patch(`/api/v1/recipient-lists/${list.body.id}`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: 'Renamed list' });
    expect(renamedList.status, JSON.stringify(renamedList.body)).toBe(200);
    expect(renamedList.body.name).toBe('Renamed list');

    const renamedTag = await request(app.getHttpServer()).patch(`/api/v1/tags/${tag.body.id}`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: 'Renamed tag' });
    expect(renamedTag.status, JSON.stringify(renamedTag.body)).toBe(200);
    expect(renamedTag.body.name).toBe('Renamed tag');

    const addedToList = await request(app.getHttpServer()).post(`/api/v1/recipient-lists/${list.body.id}/members`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ recipientIds: [recipient.id] });
    expect(addedToList.status, JSON.stringify(addedToList.body)).toBe(201);

    const addedToTag = await request(app.getHttpServer()).post(`/api/v1/tags/${tag.body.id}/members`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ recipientIds: [recipient.id] });
    expect(addedToTag.status, JSON.stringify(addedToTag.body)).toBe(201);

    const afterAdd = await request(app.getHttpServer()).get(`/api/v1/recipients/${recipient.id}/segments`).set('Cookie', session.cookie);
    expect(afterAdd.body.lists).toHaveLength(1);
    expect(afterAdd.body.tags).toHaveLength(1);

    const removedFromList = await request(app.getHttpServer()).delete(`/api/v1/recipient-lists/${list.body.id}/members`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ recipientIds: [recipient.id] });
    expect(removedFromList.status, JSON.stringify(removedFromList.body)).toBe(204);

    const removedFromTag = await request(app.getHttpServer()).delete(`/api/v1/tags/${tag.body.id}/members`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ recipientIds: [recipient.id] });
    expect(removedFromTag.status, JSON.stringify(removedFromTag.body)).toBe(204);

    const afterRemove = await request(app.getHttpServer()).get(`/api/v1/recipients/${recipient.id}/segments`).set('Cookie', session.cookie);
    expect(afterRemove.body.lists).toHaveLength(0);
    expect(afterRemove.body.tags).toHaveLength(0);
  });
});
