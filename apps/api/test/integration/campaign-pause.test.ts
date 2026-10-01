import { createHash, randomUUID } from 'node:crypto';
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
import { EmailTemplateEntity } from '../../src/database/entities/email-template.entity.js';
import { EmailTemplateVersionEntity } from '../../src/database/entities/email-template-version.entity.js';
import { CampaignEntity } from '../../src/database/entities/campaign.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/** M6-S3 CP5 (BR-SEND-009, ADR-027). POST /campaigns/:id/pause and /resume. */
describe('Campaign pause/resume HTTP (M6-S3 CP5)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const operator = `pause-operator-${randomUUID()}@test.dev`;
  const viewer = `pause-viewer-${randomUUID()}@test.dev`;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `pause-http-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Pause Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: viewer, displayName: 'Pause Viewer', role: 'viewer', passwordHash: await hashPassword(password), status: 'active',
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_pause_http_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        await manager.query('DELETE FROM delivery_event WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM message_attempt WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign_execution WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign_recipient WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign_snapshot WHERE tenant_id = $1', [tenant.id]);
      } finally {
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
        await manager.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      }
    });
    // audit_log is immutable (BR-SEC-002 trigger, no DELETE permitted ever)
    // -- this fixture's pause/resume audit rows are left in place, matching
    // this run's own established norm for every prior probe tenant.
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = $1', [tenant.id]);
    await deleteTemplateVersionFixtures(dataSource, [tenant.id]);
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  }, 30_000);

  async function login(email: string): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return {
      cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
  }

  async function sendingCampaignFixture(status: 'sending' | 'paused' | 'completed' = 'sending'): Promise<{ campaignId: string; executionId: string }> {
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1, subject: 'Hi', html: '<p>Hi</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    const campaign = await dataSource.getRepository(CampaignEntity).save({
      tenantId: tenant.id, name: `Pause http ${randomUUID()}`, templateVersionId: version.id,
      senderJson: { fromEmail: 'ops@example.test' }, audienceJson: {}, settingsJson: {}, status, version: 0,
    });
    const [snapshot] = await dataSource.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, 0) RETURNING id`,
      [tenant.id, campaign.id, version.id],
    );
    const [execution] = await dataSource.query(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenant.id, campaign.id, snapshot.id, `pause-http-${randomUUID()}`, status],
    );
    return { campaignId: campaign.id as string, executionId: execution.id as string };
  }

  it('pauses a sending campaign, moving both campaign and execution status, and audits it', async () => {
    const session = await login(operator);
    const { campaignId, executionId } = await sendingCampaignFixture('sending');

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/pause`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ campaignId, status: 'paused' });
    const campaign = await dataSource.getRepository(CampaignEntity).findOneOrFail({ where: { id: campaignId } });
    expect(campaign.status).toBe('paused');
    const [execution] = await dataSource.query('SELECT status FROM campaign_execution WHERE id = $1', [executionId]);
    expect(execution.status).toBe('paused');
    const [audit] = await dataSource.query(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'campaign_send.paused'`,
      [tenant.id, campaignId],
    );
    expect(audit).toBeDefined();
  });

  it('refuses to pause with 409 when the campaign is not sending', async () => {
    const session = await login(operator);
    const { campaignId } = await sendingCampaignFixture('completed');

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/pause`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(409);
  });

  it('refuses a viewer with 403', async () => {
    const session = await login(viewer);
    const { campaignId } = await sendingCampaignFixture('sending');

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/pause`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(403);
  });

  it('resumes a paused campaign back to sending and audits it', async () => {
    const session = await login(operator);
    const { campaignId, executionId } = await sendingCampaignFixture('paused');

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/resume`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ campaignId, status: 'sending' });
    const campaign = await dataSource.getRepository(CampaignEntity).findOneOrFail({ where: { id: campaignId } });
    expect(campaign.status).toBe('sending');
    const [execution] = await dataSource.query('SELECT status FROM campaign_execution WHERE id = $1', [executionId]);
    expect(execution.status).toBe('sending');
    const [audit] = await dataSource.query(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'campaign_send.resumed'`,
      [tenant.id, campaignId],
    );
    expect(audit).toBeDefined();
  });

  it('refuses to resume with 409 when the campaign is not paused', async () => {
    const session = await login(operator);
    const { campaignId } = await sendingCampaignFixture('sending');

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/resume`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(409);
  });
});
