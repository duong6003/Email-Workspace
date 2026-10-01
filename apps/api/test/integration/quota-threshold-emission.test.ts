import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import type { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { QuotaService } from '../../src/quota/quota.service.js';
import { periodKeyFor } from '../../src/quota/quota-period.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

describe('BR-CFG-006: threshold event and durable notification', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let tenantId: string;
  let freshTenantId: string;
  let adminUserId: string;
  let freshAdminId: string;
  const campaignId = randomUUID();
  const secondCampaignId = randomUUID();
  const thirdCampaignId = randomUUID();
  const periodKey = periodKeyFor(new Date(), 'month');

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    const { AppModule } = await import('../../src/app.module.js');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());

    const tenant = await dataSource.getRepository(TenantEntity).save({ name: `quota-threshold-${randomUUID()}` });
    const freshTenant = await dataSource.getRepository(TenantEntity).save({ name: `quota-threshold-fresh-${randomUUID()}` });
    tenantId = tenant.id;
    freshTenantId = freshTenant.id;
    const passwordHash = await hashPassword('quota-threshold-password');
    const admin = await dataSource.getRepository(AppUserEntity).save({ tenantId, email: `quota-${randomUUID()}@test.dev`, displayName: 'Quota Admin', role: 'admin', passwordHash, status: 'active' });
    const freshAdmin = await dataSource.getRepository(AppUserEntity).save({ tenantId: freshTenantId, email: `quota-fresh-${randomUUID()}@test.dev`, displayName: 'Fresh Quota Admin', role: 'admin', passwordHash, status: 'active' });
    adminUserId = admin.id;
    freshAdminId = freshAdmin.id;
    for (const [currentTenantId, userId] of [[tenantId, adminUserId], [freshTenantId, freshAdminId]]) {
      await dataSource.query(`INSERT INTO user_role (tenant_id, user_id, role_id) SELECT $1, $2, id FROM role WHERE key = 'admin' ON CONFLICT DO NOTHING`, [currentTenantId, userId]);
      await dataSource.query(`INSERT INTO sending_policy (tenant_id, send_quota_limit, send_quota_period) VALUES ($1, 100, 'month')`, [currentTenantId]);
    }
  });

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    const tenants = [tenantId, freshTenantId];
    await dataSource.query(`DELETE FROM user_notification WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await dataSource.query(`DELETE FROM notification WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await dataSource.query(`DELETE FROM outbox_event WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await dataSource.query(`DELETE FROM quota_threshold_emission WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await dataSource.query(`DELETE FROM quota_reservation WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await dataSource.query(`DELETE FROM sending_policy WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await dataSource.query(`DELETE FROM user_role WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await dataSource.query(`DELETE FROM app_user WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await dataSource.query(`DELETE FROM tenant WHERE id = ANY($1::uuid[])`, [tenants]);
    await app.close();
  });

  it('crossing 80 percent writes one outbox event and one notification', async () => {
    const service = moduleRef.get(QuotaService);
    const outcome = await service.reserveForCampaign(null, tenantId, campaignId, null, 80, { actorId: adminUserId });
    expect(outcome.admitted).toBe(true);
    const events = await dataSource.query(`SELECT event_type, payload FROM outbox_event WHERE tenant_id = $1 AND event_type = 'quota.threshold_reached'`, [tenantId]);
    expect(events).toHaveLength(1);
    expect(events[0].payload.threshold).toBe(80);
    const notifications = await dataSource.query(`SELECT type, severity, source_event_id FROM notification WHERE tenant_id = $1 AND type = 'quota_threshold'`, [tenantId]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].severity).toBe('warning');
    expect(notifications[0].source_event_id).toBe(`quota.threshold_reached:${periodKey}:80`);
  });

  it('a second crossing of the same threshold in the same period emits nothing new', async () => {
    await dataSource.query(`UPDATE quota_reservation SET state = 'released', released_at = now() WHERE tenant_id = $1`, [tenantId]);
    const service = moduleRef.get(QuotaService);
    await service.reserveForCampaign(null, tenantId, secondCampaignId, null, 80, { actorId: adminUserId });
    expect(await dataSource.query(`SELECT id FROM outbox_event WHERE tenant_id = $1 AND event_type = 'quota.threshold_reached'`, [tenantId])).toHaveLength(1);
    expect(await dataSource.query(`SELECT id FROM notification WHERE tenant_id = $1 AND type = 'quota_threshold'`, [tenantId])).toHaveLength(1);
  });

  it('one confirmation crossing all thresholds emits three of each', async () => {
    const service = moduleRef.get(QuotaService);
    await service.reserveForCampaign(null, freshTenantId, thirdCampaignId, null, 100, { actorId: freshAdminId });
    const events = await dataSource.query(`SELECT payload FROM outbox_event WHERE tenant_id = $1 AND event_type = 'quota.threshold_reached' ORDER BY (payload->>'threshold')::int`, [freshTenantId]);
    expect(events.map((event: { payload: { threshold: number } }) => event.payload.threshold)).toEqual([80, 90, 100]);
    expect(await dataSource.query(`SELECT id FROM notification WHERE tenant_id = $1 AND type = 'quota_threshold'`, [freshTenantId])).toHaveLength(3);
  });
});
