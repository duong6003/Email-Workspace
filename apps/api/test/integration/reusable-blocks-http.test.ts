import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { testPasswordHash } from './test-password.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

/**
 * MC-UI-004 reusable block library (S5 Task 27).
 *
 * The decision this suite exists to hold in place (plan §S5 Task 26): blocks
 * belong to the TENANT, not to whoever saved them. Two consequences need tests
 * that pull in opposite directions, and both are here:
 *
 *   - cross-tenant: another tenant must never see or touch tenant A's blocks
 *     (BR-GEN-002, ARCH-CROSS-TENANT -- every route below has a negative case);
 *   - within one tenant: operator B must be able to rename and delete operator
 *     A's block. That is not a hole, it is the decision -- so it needs a test,
 *     or the next person will "fix" it into per-user ownership.
 */
describe('Reusable blocks HTTP (MC-UI-004, S5 Task 27)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const operatorA = `block-operator-a-${randomUUID()}@test.dev`;
  const operatorA2 = `block-operator-a2-${randomUUID()}@test.dev`;
  const operatorB = `block-operator-b-${randomUUID()}@test.dev`;
  const viewer = `block-viewer-${randomUUID()}@test.dev`;

  const sampleNode = () => ({
    id: randomUUID(),
    kind: 'section',
    visible: true,
    background: '#ffffff',
    children: [{ id: randomUUID(), kind: 'text', visible: true, content: 'Chân trang' }],
  });

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
    tenantA = await dataSource.getRepository(TenantEntity).save({ name: `blocks-a-${randomUUID()}` });
    tenantB = await dataSource.getRepository(TenantEntity).save({ name: `blocks-b-${randomUUID()}` });
    const users = dataSource.getRepository(AppUserEntity);
    await users.save([
      { tenantId: tenantA.id, email: operatorA, displayName: 'Block Operator A', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active' },
      { tenantId: tenantA.id, email: operatorA2, displayName: 'Block Operator A2', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active' },
      { tenantId: tenantB.id, email: operatorB, displayName: 'Block Operator B', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active' },
      { tenantId: tenantA.id, email: viewer, displayName: 'Block Viewer', role: 'viewer', passwordHash: await testPasswordHash(password), status: 'active' },
    ]);
  });

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.query('DELETE FROM reusable_block WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenantB.id });
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

  /** Returns the supertest Test itself, not a Promise wrapping it, so callers can keep chaining .expect(). */
  function createBlock(session: { cookie: string; csrfToken: string }, name: string) {
    return request(app.getHttpServer()).post('/api/v1/reusable-blocks')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name, node: sampleNode() });
  }

  it('saves a block, keeps the node out of the listing, and returns it from the detail route', async () => {
    const session = await login(operatorA);
    const name = `Chân trang ${randomUUID()}`;

    const created = await createBlock(session, name);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name, createdByName: 'Block Operator A' });
    expect(created.body.node).toMatchObject({ kind: 'section' });

    // Same projection rule the template library already uses (ADR-035): a list
    // of block trees would be the payload of every template in the tenant.
    const listed = await request(app.getHttpServer()).get('/api/v1/reusable-blocks').set('Cookie', session.cookie).expect(200);
    const row = (listed.body.items as Array<{ id: string; name: string; node?: unknown }>).find((item) => item.id === created.body.id);
    expect(row).toMatchObject({ name });
    expect(row).not.toHaveProperty('node');

    const detail = await request(app.getHttpServer()).get(`/api/v1/reusable-blocks/${created.body.id}`).set('Cookie', session.cookie).expect(200);
    expect(detail.body.node.children[0]).toMatchObject({ kind: 'text', content: 'Chân trang' });
  });

  it('rejects a duplicate name in the tenant the same normalized way template names collide', async () => {
    const session = await login(operatorA);
    const name = `Trùng tên ${randomUUID()}`;
    await createBlock(session, name).expect(201);

    const duplicate = await createBlock(session, `  ${name.toUpperCase()}  `);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ code: 'REUSABLE_BLOCK_NAME_CONFLICT' });
  });

  it('lets another member of the same tenant rename and delete a block they did not save (Task 26: tenant ownership)', async () => {
    const author = await login(operatorA);
    const colleague = await login(operatorA2);
    const created = await createBlock(author, `Của A ${randomUUID()}`).expect(201);

    // The colleague sees it at all -- there is no "my blocks" partition.
    const listed = await request(app.getHttpServer()).get('/api/v1/reusable-blocks').set('Cookie', colleague.cookie).expect(200);
    expect((listed.body.items as Array<{ id: string }>).some((item) => item.id === created.body.id)).toBe(true);

    const renamed = await request(app.getHttpServer()).patch(`/api/v1/reusable-blocks/${created.body.id}`)
      .set('Cookie', colleague.cookie).set('x-csrf-token', colleague.csrfToken)
      .send({ name: `Đổi bởi A2 ${randomUUID()}` });
    expect(renamed.status).toBe(200);
    // Attribution survives a rename: created_by records who saved it, and is
    // never touched by whoever edits it afterwards.
    expect(renamed.body.createdByName).toBe('Block Operator A');

    await request(app.getHttpServer()).delete(`/api/v1/reusable-blocks/${created.body.id}`)
      .set('Cookie', colleague.cookie).set('x-csrf-token', colleague.csrfToken)
      .expect(204);

    await request(app.getHttpServer()).get(`/api/v1/reusable-blocks/${created.body.id}`).set('Cookie', author.cookie).expect(404);
  });

  it('never leaks a block to another tenant on any route (cross-tenant, BR-GEN-002)', async () => {
    const sessionA = await login(operatorA);
    const sessionB = await login(operatorB);
    const created = await createBlock(sessionA, `Riêng tenant A ${randomUUID()}`).expect(201);

    const listedB = await request(app.getHttpServer()).get('/api/v1/reusable-blocks').set('Cookie', sessionB.cookie).expect(200);
    expect((listedB.body.items as Array<{ id: string }>).some((item) => item.id === created.body.id)).toBe(false);

    await request(app.getHttpServer()).get(`/api/v1/reusable-blocks/${created.body.id}`).set('Cookie', sessionB.cookie).expect(404);
    await request(app.getHttpServer()).patch(`/api/v1/reusable-blocks/${created.body.id}`)
      .set('Cookie', sessionB.cookie).set('x-csrf-token', sessionB.csrfToken).send({ name: 'stolen' }).expect(404);
    await request(app.getHttpServer()).delete(`/api/v1/reusable-blocks/${created.body.id}`)
      .set('Cookie', sessionB.cookie).set('x-csrf-token', sessionB.csrfToken).expect(404);

    // A's block is still there, untouched.
    await request(app.getHttpServer()).get(`/api/v1/reusable-blocks/${created.body.id}`).set('Cookie', sessionA.cookie).expect(200);
  });

  it('gives a viewer read access and refuses every write, and refuses writes without CSRF', async () => {
    const operator = await login(operatorA);
    const created = await createBlock(operator, `Chỉ đọc ${randomUUID()}`).expect(201);

    // content:read -- the same split 073 made for templates. A viewer opening
    // the builder read-only must still see the library, or the panel would be
    // an empty screen rather than an explained read-only one (spec §2.1).
    const viewerSession = await login(viewer);
    await request(app.getHttpServer()).get('/api/v1/reusable-blocks').set('Cookie', viewerSession.cookie).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/reusable-blocks/${created.body.id}`).set('Cookie', viewerSession.cookie).expect(200);

    const denied = await request(app.getHttpServer()).post('/api/v1/reusable-blocks')
      .set('Cookie', viewerSession.cookie).set('x-csrf-token', viewerSession.csrfToken)
      .send({ name: 'Viewer should not save this', node: sampleNode() });
    expect(denied.status).toBe(403);
    expect(denied.headers['content-type']).toContain('application/problem+json');

    await request(app.getHttpServer()).patch(`/api/v1/reusable-blocks/${created.body.id}`)
      .set('Cookie', viewerSession.cookie).set('x-csrf-token', viewerSession.csrfToken).send({ name: 'nope' }).expect(403);
    await request(app.getHttpServer()).delete(`/api/v1/reusable-blocks/${created.body.id}`)
      .set('Cookie', viewerSession.cookie).set('x-csrf-token', viewerSession.csrfToken).expect(403);

    const noCsrf = await request(app.getHttpServer()).post('/api/v1/reusable-blocks').set('Cookie', operator.cookie).send({ name: 'No CSRF', node: sampleNode() });
    expect(noCsrf.status).toBe(403);
  });

  it('refuses a block with no name or no node rather than storing an unusable row', async () => {
    const session = await login(operatorA);
    await request(app.getHttpServer()).post('/api/v1/reusable-blocks')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: '   ', node: sampleNode() }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/reusable-blocks')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: 'Không có node' }).expect(400);
  });
});
