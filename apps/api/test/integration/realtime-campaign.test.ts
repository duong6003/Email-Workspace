import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { io, type Socket } from 'socket.io-client';
import { testPasswordHash } from './test-password.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { EmailTemplateEntity } from '../../src/database/entities/email-template.entity.js';
import { EmailTemplateVersionEntity } from '../../src/database/entities/email-template-version.entity.js';
import { CampaignEntity } from '../../src/database/entities/campaign.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/**
 * M6-S1 CP7 (BR-SEND-004): the campaign:{id} and user:{userId} rooms over a
 * real Socket.IO connection -- the gateway's auth chain (cookie -> session
 * -> active user -> tenant context -> permission -> ownership) is only
 * meaningfully proven against a real socket, not by unit-testing the
 * requestedCampaignIds parser alone (R3: this repo's first real-socket test).
 */
describe('Realtime campaign rooms (M6-S1 CP7)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;
  let baseUrl: string;
  const password = 'correct-horse-battery-staple';
  const operatorA = `realtime-campaign-a-${randomUUID()}@test.dev`;
  const operatorB = `realtime-campaign-b-${randomUUID()}@test.dev`;
  let campaignAId: string;
  let campaignBId: string;

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
    await app.init();
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    dataSource = moduleRef.get(getDataSourceToken());
    tenantA = await dataSource.getRepository(TenantEntity).save({ name: `realtime-campaign-a-${randomUUID()}` });
    tenantB = await dataSource.getRepository(TenantEntity).save({ name: `realtime-campaign-b-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenantA.id, email: operatorA, displayName: 'Realtime Campaign A', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active',
    });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenantB.id, email: operatorB, displayName: 'Realtime Campaign B', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active',
    });

    const templateA = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenantA.id, name: `t-${randomUUID()}`, status: 'published' });
    const versionA = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenantA.id, templateId: templateA.id, version: 1, subject: 's', html: '<p>h</p>', textBody: 't',
      variableSchemaJson: { required: [], optional: [] }, contentHash: 'a'.repeat(64), publishedAt: new Date(),
    } as never);
    const campaignA = await dataSource.getRepository(CampaignEntity).save({
      tenantId: tenantA.id, name: `realtime-campaign-a-${randomUUID()}`, status: 'draft', templateVersionId: versionA.id,
    } as never);
    campaignAId = campaignA.id;

    const templateB = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenantB.id, name: `t-${randomUUID()}`, status: 'published' });
    const versionB = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenantB.id, templateId: templateB.id, version: 1, subject: 's', html: '<p>h</p>', textBody: 't',
      variableSchemaJson: { required: [], optional: [] }, contentHash: 'b'.repeat(64), publishedAt: new Date(),
    } as never);
    const campaignB = await dataSource.getRepository(CampaignEntity).save({
      tenantId: tenantB.id, name: `realtime-campaign-b-${randomUUID()}`, status: 'draft', templateVersionId: versionB.id,
    } as never);
    campaignBId = campaignB.id;
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.getRepository(CampaignEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(CampaignEntity).delete({ tenantId: tenantB.id });
    await deleteTemplateVersionFixtures(dataSource, [tenantA.id, tenantB.id]);
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenantB.id });
    // Tenant rows are left in place, matching every other login-exercising
    // integration test in this suite: login() writes an audit_log row, and
    // audit_log is immutable (BR-SEC-002, no DELETE permitted ever), so a
    // probe tenant with a login audit trail can never be fully deleted --
    // expected and harmless, not cleaned up further (established norm,
    // carried forward from every prior *-HANDOFF.md in this run).
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return cookies.map((entry) => entry.split(';')[0]).join('; ');
  }

  function connect(auth: Record<string, unknown>, cookie?: string): Socket {
    return io(`${baseUrl}/realtime`, {
      path: '/socket.io',
      transports: ['websocket'],
      autoConnect: false,
      auth,
      extraHeaders: cookie ? { Cookie: cookie } : {},
    });
  }

  function waitForEvent(client: Socket, event: string, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
      client.once(event, (payload: unknown) => { clearTimeout(timer); resolve(payload); });
    });
  }

  it('A10: an authorised viewer joins campaign:{id} and receives a relayed campaign.progress event', async () => {
    const cookie = await login(operatorA);
    const client = connect({ campaignId: campaignAId }, cookie);
    try {
      client.connect();
      await waitForEvent(client, 'rt.connection.ready');

      const { Redis } = await import('ioredis');
      const publisher = new Redis(testRedisUrl());
      const envelope = { event_id: randomUUID(), event_type: 'campaign.progress', occurred_at: new Date().toISOString(), tenant_id: tenantA.id, aggregate_id: campaignAId, version: 1, data: { percent: 42 } };
      const received = waitForEvent(client, 'campaign.progress');
      await publisher.publish(`eow:campaign:${campaignAId}`, JSON.stringify(envelope));
      const payload = await received;
      await publisher.quit();

      expect(payload).toMatchObject({ aggregate_id: campaignAId, data: { percent: 42 } });
    } finally {
      client.close();
    }
  }, 15_000);

  it("M6-GATE: rt.connection.ready carries the connecting user's own tenant_id (ARCH-ASYNCAPI-CONFORMANCE)", async () => {
    const cookie = await login(operatorA);
    const client = connect({ campaignId: campaignAId }, cookie);
    try {
      client.connect();
      const ready = await waitForEvent(client, 'rt.connection.ready') as Record<string, unknown>;
      expect(ready.tenant_id).toBe(tenantA.id);
      for (const field of ['event_id', 'event_type', 'occurred_at', 'tenant_id', 'version', 'data']) {
        expect(ready, `rt.connection.ready is missing the required EventEnvelope field ${field}`).toHaveProperty(field);
      }
    } finally {
      client.close();
    }
  }, 15_000);

  it('M6-GATE: a baseline connection with no job/campaign request still authenticates and joins user:{id}, receiving events published to eow:user:{id}', async () => {
    const cookie = await login(operatorA);
    const client = connect({}, cookie);
    try {
      client.connect();
      await waitForEvent(client, 'rt.connection.ready');

      const { Redis } = await import('ioredis');
      const publisher = new Redis(testRedisUrl());
      const userId = await dataSource.getRepository(AppUserEntity).findOne({ where: { tenantId: tenantA.id, email: operatorA } }).then((u) => u!.id);
      const envelope = { event_id: randomUUID(), event_type: 'rt.resync_required', occurred_at: new Date().toISOString(), tenant_id: tenantA.id, aggregate_id: userId, version: 1, data: { campaign_id: campaignAId } };
      const received = waitForEvent(client, 'rt.resync_required');
      await publisher.publish(`eow:user:${userId}`, JSON.stringify(envelope));
      const payload = await received;
      await publisher.quit();

      expect(payload).toMatchObject({ aggregate_id: userId });
    } finally {
      client.close();
    }
  }, 15_000);

  it('M6-GATE: a baseline connection with no job/campaign request and no session cookie is still disconnected', async () => {
    const client = connect({});
    try {
      client.connect();
      await waitForEvent(client, 'disconnect');
      expect(client.connected).toBe(false);
    } finally {
      client.close();
    }
  }, 15_000);

  it('A10: a campaign id belonging to another tenant is disconnected and joins no room', async () => {
    const cookie = await login(operatorA);
    const client = connect({ campaignId: campaignBId }, cookie);
    try {
      client.connect();
      await waitForEvent(client, 'disconnect');
      expect(client.connected).toBe(false);
    } finally {
      client.close();
    }
  }, 15_000);

  it('A11: no session cookie disconnects the client', async () => {
    const client = connect({ campaignId: campaignAId });
    try {
      client.connect();
      await waitForEvent(client, 'disconnect');
      expect(client.connected).toBe(false);
    } finally {
      client.close();
    }
  }, 15_000);

  it('A11: an expired/invalid session cookie disconnects the client', async () => {
    const client = connect({ campaignId: campaignAId }, 'eow_session=not-a-real-token');
    try {
      client.connect();
      await waitForEvent(client, 'disconnect');
      expect(client.connected).toBe(false);
    } finally {
      client.close();
    }
  }, 15_000);

  it('A11: an inactive user is disconnected even with a valid session', async () => {
    const suspendedEmail = `realtime-campaign-suspended-${randomUUID()}@test.dev`;
    const suspended = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenantA.id, email: suspendedEmail, displayName: 'Suspended', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active',
    });
    const cookie = await login(suspendedEmail);
    await dataSource.getRepository(AppUserEntity).update(suspended.id, { status: 'suspended' } as never);

    const client = connect({ campaignId: campaignAId }, cookie);
    try {
      client.connect();
      await waitForEvent(client, 'disconnect');
      expect(client.connected).toBe(false);
    } finally {
      client.close();
      await dataSource.getRepository(UserSessionEntity).delete({ userId: suspended.id });
      await dataSource.getRepository(AppUserEntity).delete(suspended.id);
    }
  }, 15_000);

  it('A11: a user without campaign:read is disconnected', async () => {
    // 'viewer'/'operator'/'admin' all carry campaign:read (004_rbac.sql), so
    // proving the negative needs a role that genuinely has none: a fresh
    // `role` row (a global reference catalogue, not tenant-owned) with zero
    // role_permission rows, explicitly assigned via user_role -- which
    // PermissionsService.getPermissionsForUser treats as authoritative over
    // the legacy app_user.role text column once any user_role row exists.
    const restrictedEmail = `realtime-campaign-no-perm-${randomUUID()}@test.dev`;
    const restricted = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenantA.id, email: restrictedEmail, displayName: 'No Permissions', role: 'viewer', passwordHash: await testPasswordHash(password), status: 'active',
    });
    const [noPermRole] = await dataSource.query(
      `INSERT INTO role (key, name, description) VALUES ($1, 'No permissions', 'Realtime CP7 test fixture') RETURNING id`,
      [`realtime-campaign-no-perm-role-${randomUUID()}`],
    );
    await dataSource.query(
      `INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
      [tenantA.id, restricted.id, noPermRole.id],
    );
    const cookie = await login(restrictedEmail);

    const client = connect({ campaignId: campaignAId }, cookie);
    try {
      client.connect();
      await waitForEvent(client, 'disconnect');
      expect(client.connected).toBe(false);
    } finally {
      client.close();
      await dataSource.query('DELETE FROM user_role WHERE user_id = $1', [restricted.id]);
      await dataSource.query('DELETE FROM role WHERE id = $1', [noPermRole.id]);
      await dataSource.getRepository(UserSessionEntity).delete({ userId: restricted.id });
      await dataSource.getRepository(AppUserEntity).delete(restricted.id);
    }
  }, 15_000);

  it('A12: requestedCampaignIds accepts singular and plural handshake shapes', async () => {
    const cookie = await login(operatorA);
    const singular = connect({ campaignId: campaignAId }, cookie);
    const plural = connect({ campaignIds: [campaignAId] }, cookie);
    try {
      singular.connect();
      plural.connect();
      await Promise.all([waitForEvent(singular, 'rt.connection.ready'), waitForEvent(plural, 'rt.connection.ready')]);
      expect(singular.connected).toBe(true);
      expect(plural.connected).toBe(true);
    } finally {
      singular.close();
      plural.close();
    }
  }, 15_000);
});
