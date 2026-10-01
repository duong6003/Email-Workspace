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
 * M5-S3 CP6 (BR-SEND-002/010, A2/A18/A19). cancelCampaignSend and the real
 * getCampaignProgress replacing campaigns.service.ts's fabricated mock
 * (D-92) -- both wired for real over HTTP.
 */
describe('Campaign send HTTP (M5-S3 CP6)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const operator = `send-http-operator-${randomUUID()}@test.dev`;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `send-http-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Send HTTP Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_send_http_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        // M5-S4 CP1 (R7): delivery_event.campaign_recipient_id is NOT NULL
        // REFERENCES campaign_recipient(id) -- delete it before that table,
        // the same FK-ordering class D-93 already produced once.
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

  async function login(): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: operator, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return {
      cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
  }

  async function draftCampaignWithSender(status: 'pending' | 'failed' | 'disabled' | 'verified') {
    const [sender] = await dataSource.query(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, $2, $3, 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_SEND_HTTP_UNUSED', $4) RETURNING id`,
      [tenant.id, `sender-${randomUUID()}`, `sender-${randomUUID()}@example.test`, status],
    );
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1, subject: 'Hi', html: '<p>Hi</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    const recipient = await dataSource.getRepository(RecipientEntity).save({
      tenantId: tenant.id, email: `send-sender-${randomUUID()}@example.test`,
    });
    const campaign = await dataSource.getRepository(CampaignEntity).save({
      tenantId: tenant.id, name: `Send sender ${randomUUID()}`, subject: version.subject, templateVersionId: version.id,
      senderJson: { senderConfigId: sender.id, fromEmail: 'ops@example.test' }, audienceJson: { recipientIds: [recipient.id] }, settingsJson: {},
      status: 'draft', version: 0,
    });
    return { campaignId: campaign.id as string, senderConfigId: sender.id as string };
  }

  async function sendingCampaignFixture(recipientStatuses: Array<{ eligibility: 'sendable' | 'skipped'; status: string }>) {
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1, subject: 'Hi', html: '<p>Hi</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    const campaign = await dataSource.getRepository(CampaignEntity).save({
      tenantId: tenant.id, name: `Send http ${randomUUID()}`, templateVersionId: version.id,
      senderJson: { fromEmail: 'ops@example.test' }, audienceJson: {}, settingsJson: {}, status: 'sending', version: 0,
    });
    const [snapshot] = await dataSource.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, $5, $6) RETURNING id`,
      [tenant.id, campaign.id, version.id, recipientStatuses.length,
        recipientStatuses.filter((r) => r.eligibility === 'sendable').length,
        recipientStatuses.filter((r) => r.eligibility === 'skipped').length],
    );
    const [execution] = await dataSource.query(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status) VALUES ($1, $2, $3, $4, 'sending') RETURNING id`,
      [tenant.id, campaign.id, snapshot.id, `send-http-${randomUUID()}`],
    );
    for (const row of recipientStatuses) {
      const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `send-http-${randomUUID()}@example.test` });
      await dataSource.query(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, eligibility, skipped_reason, status, execution_id)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7, $8)`,
        [tenant.id, campaign.id, snapshot.id, recipient.id, row.eligibility, row.eligibility === 'skipped' ? 'status_bounced' : null, row.status, execution.id],
      );
    }
    return { campaignId: campaign.id as string, executionId: execution.id as string };
  }

  it('A18: cancelling a sending campaign moves pending to cancelled, leaves submitted untouched, reports both separately', async () => {
    const session = await login();
    const { campaignId } = await sendingCampaignFixture([
      { eligibility: 'sendable', status: 'submitted' },
      { eligibility: 'sendable', status: 'pending' },
      { eligibility: 'sendable', status: 'queued' },
    ]);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send/cancel`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ campaignId, status: 'cancelled', submittedCount: 1, cancelledCount: 2 });
    const campaign = await dataSource.getRepository(CampaignEntity).findOneOrFail({ where: { id: campaignId } });
    expect(campaign.status).toBe('cancelled');
    const rows = await dataSource.query('SELECT status FROM campaign_recipient WHERE campaign_id = $1 ORDER BY status', [campaignId]);
    expect(rows.map((r: { status: string }) => r.status).sort()).toEqual(['cancelled', 'cancelled', 'submitted']);
  });

  it('D-125 (M6-S3 CP7): reports the real cancelled count, not always 2 -- one cancellable row', async () => {
    const session = await login();
    const { campaignId } = await sendingCampaignFixture([
      { eligibility: 'sendable', status: 'submitted' },
      { eligibility: 'sendable', status: 'pending' },
    ]);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send/cancel`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ campaignId, status: 'cancelled', submittedCount: 1, cancelledCount: 1 });
  });

  it('D-125 (M6-S3 CP7): reports zero cancelled when nothing was cancellable, not always 2', async () => {
    const session = await login();
    const { campaignId } = await sendingCampaignFixture([
      { eligibility: 'sendable', status: 'submitted' },
    ]);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send/cancel`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ campaignId, status: 'cancelled', submittedCount: 1, cancelledCount: 0 });
  });

  it('rejects with 400 when the Idempotency-Key header is missing', async () => {
    const session = await login();
    const { campaignId } = await sendingCampaignFixture([{ eligibility: 'sendable', status: 'pending' }]);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send/cancel`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);

    expect(response.status).toBe(400);
  });

  it('refuses to cancel with 409 when the campaign is not sending', async () => {
    const session = await login();
    const { campaignId } = await sendingCampaignFixture([{ eligibility: 'sendable', status: 'submitted' }]);
    await dataSource.getRepository(CampaignEntity).update({ id: campaignId }, { status: 'completed' });

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send/cancel`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(409);
  });

  it('A19: GET /progress returns real per-status counts summing to totalSnapshot (D-92)', async () => {
    const session = await login();
    const { campaignId } = await sendingCampaignFixture([
      { eligibility: 'sendable', status: 'submitted' },
      { eligibility: 'sendable', status: 'failed' },
      { eligibility: 'sendable', status: 'pending' },
      { eligibility: 'skipped', status: 'skipped' },
    ]);

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/progress`)
      .set('Cookie', session.cookie);

    expect(response.status).toBe(200);
    expect(response.body.totalSnapshot).toBe(4);
    const counts = response.body.counts as Record<string, number>;
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(4);
    expect(counts.submitted).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.pending).toBe(1);
    expect(counts.skipped).toBe(1);
  });

  it('M6-S1 CP8 (A3, A5): GET /progress carries percent, actionable, progressSeq and a real eta shape', async () => {
    const session = await login();
    const { campaignId } = await sendingCampaignFixture([
      { eligibility: 'sendable', status: 'submitted' },
      { eligibility: 'sendable', status: 'failed' },
      { eligibility: 'sendable', status: 'pending' },
      { eligibility: 'skipped', status: 'skipped' },
    ]);

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/progress`)
      .set('Cookie', session.cookie);

    expect(response.status).toBe(200);
    expect(response.body.actionable).toBe(3);
    expect(response.body.percent).toBeGreaterThanOrEqual(0);
    expect(response.body.percent).toBeLessThanOrEqual(100);
    expect(response.body.progressSeq).toBe(0);
    // No message_attempt rows exist for this fixture -- below ETA_MIN_SAMPLES,
    // so BR-SEND-005's "chưa đủ dữ liệu hiển thị đang ước tính" applies.
    expect(response.body.eta).toEqual({ state: 'estimating' });
  });

  it('M6-S1 CP8 (A5): GET /progress eta is null once every actionable recipient is terminal', async () => {
    const session = await login();
    const { campaignId } = await sendingCampaignFixture([
      { eligibility: 'sendable', status: 'submitted' },
      { eligibility: 'sendable', status: 'delivered' },
    ]);

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/progress`)
      .set('Cookie', session.cookie);

    expect(response.status).toBe(200);
    expect(response.body.eta).toBeNull();
  });

  it('GET /progress 404s when the campaign does not exist', async () => {
    const session = await login();

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${randomUUID()}/progress`)
      .set('Cookie', session.cookie);

    expect(response.status).toBe(404);
  });

  it('A14/D-105: sent, delivered and failed never decrease across submit -> deliver -> bounce, while counts still sums to totalSnapshot at every step', async () => {
    const session = await login();
    const { campaignId } = await sendingCampaignFixture([
      { eligibility: 'sendable', status: 'pending' },
      { eligibility: 'sendable', status: 'pending' },
    ]);
    const recipientRows = await dataSource.query(
      `SELECT id FROM campaign_recipient WHERE campaign_id = $1 ORDER BY id`, [campaignId],
    ) as Array<{ id: string }>;
    const [recipientA, recipientB] = recipientRows;

    async function progress(): Promise<{ sent: number; delivered: number; failed: number; counts: Record<string, number> }> {
      const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/progress`).set('Cookie', session.cookie);
      expect(response.status).toBe(200);
      const sum = Object.values(response.body.counts as Record<string, number>).reduce((a: number, b: number) => a + b, 0);
      expect(sum).toBe(response.body.totalSnapshot);
      return { sent: response.body.sent, delivered: response.body.delivered, failed: response.body.failed, counts: response.body.counts };
    }

    const steps: Array<{ sent: number; delivered: number; failed: number }> = [];
    steps.push(await progress());

    // recipient A: pending -> submitted -> delivered (D-105's own bug: the
    // old rollup was `sent: counts.submitted`, which drops to 0 the instant
    // this row leaves 'submitted' for 'delivered' -- exactly the regression
    // this test exists to catch. This test MUST fail against the
    // pre-D-105-fix code; if it passes unmodified, the D-105 finding itself
    // is wrong and must be re-examined before campaigns.service.ts changes.
    await dataSource.query(`UPDATE campaign_recipient SET status = 'submitted' WHERE id = $1`, [recipientA.id]);
    steps.push(await progress());
    await dataSource.query(`UPDATE campaign_recipient SET status = 'delivered', delivery_state_at = now() WHERE id = $1`, [recipientA.id]);
    steps.push(await progress());

    // recipient B: pending -> submitted -> bounced
    await dataSource.query(`UPDATE campaign_recipient SET status = 'submitted' WHERE id = $1`, [recipientB.id]);
    steps.push(await progress());
    await dataSource.query(`UPDATE campaign_recipient SET status = 'bounced', delivery_state_at = now() WHERE id = $1`, [recipientB.id]);
    steps.push(await progress());

    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i].sent, `sent decreased at step ${i}: ${JSON.stringify(steps)}`).toBeGreaterThanOrEqual(steps[i - 1].sent);
      expect(steps[i].delivered, `delivered decreased at step ${i}: ${JSON.stringify(steps)}`).toBeGreaterThanOrEqual(steps[i - 1].delivered);
      expect(steps[i].failed, `failed decreased at step ${i}: ${JSON.stringify(steps)}`).toBeGreaterThanOrEqual(steps[i - 1].failed);
    }
    // The final state, checked exactly: both messages left the building
    // (sent=2, counting the bounced one too -- BR-SEND-002's own "sent" and
    // "failed" are two different questions about the same event, not two
    // slices of one partition), one delivered, one failed (the bounce).
    const final = steps[steps.length - 1];
    expect({ sent: final.sent, delivered: final.delivered, failed: final.failed }).toEqual({ sent: 2, delivered: 1, failed: 1 });
  });

  it('BR-CFG-002/D-112: POST /send refuses 422 SENDER_NOT_VERIFIED for a pending, failed or disabled sender and freezes no snapshot', async () => {
    const session = await login();
    for (const status of ['pending', 'failed', 'disabled'] as const) {
      const { campaignId } = await draftCampaignWithSender(status);

      const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send`)
        .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
        .set('Idempotency-Key', randomUUID()).send({});

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'SENDER_NOT_VERIFIED' });
      const [row] = await dataSource.query('SELECT status FROM campaign WHERE id = $1', [campaignId]);
      expect(row.status).toBe('draft');
      const snapshots = await dataSource.query('SELECT 1 FROM campaign_snapshot WHERE campaign_id = $1', [campaignId]);
      expect(snapshots).toHaveLength(0);
    }
  });

  it('BR-CFG-002: POST /send accepts the same campaign once its sender is verified', async () => {
    const session = await login();
    const { campaignId, senderConfigId } = await draftCampaignWithSender('pending');
    await dataSource.query("UPDATE sender_config SET status = 'verified', verified_at = now() WHERE id = $1", [senderConfigId]);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', randomUUID()).send({});

    expect(response.status).toBe(202);
    const [row] = await dataSource.query('SELECT status FROM campaign WHERE id = $1', [campaignId]);
    expect(row.status).toBe('queued');
  });
});
