import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { In, type DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { RecipientListEntity } from '../../src/database/entities/recipient-list.entity.js';
import { EmailTemplateEntity } from '../../src/database/entities/email-template.entity.js';
import { EmailTemplateVersionEntity } from '../../src/database/entities/email-template-version.entity.js';
import { CampaignSnapshotEntity } from '../../src/database/entities/campaign-snapshot.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/** M5-S2 CP3 (BR-SCH-001/002/004/005/008, BR-GEN-003, BR-CMP-010, BR-GEN-005). */
describe('Campaign schedule HTTP (M5-S2 CP3)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let otherTenant: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const operator = `schedule-http-operator-${randomUUID()}@test.dev`;
  let operatorId: string;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `schedule-http-${randomUUID()}` });
    otherTenant = await dataSource.getRepository(TenantEntity).save({ name: `schedule-http-other-${randomUUID()}` });
    const user = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Schedule HTTP Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
    operatorId = user.id;
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_schedule_http_test_cleanup'))");
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
    await dataSource.query('DELETE FROM user_notification WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.query('DELETE FROM notification WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.query('DELETE FROM outbox_event WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.query('DELETE FROM sender_config WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await deleteTemplateVersionFixtures(dataSource, [tenant.id, otherTenant.id]);
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: otherTenant.id });
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: In([tenant.id, otherTenant.id]) });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: In([tenant.id, otherTenant.id]) });
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

  async function draftCampaignWithAudience(session: { cookie: string; csrfToken: string }) {
    const [sender] = await dataSource.query(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status, verified_at)
       VALUES ($1, $2, $3, 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_SCHEDULE_HTTP_UNUSED', 'verified', now()) RETURNING id, from_email`,
      [tenant.id, `sender-${randomUUID()}`, `sender-${randomUUID()}@example.test`],
    );
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1,
      subject: 'Hi {{first_name}}', html: '<p>{{first_name}}</p><a href="ftp://invalid.test/file">Download</a>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    const list = await dataSource.getRepository(RecipientListEntity).save({ tenantId: tenant.id, name: `list-${randomUUID()}` });
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `schedule-http-${randomUUID()}@example.test` });
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenant.id, list.id, recipient.id, 'manual'],
    );
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Schedule http ${randomUUID()}`, subject: version.subject, templateId: template.id, templateVersionId: version.id, sender: { senderConfigId: sender.id, fromEmail: sender.from_email }, audience: { listIds: [list.id] } });
    return { campaignId: created.body.id as string, recipientId: recipient.id };
  }

  async function draftCampaignWithSenderConfig(
    session: { cookie: string; csrfToken: string },
    status: 'pending' | 'failed' | 'disabled' | 'verified',
  ) {
    const [sender] = await dataSource.query(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, $2, $3, 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_SCHEDULE_HTTP_UNUSED', $4) RETURNING id`,
      [tenant.id, `sender-${randomUUID()}`, `sender-${randomUUID()}@example.test`, status],
    );
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1,
      subject: 'Hi', html: '<p>Hi</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    const list = await dataSource.getRepository(RecipientListEntity).save({ tenantId: tenant.id, name: `list-${randomUUID()}` });
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `schedule-sender-${randomUUID()}@example.test` });
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenant.id, list.id, recipient.id, 'manual'],
    );
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({
        name: `Schedule sender ${randomUUID()}`, subject: version.subject, templateId: template.id, templateVersionId: version.id,
        sender: { senderConfigId: sender.id, fromEmail: 'ops@example.test' }, audience: { listIds: [list.id] },
      });
    return { campaignId: created.body.id as string, senderConfigId: sender.id as string };
  }

  /** Ten minutes ahead, well clear of the default 120s lead and lock window. */
  function nearFutureLocalDateTime(): string {
    const d = new Date(Date.now() + 10 * 60 * 1000);
    return d.toISOString().slice(0, 16);
  }

  function scheduleRequest(session: { cookie: string; csrfToken: string }, campaignId: string, body: Record<string, unknown>, idempotencyKey?: string) {
    const req = request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    return (idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req).send(body);
  }

  it('A1/A6: schedules a draft, moves it to scheduled, and returns the resolved UTC instant', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    const localDateTime = nearFutureLocalDateTime();

    const response = await scheduleRequest(session, campaignId, { localDateTime, timeZone: 'UTC' }, randomUUID());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ campaignId, status: 'scheduled', timeZone: 'UTC', totalSnapshot: 1, sendableCount: 1, skippedCount: 0, idempotencyReplayed: false });
    expect(response.body.scheduledAtUtc).toBe(`${localDateTime}:00.000Z`);

    const [row] = await dataSource.query('SELECT status, scheduled_at_utc, scheduled_timezone FROM campaign WHERE id = $1', [campaignId]);
    expect(row.status).toBe('scheduled');
    expect(row.scheduled_timezone).toBe('UTC');
  });

  it('GAP-CMP-004: exposes an authoritative read-only preflight with content and domain warnings', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/preflight`)
      .set('Cookie', session.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      blocking: false,
      name: { valid: true },
      subject: { valid: true },
      sender: { valid: true },
      template: { valid: true },
      audience: { valid: true, totalUnique: 1 },
      quota: { valid: true, requested: 1 },
      domain: { valid: true, warnings: ['DOMAIN_READINESS_UNVERIFIED'] },
    });
    expect(response.body.content.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TEXT_BODY_EMPTY', severity: 'warning', field: 'textBody' }),
      expect.objectContaining({ code: 'LINK_INVALID', severity: 'warning', field: 'html' }),
    ]));
  });

  it('CP6: GET the campaign draft exposes scheduledAtUtc/scheduledTimezone/scheduleLockWindowSeconds once scheduled, and null schedule fields for a draft', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);

    const beforeSchedule = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(beforeSchedule.body).toMatchObject({ scheduledAtUtc: null, scheduledTimezone: null });
    expect(beforeSchedule.body.scheduleLockWindowSeconds).toBe(120);

    const localDateTime = nearFutureLocalDateTime();
    await scheduleRequest(session, campaignId, { localDateTime, timeZone: 'UTC' }, randomUUID());

    const afterSchedule = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(afterSchedule.body).toMatchObject({ status: 'scheduled', scheduledTimezone: 'UTC', scheduleLockWindowSeconds: 120 });
    expect(afterSchedule.body.scheduledAtUtc).toBe(`${localDateTime}:00.000Z`);
  });

  it('A3: refuses an instant inside the minimum lead with 422 carrying minAt/maxAt', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    const tooSoon = new Date(Date.now() + 5000).toISOString().slice(0, 16);

    const response = await scheduleRequest(session, campaignId, { localDateTime: tooSoon, timeZone: 'UTC' }, randomUUID());

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'OUT_OF_SCHEDULE_WINDOW' });
    expect(typeof response.body.minAt).toBe('string');
    expect(typeof response.body.maxAt).toBe('string');
  });

  it('BR-SCH-003: an ambiguous local time is refused 422 with both candidate offsets', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);

    const response = await scheduleRequest(session, campaignId, { localDateTime: '2024-10-27T02:30', timeZone: 'Europe/Berlin' }, randomUUID());

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'AMBIGUOUS_LOCAL_TIME', candidateOffsetMinutes: [60, 120] });
  });

  it('A7: a campaign missing a template is refused 422 with a non-blocking-free validation report and creates no schedule', async () => {
    const session = await login();
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `No template ${randomUUID()}`, sender: { fromEmail: 'ops@example.test' } });
    const campaignId = created.body.id as string;

    const response = await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ blocking: true, template: { valid: false } });
    const [row] = await dataSource.query("SELECT status FROM campaign WHERE id = $1", [campaignId]);
    expect(row.status).toBe('draft');
    void template;
  });

  it('A8: rescheduling outside the lock window supersedes the live snapshot and freezes a new one', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    const first = await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());
    expect(first.status).toBe(202);
    const firstSnapshotId = first.body.snapshotId as string;

    const later = new Date(Date.now() + 20 * 60 * 1000).toISOString().slice(0, 16);
    const second = await scheduleRequest(session, campaignId, { localDateTime: later, timeZone: 'UTC' }, randomUUID());

    expect(second.status).toBe(202);
    expect(second.body.snapshotId).not.toBe(firstSnapshotId);

    const snapshots = await dataSource.getRepository(CampaignSnapshotEntity).find({ where: { campaignId }, order: { frozenAt: 'ASC' } });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].id).toBe(firstSnapshotId);
    expect(snapshots[0].supersededAt).not.toBeNull();
    expect(snapshots[1].supersededAt).toBeNull();
  });

  it('A9: a schedule mutation inside the lock window returns 409', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    const soon = new Date(Date.now() + 60 * 1000).toISOString().slice(0, 16);
    // Bypass the service's own lead check by writing the near-due schedule directly, to isolate the lock-window assertion from A3's lead check.
    await dataSource.query(
      "UPDATE campaign SET status = 'scheduled', scheduled_at_utc = $2, scheduled_timezone = 'UTC' WHERE id = $1",
      [campaignId, new Date(Date.now() + 60 * 1000)],
    );
    await dataSource.query(
      "INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count) SELECT tenant_id, id, template_version_id, sender_json, audience_json, '{}'::jsonb, 1, 1, 0 FROM campaign WHERE id = $1",
      [campaignId],
    );

    const response = await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());

    expect(response.status).toBe(409);
    void soon;
  });

  it('A14: cancelling a scheduled campaign moves it to cancelled, clears the schedule, and audits it', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/schedule/cancel`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send();

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ campaignId, status: 'cancelled' });
    const [row] = await dataSource.query('SELECT status, scheduled_at_utc, scheduled_timezone FROM campaign WHERE id = $1', [campaignId]);
    expect(row.status).toBe('cancelled');
    expect(row.scheduled_at_utc).toBeNull();
    expect(row.scheduled_timezone).toBeNull();
    const [audit] = await dataSource.query("SELECT action FROM audit_log WHERE entity_type = 'campaign' AND entity_id = $1 AND action = 'schedule.cancelled'", [campaignId]);
    expect(audit).toBeDefined();
  });

  it('A17: two concurrent schedule requests with the same Idempotency-Key create exactly one schedule', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    const key = randomUUID();
    const body = { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' };

    const [first, second] = await Promise.all([
      scheduleRequest(session, campaignId, body, key),
      scheduleRequest(session, campaignId, body, key),
    ]);

    for (const response of [first, second]) expect([202, 409]).toContain(response.status);
    const succeeded = [first, second].filter((response) => response.status === 202);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    if (succeeded.length === 2) expect(succeeded[0]!.body.snapshotId).toBe(succeeded[1]!.body.snapshotId);

    const snapshots = await dataSource.getRepository(CampaignSnapshotEntity).find({ where: { campaignId } });
    expect(snapshots).toHaveLength(1);
  });

  it('A17: the same Idempotency-Key with a materially different payload returns 409', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    const key = randomUUID();

    const first = await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, key);
    expect(first.status).toBe(202);

    const later = new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 16);
    const second = await scheduleRequest(session, campaignId, { localDateTime: later, timeZone: 'UTC' }, key);
    expect(second.status).toBe(409);
  });

  it('rejects with 400 when the Idempotency-Key header is missing', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);

    const response = await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' });

    expect(response.status).toBe(400);
  });

  it('A18: a scheduled campaign is unreschedulable and unclaimable from another tenant', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);
    await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());

    const otherOperator = `schedule-http-other-${randomUUID()}@test.dev`;
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: otherTenant.id, email: otherOperator, displayName: 'Other tenant operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
    const otherLogin = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: otherOperator, password });
    const otherCookies = otherLogin.headers['set-cookie'] as unknown as string[];
    const otherSession = {
      cookie: otherCookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: otherCookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };

    const response = await scheduleRequest(otherSession, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());
    expect(response.status).toBe(404);
  });

  it('BR-SCH-010: schedule creation writes a notification for the campaign owner', async () => {
    const session = await login();
    const { campaignId } = await draftCampaignWithAudience(session);

    await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());

    const rows = await dataSource.query(
      `SELECT n.body, n.params_json FROM notification n
       JOIN user_notification un ON un.notification_id = n.id
       WHERE n.tenant_id = $1 AND un.user_id = $2 AND n.message_key = 'schedule.created'`,
      [tenant.id, operatorId],
    ) as Array<{ body: string; params_json: Record<string, unknown> }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].body).not.toMatch(/smtp|secret|password/i);
  });

  it('BR-CFG-002: a pending, failed or disabled sender blocks the schedule 422 with SENDER_NOT_VERIFIED and creates no schedule', async () => {
    const session = await login();
    for (const status of ['pending', 'failed', 'disabled'] as const) {
      const { campaignId } = await draftCampaignWithSenderConfig(session, status);

      const response = await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ blocking: true, sender: { valid: false, reason: 'SENDER_NOT_VERIFIED' } });
      const [row] = await dataSource.query('SELECT status, scheduled_at_utc FROM campaign WHERE id = $1', [campaignId]);
      expect(row).toMatchObject({ status: 'draft', scheduled_at_utc: null });
    }
  });

  it('BR-CFG-002: the same campaign schedules once its sender reaches verified', async () => {
    const session = await login();
    const { campaignId, senderConfigId } = await draftCampaignWithSenderConfig(session, 'pending');
    const blocked = await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());
    expect(blocked.status).toBe(422);

    await dataSource.query("UPDATE sender_config SET status = 'verified', verified_at = now() WHERE id = $1", [senderConfigId]);
    const allowed = await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());

    expect(allowed.status).toBe(202);
    const [row] = await dataSource.query('SELECT status FROM campaign WHERE id = $1', [campaignId]);
    expect(row.status).toBe('scheduled');
  });
});
