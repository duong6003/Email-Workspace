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
import { hashPassword } from '../../src/auth/password.service.js';
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
describe('Realtime organization room (M7-S1 CP6)', () => {
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
      tenantId: tenantA.id, email: operatorA, displayName: 'Realtime Campaign A', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenantB.id, email: operatorB, displayName: 'Realtime Campaign B', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
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

  it('BR-CFG-006: authenticated socket receives its tenant quota threshold event', async () => {
    const cookie = await login(operatorA);
    const client = connect({}, cookie);
    try {
      client.connect();
      await waitForEvent(client, 'rt.connection.ready');
      const { Redis } = await import('ioredis');
      const publisher = new Redis(testRedisUrl());
      const envelope = { event_id: randomUUID(), event_type: 'quota.threshold_reached', occurred_at: new Date().toISOString(), tenant_id: tenantA.id, version: 1, data: { threshold: 80 } };
      const received = waitForEvent(client, 'quota.threshold_reached');
      await publisher.publish(`eow:org:${tenantA.id}`, JSON.stringify(envelope));
      expect(await received).toMatchObject({ event_type: 'quota.threshold_reached', tenant_id: tenantA.id });
      await publisher.quit();
    } finally { client.close(); }
  }, 15_000);

  it('BR-GEN-002: authenticated socket never receives another tenant quota event', async () => {
    const cookie = await login(operatorA);
    const client = connect({}, cookie);
    try {
      client.connect();
      await waitForEvent(client, 'rt.connection.ready');
      let leaked = false;
      client.on('quota.threshold_reached', () => { leaked = true; });
      const { Redis } = await import('ioredis');
      const publisher = new Redis(testRedisUrl());
      await publisher.publish(`eow:org:${tenantB.id}`, JSON.stringify({ event_id: randomUUID(), event_type: 'quota.threshold_reached', occurred_at: new Date().toISOString(), tenant_id: tenantB.id, version: 1, data: { threshold: 80 } }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      await publisher.quit();
      expect(leaked).toBe(false);
    } finally { client.close(); }
  }, 15_000);
});
