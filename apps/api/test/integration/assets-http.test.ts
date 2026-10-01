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
import { testAssetStorageSettings } from './test-asset-storage.js';

/** A 1x1 PNG, small but structurally real -- the validator sniffs magic bytes, so a fake buffer would not survive. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');

/**
 * S6 Task 36. The routes, exercised against real Postgres and real MinIO.
 *
 * Two properties here cannot be checked anywhere else. First, cross-tenant: the
 * authenticated routes must refuse another tenant's asset on every verb
 * (BR-GEN-002, ARCH-CROSS-TENANT). Second, and pulling the other way, the
 * PUBLIC serving route must serve any tenant's asset to a caller with no
 * session at all -- that is not a leak, it is ADR-043 §2's deliberate bearer
 * capability, and it needs a test or someone will "fix" it into an
 * authenticated route and break every image in already-sent mail.
 */
describe('Assets HTTP (MC-UI-005, S6 Task 36)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const operatorA = `asset-operator-a-${randomUUID()}@test.dev`;
  const operatorB = `asset-operator-b-${randomUUID()}@test.dev`;
  const viewer = `asset-viewer-${randomUUID()}@test.dev`;

  beforeAll(async () => {
    const storage = testAssetStorageSettings(process.env.EOW_ASSET_BUCKET ?? 'eow-assets');
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    // Host-run: MinIO is only "minio" inside the compose network.
    process.env.ASSET_STORAGE_ENDPOINT = storage.endpoint;
    process.env.ASSET_STORAGE_BUCKET = storage.bucket;
    process.env.ASSET_STORAGE_ACCESS_KEY = storage.accessKeyId;
    process.env.ASSET_STORAGE_SECRET_KEY = storage.secretAccessKey;
    process.env.ASSET_STORAGE_REGION = storage.region;
    process.env.ASSET_PUBLIC_ORIGIN = 'https://app.example.test';

    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenantA = await dataSource.getRepository(TenantEntity).save({ name: `assets-a-${randomUUID()}` });
    tenantB = await dataSource.getRepository(TenantEntity).save({ name: `assets-b-${randomUUID()}` });
    const users = dataSource.getRepository(AppUserEntity);
    await users.save([
      { tenantId: tenantA.id, email: operatorA, displayName: 'Asset Operator A', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active' },
      { tenantId: tenantB.id, email: operatorB, displayName: 'Asset Operator B', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active' },
      { tenantId: tenantA.id, email: viewer, displayName: 'Asset Viewer', role: 'viewer', passwordHash: await testPasswordHash(password), status: 'active' },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    // Rows only. ADR-043 §5 has no object delete, and the store is a dev container.
    await dataSource.query('DELETE FROM asset WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenantB.id });
    // Tenant fixtures stay: audit_log is immutable and its rows reference them,
    // exactly as templates-http.test.ts already records.
    await app.close();
  }, 60_000);

  async function login(email: string): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return {
      cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
  }

  function upload(session: { cookie: string; csrfToken: string }, body: Buffer, filename: string) {
    return request(app.getHttpServer()).post('/api/v1/assets')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .attach('file', body, filename);
  }

  it('uploads, stores the sniffed type, and returns an ABSOLUTE https url (Task 32: a relative one is stripped by the sanitizer)', async () => {
    const session = await login(operatorA);
    const created = await upload(session, PNG, 'logo cong ty.png');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ contentType: 'image/png', filename: 'logo cong ty.png', createdByName: 'Asset Operator A', archivedAt: null });
    expect(created.body.byteSize).toBe(PNG.length);
    expect(created.body.url).toBe(`https://app.example.test/api/v1/assets/${created.body.id}/${encodeURIComponent('logo cong ty.png')}`);

    const listed = await request(app.getHttpServer()).get('/api/v1/assets').set('Cookie', session.cookie).expect(200);
    expect((listed.body.items as Array<{ id: string }>).some((item) => item.id === created.body.id)).toBe(true);
  }, 60_000);

  it('serves the bytes with NO session at all -- ADR-043 §2, because a mail client carries none of our cookies', async () => {
    const session = await login(operatorA);
    const created = await upload(session, PNG, 'public.png').expect(201);

    // The path a real mail client requests: the ORIGIN's own `.url` value, with
    // its host stripped, not a path this test reconstructs by hand. A test that
    // reconstructs the path independently proves nothing about whether the
    // minted URL is the one that actually works -- exactly the gap that hid
    // `assetPublicUrl` emitting `/api/v1/assets/...` (missing `/v1/`) until a real
    // domain was fetched end to end. Every asset URL ever minted 404'd.
    const requestPath = new URL(created.body.url).pathname;
    expect(requestPath).toBe(`/api/v1/assets/${created.body.id}/public.png`);

    const served = await request(app.getHttpServer()).get(requestPath).expect(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['cache-control']).toContain('immutable');
    expect(Buffer.from(served.body)).toEqual(PNG);
  }, 60_000);

  it('refuses SVG through the route, with its own code rather than a generic unsupported type', async () => {
    const session = await login(operatorA);
    const refused = await upload(session, SVG, 'evil.svg');
    expect(refused.status).toBe(415);
    expect(refused.body).toMatchObject({ code: 'SVG_REJECTED' });
  }, 60_000);

  it('archives instead of deleting, and keeps serving the archived bytes', async () => {
    const session = await login(operatorA);
    const created = await upload(session, PNG, 'archived.png').expect(201);

    await request(app.getHttpServer()).delete(`/api/v1/assets/${created.body.id}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).expect(204);

    const listed = await request(app.getHttpServer()).get('/api/v1/assets').set('Cookie', session.cookie).expect(200);
    expect((listed.body.items as Array<{ id: string }>).some((item) => item.id === created.body.id)).toBe(false);

    // Still served: a published version points here and cannot be edited.
    await request(app.getHttpServer()).get(`/api/v1/assets/${created.body.id}/archived.png`).expect(200);
  }, 60_000);

  it('replaces by minting a new asset and archiving the old one, never overwriting bytes at the old url', async () => {
    const session = await login(operatorA);
    const original = await upload(session, PNG, 'before.png').expect(201);

    const replaced = await request(app.getHttpServer()).post(`/api/v1/assets/${original.body.id}/replace`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .attach('file', PNG, 'after.png');
    expect(replaced.status).toBe(201);
    expect(replaced.body.id).not.toBe(original.body.id);
    expect(replaced.body.url).not.toBe(original.body.url);

    // The old url still resolves, which is the point: already-published email references it.
    await request(app.getHttpServer()).get(`/api/v1/assets/${original.body.id}/before.png`).expect(200);
  }, 60_000);

  /**
   * ADR-044 Task SV-4 (SV decision 3). `kind` is the one thing about an asset a
   * person chooses rather than the bytes deciding: MC-UI-005's filter bar and
   * brand kit are built on it. It is deliberately not `contentType`, which
   * ADR-043 §4 sniffs and never trusts the client for.
   */
  it('defaults an upload that says nothing to image, and takes logo when it is stated', async () => {
    const session = await login(operatorA);
    const silent = await upload(session, PNG, 'quiet.png').expect(201);
    expect(silent.body.kind).toBe('image');

    const stated = await request(app.getHttpServer()).post('/api/v1/assets')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .field('kind', 'logo').attach('file', PNG, 'brand.png');
    expect(stated.status).toBe(201);
    expect(stated.body.kind).toBe('logo');
  }, 60_000);

  it('refuses an upload whose kind is present and wrong, rather than filing it under the default', async () => {
    // Silently rewriting 'banner' to 'image' would put the asset somewhere the
    // caller never asked for and never tell them.
    const session = await login(operatorA);
    const refused = await request(app.getHttpServer()).post('/api/v1/assets')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .field('kind', 'banner').attach('file', PNG, 'wrong.png');
    expect(refused.status).toBe(400);
  }, 60_000);

  it('reclassifies in place -- same id, same url, so nothing already published moves', async () => {
    const session = await login(operatorA);
    const created = await upload(session, PNG, 'reclassify.png').expect(201);
    expect(created.body.kind).toBe('image');

    const updated = await request(app.getHttpServer()).patch(`/api/v1/assets/${created.body.id}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ kind: 'logo' });
    expect(updated.status).toBe(200);
    expect(updated.body.kind).toBe('logo');
    // The contrast with `replace`, and the reason this is a PATCH: a label is
    // not content, so ADR-043 §7's archive-and-recreate rule does not apply.
    expect(updated.body.id).toBe(created.body.id);
    expect(updated.body.url).toBe(created.body.url);
    await request(app.getHttpServer()).get(new URL(created.body.url).pathname).expect(200);
  }, 60_000);

  it('refuses a PATCH whose kind is blank, instead of reading it as "not stated"', async () => {
    // The upload path is lenient about a blank field, because that is what a
    // form sends for a control nobody touched. A JSON body has no such control:
    // "" is a caller sending a wrong value, and answering 200 with a silent
    // 'image' would move the asset without saying so. Measured: the first
    // version of this route did exactly that.
    const session = await login(operatorA);
    const created = await upload(session, PNG, 'blank-patch.png').expect(201);

    for (const body of [{ kind: '' }, { kind: 'banner' }, {}]) {
      await request(app.getHttpServer()).patch(`/api/v1/assets/${created.body.id}`)
        .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
        .send(body).expect(400);
    }

    const listed = await request(app.getHttpServer()).get('/api/v1/assets').set('Cookie', session.cookie).expect(200);
    const still = (listed.body.items as Array<{ id: string; kind: string }>).find((item) => item.id === created.body.id);
    expect(still?.kind).toBe('image');
  }, 60_000);

  it('keeps the classification across a replace -- swapping a logo for a better crop leaves a logo', async () => {
    // Defaulting to 'image' here would quietly empty the brand kit every time
    // somebody re-cropped their logo.
    const session = await login(operatorA);
    const original = await request(app.getHttpServer()).post('/api/v1/assets')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .field('kind', 'logo').attach('file', PNG, 'logo-v1.png').expect(201);

    const replaced = await request(app.getHttpServer()).post(`/api/v1/assets/${original.body.id}/replace`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .attach('file', PNG, 'logo-v2.png');
    expect(replaced.status).toBe(201);
    expect(replaced.body.kind).toBe('logo');
  }, 60_000);

  it('never leaks an asset to another tenant on any authenticated route (cross-tenant, BR-GEN-002)', async () => {
    const sessionA = await login(operatorA);
    const sessionB = await login(operatorB);
    const created = await upload(sessionA, PNG, 'tenant-a.png').expect(201);

    const listedB = await request(app.getHttpServer()).get('/api/v1/assets').set('Cookie', sessionB.cookie).expect(200);
    expect((listedB.body.items as Array<{ id: string }>).some((item) => item.id === created.body.id)).toBe(false);

    await request(app.getHttpServer()).delete(`/api/v1/assets/${created.body.id}`)
      .set('Cookie', sessionB.cookie).set('x-csrf-token', sessionB.csrfToken).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/assets/${created.body.id}/replace`)
      .set('Cookie', sessionB.cookie).set('x-csrf-token', sessionB.csrfToken).attach('file', PNG, 'steal.png').expect(404);
    // ADR-044 Task SV-4: the new verb is on the same footing as the others.
    await request(app.getHttpServer()).patch(`/api/v1/assets/${created.body.id}`)
      .set('Cookie', sessionB.cookie).set('x-csrf-token', sessionB.csrfToken).send({ kind: 'logo' }).expect(404);

    // A's asset survived both attempts.
    await request(app.getHttpServer()).get(`/api/v1/assets/${created.body.id}/tenant-a.png`).expect(200);
  }, 60_000);

  it('gives a viewer read access and refuses every write, and refuses a write without CSRF', async () => {
    const operator = await login(operatorA);
    const created = await upload(operator, PNG, 'readonly.png').expect(201);

    const viewerSession = await login(viewer);
    await request(app.getHttpServer()).get('/api/v1/assets').set('Cookie', viewerSession.cookie).expect(200);

    const denied = await request(app.getHttpServer()).post('/api/v1/assets')
      .set('Cookie', viewerSession.cookie).set('x-csrf-token', viewerSession.csrfToken).attach('file', PNG, 'nope.png');
    expect(denied.status).toBe(403);
    await request(app.getHttpServer()).delete(`/api/v1/assets/${created.body.id}`)
      .set('Cookie', viewerSession.cookie).set('x-csrf-token', viewerSession.csrfToken).expect(403);

    const noCsrf = await request(app.getHttpServer()).post('/api/v1/assets').set('Cookie', operator.cookie).attach('file', PNG, 'nocsrf.png');
    expect(noCsrf.status).toBe(403);
  }, 60_000);

  it('answers 404 for an unknown id rather than revealing whether the row or the object is the missing half', async () => {
    await request(app.getHttpServer()).get(`/api/v1/assets/${randomUUID()}/anything.png`).expect(404);
  }, 60_000);

  it('answers 4xx, never 500, for an id that is not a uuid at all', async () => {
    const notAUuid = await request(app.getHttpServer()).get('/api/v1/assets/not-a-uuid/x.png');
    expect(notAUuid.status).toBeLessThan(500);
  }, 60_000);
});
