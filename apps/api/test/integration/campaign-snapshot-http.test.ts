import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { IsNull, type DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { RecipientListEntity } from '../../src/database/entities/recipient-list.entity.js';
import { EmailTemplateEntity } from '../../src/database/entities/email-template.entity.js';
import { EmailTemplateVersionEntity } from '../../src/database/entities/email-template-version.entity.js';
import { CampaignEntity } from '../../src/database/entities/campaign.entity.js';
import { CampaignSnapshotEntity } from '../../src/database/entities/campaign-snapshot.entity.js';
import { CampaignRecipientEntity } from '../../src/database/entities/campaign-recipient.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/**
 * M4-S4 CP3 (BR-CMP-007, BR-CMP-010, BR-GEN-005, BR-CF-008). sendCampaign /
 * cancelCampaign / getCampaignSnapshot wired for real: idempotent freeze,
 * cancel-to-refresh, and the read surface the frozen banner uses.
 */
describe('Campaign snapshot HTTP (M4-S4 CP3)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let otherTenant: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const operator = `snapshot-http-operator-${randomUUID()}@test.dev`;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `snapshot-http-${randomUUID()}` });
    otherTenant = await dataSource.getRepository(TenantEntity).save({ name: `snapshot-http-other-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Snapshot HTTP Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_snapshot_http_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        // M5-S3 CP3: a concurrently-running campaign-send-scan can freeze
        // one of these campaigns the instant it reaches 'queued'.
        await manager.query('DELETE FROM message_attempt WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
        await manager.query('DELETE FROM campaign_execution WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
        await manager.query('DELETE FROM campaign_recipient WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
        await manager.query('DELETE FROM campaign_snapshot WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
      } finally {
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
        await manager.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      }
    });
    await dataSource.query('DELETE FROM outbox_event WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await deleteTemplateVersionFixtures(dataSource, [tenant.id, otherTenant.id]);
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: otherTenant.id });
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenant.id });
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

  async function draftCampaignWithAudience(session: { cookie: string; csrfToken: string }, opts: { requiredKey?: string } = {}) {
    const [sender] = await dataSource.query(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status, verified_at)
       VALUES ($1, $2, $3, 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_SNAPSHOT_HTTP_UNUSED', 'verified', now()) RETURNING id, from_email`,
      [tenant.id, `sender-${randomUUID()}`, `sender-${randomUUID()}@example.test`],
    );
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const schema = opts.requiredKey ? { required: [opts.requiredKey], optional: [] } : { required: [], optional: [] };
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1,
      subject: 'Hi {{first_name}}', html: '<p>{{first_name}}</p>', textBody: '',
      requiredVariables: schema.required, variableSchemaJson: schema,
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    const list = await dataSource.getRepository(RecipientListEntity).save({ tenantId: tenant.id, name: `list-${randomUUID()}` });
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `snapshot-http-${randomUUID()}@example.test` });
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenant.id, list.id, recipient.id, 'manual'],
    );
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Snapshot http ${randomUUID()}`, subject: version.subject, templateId: template.id, templateVersionId: version.id, sender: { senderConfigId: sender.id, fromEmail: sender.from_email }, audience: { listIds: [list.id] } });
    return { campaignId: created.body.id as string, recipientId: recipient.id };
  }

  function sendRequest(session: { cookie: string; csrfToken: string }, campaignId: string, idempotencyKey?: string) {
    const req = request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    return idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req;
  }

  it('A1/A12: freezes and returns a CampaignSnapshotAccepted body, moving the campaign to queued', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);

    const response = await sendRequest(session, campaignId, randomUUID());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ campaignId, status: 'queued', totalSnapshot: 1, sendableCount: 1, skippedCount: 0, idempotencyReplayed: false });
    expect(typeof response.body.snapshotId).toBe('string');
  });

  it('A11: rejects with 400 when the Idempotency-Key header is missing', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);

    const response = await sendRequest(session, campaignId);

    expect(response.status).toBe(400);
  });

  it('BR-GEN-005 replay: the same key and payload returns the same snapshotId with idempotencyReplayed true, without creating a second snapshot', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    const key = randomUUID();

    const first = await sendRequest(session, campaignId, key);
    expect(first.status).toBe(202);
    const replay = await sendRequest(session, campaignId, key);
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({ snapshotId: first.body.snapshotId, idempotencyReplayed: true });

    const rows = await dataSource.getRepository(CampaignSnapshotEntity).find({ where: { campaignId } });
    expect(rows).toHaveLength(1);
  });

  it('A10: the same Idempotency-Key with a materially different payload returns 409', async () => {
    const session = await login();
    const { campaignId: campaignA } = await draftCampaignWithAudience(session);
    const { campaignId: campaignB } = await draftCampaignWithAudience(session);
    const key = randomUUID();

    const first = await sendRequest(session, campaignA, key);
    expect(first.status).toBe(202);

    const second = await sendRequest(session, campaignB, key);
    expect(second.status).toBe(409);
  });

  it('A9: two genuinely concurrent sends with the same Idempotency-Key never produce a second snapshot', async () => {
    // IdempotencyService's own documented concurrency contract (idempotency.service.ts):
    // INSERT ... ON CONFLICT DO NOTHING is the mutex that prevents a second
    // snapshot, but the request that loses the race window (arrives after the
    // winner's placeholder insert but before its freeze finishes) is told 409
    // "already being processed" rather than made to wait for the winner's
    // result. The guarantee under test is singularity of the created resource,
    // not that both concurrent responses succeed identically.
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    const key = randomUUID();

    const [first, second] = await Promise.all([
      sendRequest(session, campaignId, key),
      sendRequest(session, campaignId, key),
    ]);

    for (const response of [first, second]) expect([202, 409]).toContain(response.status);
    const succeeded = [first, second].filter((response) => response.status === 202);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    if (succeeded.length === 2) expect(succeeded[0]!.body.snapshotId).toBe(succeeded[1]!.body.snapshotId);

    const rows = await dataSource.getRepository(CampaignSnapshotEntity).find({ where: { campaignId } });
    expect(rows).toHaveLength(1);
    const recipientRows = await dataSource.getRepository(CampaignRecipientEntity).find({ where: { campaignId } });
    expect(recipientRows).toHaveLength(1);
  });

  it('refuses to freeze with 409 when the campaign is not a draft', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    const first = await sendRequest(session, campaignId, randomUUID());
    expect(first.status).toBe(202);

    const response = await sendRequest(session, campaignId, randomUUID());

    expect(response.status).toBe(409);
  });

  it('A15: refuses to freeze with 422 when a required variable is missing and no waiver covers it', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session, { requiredKey: 'city' });

    const response = await sendRequest(session, campaignId, randomUUID());

    expect(response.status).toBe(422);
  });

  it('A13: cancelling a queued campaign returns it to draft, supersedes the snapshot, and a subsequent freeze creates a new one', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    const first = await sendRequest(session, campaignId, randomUUID());
    const firstSnapshotId = first.body.snapshotId as string;

    const cancelResponse = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/cancel`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(cancelResponse.status).toBe(202);
    expect(cancelResponse.body.status).toBe('draft');

    const draftAfterCancel = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}`).set('Cookie', session.cookie);
    expect(draftAfterCancel.body.status).toBe('draft');

    const supersededSnapshot = await dataSource.getRepository(CampaignSnapshotEntity).findOneOrFail({ where: { id: firstSnapshotId } });
    expect(supersededSnapshot.supersededAt).not.toBeNull();
    const supersededRecipients = await dataSource.getRepository(CampaignRecipientEntity).find({ where: { snapshotId: firstSnapshotId } });
    expect(supersededRecipients).toHaveLength(1);

    const second = await sendRequest(session, campaignId, randomUUID());
    expect(second.status).toBe(202);
    expect(second.body.snapshotId).not.toBe(firstSnapshotId);

    const liveSnapshots = await dataSource.getRepository(CampaignSnapshotEntity).find({ where: { campaignId, supersededAt: IsNull() } });
    expect(liveSnapshots).toHaveLength(1);
    expect(liveSnapshots[0]!.id).toBe(second.body.snapshotId);
  });

  it('refuses to cancel with 409 when the campaign is not queued', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/cancel`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);

    expect(response.status).toBe(409);
  });

  it('GET /snapshot returns the live frozen snapshot with a skippedByReason breakdown', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    const sendResponse = await sendRequest(session, campaignId, randomUUID());

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/snapshot`).set('Cookie', session.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: sendResponse.body.snapshotId, campaignId, totalSnapshot: 1, sendableCount: 1, skippedCount: 0, supersededAt: null });
    expect(response.body.skippedByReason).toEqual([]);
  });

  it('GET /snapshot 404s when the campaign has never been frozen', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/snapshot`).set('Cookie', session.cookie);

    expect(response.status).toBe(404);
  });
});
