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

/**
 * M6-S3 CP3 (BR-HIS-001, BR-HIS-004): GET /campaigns/history -- server
 * filtering, keyset pagination, serverTime, and "no progress before start".
 * Fixtures write campaign_snapshot/campaign_execution rows directly rather
 * than running the real send DAG -- this is a listing test, not a send
 * test, and every long-running fixture in this node parks at
 * campaign.status='paused' where the live worker's own scan does not look
 * (D-118), except the one row that is deliberately 'sending' to prove
 * ordering, which is asserted only by its own tenant-scoped id, never by a
 * global count.
 */
describe('Campaign history HTTP (M6-S3 CP3)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let templateVersionId: string;
  const password = 'correct-horse-battery-staple';
  const viewer = `history-viewer-${randomUUID()}@test.dev`;
  const senderA = randomUUID();
  const senderB = randomUUID();
  const creatorA = randomUUID();
  const creatorB = randomUUID();

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `history-http-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: viewer, displayName: 'History Viewer', role: 'viewer', passwordHash: await hashPassword(password), status: 'active',
    });
    await dataSource.query(
      `INSERT INTO app_user (id, tenant_id, email, display_name, role, password_hash, status)
       VALUES ($1, $2, $3, 'Creator A', 'operator', $4, 'active'), ($5, $2, $6, 'Creator B', 'operator', $4, 'active')`,
      [creatorA, tenant.id, `history-creator-a-${randomUUID()}@test.dev`, await hashPassword(password), creatorB, `history-creator-b-${randomUUID()}@test.dev`],
    );

    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `history-t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1, subject: 'Hi', html: '<p>Hi</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    templateVersionId = version.id;

    await dataSource.query(
      `INSERT INTO sender_config (id, tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, $3, $4, $5, 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_HISTORY_UNUSED', 'verified'),
              ($2, $3, $6, $7, 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_HISTORY_UNUSED', 'verified')`,
      [senderA, senderB, tenant.id, `sender-a-${randomUUID()}`, `sender-a-${randomUUID()}@example.test`, `sender-b-${randomUUID()}`, `sender-b-${randomUUID()}@example.test`],
    );
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_history_http_test_cleanup'))");
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
    await dataSource.query('DELETE FROM outbox_event WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM sender_config WHERE tenant_id = $1', [tenant.id]);
    await deleteTemplateVersionFixtures(dataSource, [tenant.id]);
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  }, 30_000);

  async function login(): Promise<{ cookie: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: viewer, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return { cookie: cookies.map((entry) => entry.split(';')[0]).join('; ') };
  }

  /** Inserts campaign + (optionally) snapshot + execution directly -- this is a listing test, not a send test. */
  async function seedCampaign(options: {
    status: 'scheduled' | 'sending' | 'completed' | 'partial_failed';
    createdBy?: string;
    senderConfigId?: string;
    scheduledAtUtc?: Date;
    startedAt?: Date;
    counts?: { pending: number; queued: number; submitted: number; delivered: number; bounced: number; failed: number; skipped: number; cancelled: number };
  }): Promise<{ campaignId: string; executionId: string | null }> {
    const campaign = await dataSource.getRepository(CampaignEntity).save({
      tenantId: tenant.id, name: `History ${options.status} ${randomUUID()}`, subject: 'Hi', templateVersionId,
      senderJson: {}, audienceJson: {}, settingsJson: {}, status: options.status,
      scheduledAtUtc: options.scheduledAtUtc ?? null, scheduledTimezone: options.scheduledAtUtc ? 'Asia/Ho_Chi_Minh' : null,
      version: 0, createdBy: options.createdBy ?? null,
    });

    if (options.status === 'scheduled') return { campaignId: campaign.id, executionId: null };

    const [snapshot] = await dataSource.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 10, 10, 0) RETURNING id`,
      [tenant.id, campaign.id, templateVersionId],
    );
    const c = options.counts ?? { pending: 0, queued: 0, submitted: 0, delivered: 8, bounced: 0, failed: 2, skipped: 0, cancelled: 0 };
    const [execution] = await dataSource.query(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, status, correlation_id, sender_config_id, started_at,
                                        pending_count, queued_count, submitted_count, delivered_count, bounced_count, failed_count, skipped_count, cancelled_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [tenant.id, campaign.id, snapshot.id, options.status === 'partial_failed' ? 'partial_failed' : options.status === 'completed' ? 'completed' : 'sending',
       `history-${randomUUID()}`, options.senderConfigId ?? null, options.startedAt ?? new Date(),
       c.pending, c.queued, c.submitted, c.delivered, c.bounced, c.failed, c.skipped, c.cancelled],
    );
    return { campaignId: campaign.id, executionId: execution.id as string };
  }

  async function seedRecipientResult(campaignId: string, executionId: string, options: { email: string; status: 'delivered' | 'failed'; errorCode?: string; errorClass?: string; reason?: string }) {
    const [snapshot] = await dataSource.query('SELECT snapshot_id FROM campaign_execution WHERE id = $1', [executionId]);
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: options.email });
    const [campaignRecipient] = await dataSource.query(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, recipient_email, merge_data_json, email_snapshot, eligibility, status, execution_id, attempt_count)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'sendable', $8, $9, 1) RETURNING id`,
      [tenant.id, campaignId, snapshot.snapshot_id, recipient.id, options.email, JSON.stringify({ email: options.email, first_name: 'Minh', last_name: 'An' }), JSON.stringify({ subject: 'Hi', html: '<p>Hi</p>', textBody: 'Hi' }), options.status, executionId],
    );
    await dataSource.query(
      `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, provider_message_id, error_code, error_class, provider_response, content_hash)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`,
      [tenant.id, executionId, campaignRecipient.id, options.status === 'delivered' ? 'submitted' : 'permanent_error', options.status === 'delivered' ? `<${randomUUID()}@example.test>` : null, options.errorCode ?? null, options.errorClass ?? null, options.reason ?? null, createHash('sha256').update(options.email).digest('hex')],
    );
    if (options.status === 'delivered') {
      await dataSource.query(
        `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, outcome, payload)
         VALUES ($1, 'smtp', $2, 'delivered', $3, $4, $5, now(), 'applied', '{}'::jsonb)`,
        [tenant.id, `event-${randomUUID()}`, `<${randomUUID()}@example.test>`, campaignRecipient.id, executionId],
      );
    }
  }

  it('lists newest-first by default and carries serverTime', async () => {
    const { cookie } = await login();
    const older = await seedCampaign({ status: 'completed', startedAt: new Date(Date.now() - 60_000) });
    const newer = await seedCampaign({ status: 'completed', startedAt: new Date() });

    const before = Date.now();
    const response = await request(app.getHttpServer()).get('/api/v1/campaigns/history').set('Cookie', cookie);
    const after = Date.now();

    expect(response.status).toBe(200);
    expect(response.body.serverTime).toBeDefined();
    const serverTimeMs = Date.parse(response.body.serverTime);
    expect(serverTimeMs).toBeGreaterThanOrEqual(before - 1000);
    expect(serverTimeMs).toBeLessThanOrEqual(after + 1000);

    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids.indexOf(newer.campaignId)).toBeLessThan(ids.indexOf(older.campaignId));
  });

  it('a scheduled campaign has no progress and carries its timezone', async () => {
    const { cookie } = await login();
    const scheduled = await seedCampaign({ status: 'scheduled', scheduledAtUtc: new Date(Date.now() + 3_600_000) });

    const response = await request(app.getHttpServer()).get('/api/v1/campaigns/history').set('Cookie', cookie).query({ status: 'scheduled' });

    expect(response.status).toBe(200);
    const row = response.body.items.find((item: { id: string }) => item.id === scheduled.campaignId);
    expect(row).toBeDefined();
    expect(row.progress).toBeNull();
    expect(row.scheduledTimezone).toBe('Asia/Ho_Chi_Minh');
  });

  it('filters by status', async () => {
    const { cookie } = await login();
    const partial = await seedCampaign({ status: 'partial_failed' });
    const complete = await seedCampaign({ status: 'completed' });

    const response = await request(app.getHttpServer()).get('/api/v1/campaigns/history').set('Cookie', cookie).query({ status: 'partial_failed' });

    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(partial.campaignId);
    expect(ids).not.toContain(complete.campaignId);
  });

  it('filters by dateFrom/dateTo', async () => {
    const { cookie } = await login();
    const inRange = await seedCampaign({ status: 'completed', startedAt: new Date('2026-08-05T12:00:00Z') });
    const outOfRange = await seedCampaign({ status: 'completed', startedAt: new Date('2026-01-01T12:00:00Z') });

    const response = await request(app.getHttpServer()).get('/api/v1/campaigns/history').set('Cookie', cookie)
      .query({ dateFrom: '2026-08-01T00:00:00Z', dateTo: '2026-08-31T23:59:59Z' });

    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(inRange.campaignId);
    expect(ids).not.toContain(outOfRange.campaignId);
  });

  it('filters by senderConfigId', async () => {
    const { cookie } = await login();
    const withA = await seedCampaign({ status: 'completed', senderConfigId: senderA });
    const withB = await seedCampaign({ status: 'completed', senderConfigId: senderB });

    const response = await request(app.getHttpServer()).get('/api/v1/campaigns/history').set('Cookie', cookie).query({ senderConfigId: senderA });

    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(withA.campaignId);
    expect(ids).not.toContain(withB.campaignId);
  });

  it('filters by createdBy', async () => {
    const { cookie } = await login();
    const byA = await seedCampaign({ status: 'completed', createdBy: creatorA });
    const byB = await seedCampaign({ status: 'completed', createdBy: creatorB });

    const response = await request(app.getHttpServer()).get('/api/v1/campaigns/history').set('Cookie', cookie).query({ createdBy: creatorA });

    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(byA.campaignId);
    expect(ids).not.toContain(byB.campaignId);
  });

  it('drills into recipient success, failure and latest provider reason', async () => {
    const { cookie } = await login();
    const seeded = await seedCampaign({ status: 'partial_failed' });
    await seedRecipientResult(seeded.campaignId, seeded.executionId!, { email: `success-${randomUUID()}@example.test`, status: 'delivered' });
    const failedEmail = `failed-${randomUUID()}@example.test`;
    await seedRecipientResult(seeded.campaignId, seeded.executionId!, { email: failedEmail, status: 'failed', errorCode: 'EENVELOPE', errorClass: 'permanent', reason: 'No recipients defined' });

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${seeded.campaignId}/recipients`).set('Cookie', cookie).query({ status: 'failed' });

    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([expect.objectContaining({ email: failedEmail, displayName: 'Minh An', status: 'failed', lastErrorCode: 'EENVELOPE', lastErrorClass: 'permanent', failureReason: 'No recipients defined' })]);
  });

  it('walks a two-page cursor with no overlap and no gap', async () => {
    const { cookie } = await login();
    const seeded = [] as string[];
    for (let i = 0; i < 5; i += 1) {
      const row = await seedCampaign({ status: 'completed', startedAt: new Date(Date.now() - i * 1000) });
      seeded.push(row.campaignId);
    }

    const page1 = await request(app.getHttpServer()).get('/api/v1/campaigns/history').set('Cookie', cookie).query({ limit: 3 });
    expect(page1.body.items.length).toBeGreaterThanOrEqual(3);
    const firstPageIds = page1.body.items.slice(0, 3).map((item: { id: string }) => item.id);
    const cursor = page1.body.items[2].cursor as string;
    expect(cursor).toBeDefined();

    const page2 = await request(app.getHttpServer()).get('/api/v1/campaigns/history').set('Cookie', cookie).query({ limit: 100, cursor });
    const secondPageIds = page2.body.items.map((item: { id: string }) => item.id);

    for (const id of firstPageIds) expect(secondPageIds).not.toContain(id);
    for (const id of seeded) expect([...firstPageIds, ...secondPageIds]).toContain(id);
  });
});
