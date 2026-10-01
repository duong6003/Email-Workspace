import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { IsNull, type DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { testPasswordHash } from './test-password.js';
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
describe('Sending quota HTTP (M7-S1 CP5)', () => {
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
      tenantId: tenant.id, email: operator, displayName: 'Snapshot HTTP Operator', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active',
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
    await dataSource.query('DELETE FROM sender_config WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await deleteTemplateVersionFixtures(dataSource, [tenant.id, otherTenant.id]);
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: otherTenant.id });
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: otherTenant.id });
    // sending_policy.updated_by references app_user, and the cross-tenant PUT
    // case populates it for both tenants, so these rows must go before users.
    await dataSource.query('DELETE FROM quota_reservation WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.query('DELETE FROM quota_threshold_emission WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.query('DELETE FROM sending_policy WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: otherTenant.id });
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
       VALUES ($1, $2, $3, 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_QUOTA_HTTP_UNUSED', 'verified', now()) RETURNING id, from_email`,
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

  it('BR-CFG-006: exhausted quota returns 429 Problem and leaves no hold or queued campaign', async () => {
    const session = await login();
    const first = await draftCampaignWithAudience(session);
    const secondRecipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `snapshot-http-${randomUUID()}@example.test` });
    const [list] = await dataSource.query(`SELECT list_id AS id FROM recipient_list_member WHERE recipient_id = $1`, [first.recipientId]);
    await dataSource.query(`INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1,$2,$3,now(),'manual')`, [tenant.id, list.id, secondRecipient.id]);
    await dataSource.query(`INSERT INTO sending_policy (tenant_id, send_quota_limit, send_quota_period) VALUES ($1,1,'month') ON CONFLICT (tenant_id) DO UPDATE SET send_quota_limit=1, send_quota_period='month'`, [tenant.id]);

    const response = await sendRequest(session, first.campaignId, randomUUID());
    expect(response.status).toBe(429);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 429, title: 'Too Many Requests', code: 'QUOTA_EXCEEDED' });
    expect(typeof response.body.traceId).toBe('string');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect(await dataSource.query(`SELECT id FROM quota_reservation WHERE tenant_id=$1 AND campaign_id=$2 AND state='held'`, [tenant.id, first.campaignId])).toHaveLength(0);
    const [campaign] = await dataSource.query(`SELECT status FROM campaign WHERE id=$1`, [first.campaignId]);
    expect(campaign.status).not.toBe('queued');
  });

  it('BR-CFG-006: cancelling a queued campaign releases rather than deletes its reservation', async () => {
    const session = await login();
    const fixture = await draftCampaignWithAudience(session);
    await dataSource.query(`INSERT INTO sending_policy (tenant_id, send_quota_limit, send_quota_period) VALUES ($1,100,'month') ON CONFLICT (tenant_id) DO UPDATE SET send_quota_limit=100`, [tenant.id]);
    await sendRequest(session, fixture.campaignId, randomUUID()).expect(202);
    const before = await dataSource.query(`SELECT COALESCE(SUM(amount),0)::int AS used FROM quota_reservation WHERE tenant_id=$1 AND state='held'`, [tenant.id]);
    expect(before[0].used).toBeGreaterThan(0);
    await request(app.getHttpServer()).post(`/api/v1/campaigns/${fixture.campaignId}/cancel`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).expect(202);
    const after = await dataSource.query(`SELECT COALESCE(SUM(amount),0)::int AS used FROM quota_reservation WHERE tenant_id=$1 AND state='held'`, [tenant.id]);
    expect(after[0].used).toBe(0);
    const [released] = await dataSource.query(`SELECT state, released_at FROM quota_reservation WHERE tenant_id=$1 AND campaign_id=$2`, [tenant.id, fixture.campaignId]);
    expect(released.state).toBe('released');
    expect(released.released_at).not.toBeNull();
  });

  it('BR-CFG-006: replayed send does not double-reserve', async () => {
    const session = await login();
    const fixture = await draftCampaignWithAudience(session);
    await dataSource.query(`INSERT INTO sending_policy (tenant_id, send_quota_limit, send_quota_period) VALUES ($1,100,'month') ON CONFLICT (tenant_id) DO UPDATE SET send_quota_limit=100`, [tenant.id]);
    const key = randomUUID();
    await sendRequest(session, fixture.campaignId, key).expect(202);
    const replay = await sendRequest(session, fixture.campaignId, key);
    expect([202, 409]).toContain(replay.status);
    expect(await dataSource.query(`SELECT id FROM quota_reservation WHERE tenant_id=$1 AND campaign_id=$2 AND state='held'`, [tenant.id, fixture.campaignId])).toHaveLength(1);
  });

  it('BR-GEN-002: another tenant sees only its own unconfigured quota', async () => {
    const otherEmail = `quota-other-${randomUUID()}@test.dev`;
    await dataSource.getRepository(AppUserEntity).save({ tenantId: otherTenant.id, email: otherEmail, displayName: 'Other Admin', role: 'admin', passwordHash: await testPasswordHash(password), status: 'active' });
    const loginResponse = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: otherEmail, password });
    const cookies = loginResponse.headers['set-cookie'] as unknown as string[];
    const response = await request(app.getHttpServer()).get('/api/v1/sending-quota').set('Cookie', cookies.map((entry) => entry.split(';')[0]).join('; '));
    expect(response.status).toBe(200);
    expect(response.body.limit).toBeNull();
  });

  /**
   * BR-GEN-002 / TC-SEC-009, added by the review session at merge 2.
   *
   * ARCH-CROSS-TENANT (packages/architecture-tests/src/cross-tenant-coverage.test.ts,
   * authored by M7-S2) reported `PUT /sending-quota` and `GET /sending-quota/usage`
   * as uncovered once M7-S1 and M7-S2 were merged together: M7-S1 wrote a
   * cross-tenant negative for `GET /sending-quota` only, and the rule that would
   * have caught the other two did not exist on M7-S1's own branch. Neither node
   * could have seen this alone -- it is exactly the class of gap sequential
   * merge-and-verify exists to find, so the fix is the missing coverage, never a
   * weakened rule (AGENTS.md §5).
   *
   * Asserts the whole write-then-read cycle stays tenant-local: tenant B setting
   * its own quota must not become visible to tenant A, and B's usage view must
   * report B's own (empty) consumption while A holds real reservations.
   */
  it('BR-GEN-002: PUT /sending-quota and GET /sending-quota/usage never cross the tenant boundary', async () => {
    // PUT /sending-quota requires SETTINGS_MANAGE, which BR-AUTH-003 grants to
    // admin only -- this file's login() helper is an operator, so tenant A needs
    // its own admin here rather than reusing that session.
    const ownAdminEmail = `quota-own-admin-${randomUUID()}@test.dev`;
    await dataSource.getRepository(AppUserEntity).save({ tenantId: tenant.id, email: ownAdminEmail, displayName: 'Own Admin', role: 'admin', passwordHash: await testPasswordHash(password), status: 'active' });
    const ownLogin = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: ownAdminEmail, password });
    const ownCookies = ownLogin.headers['set-cookie'] as unknown as string[];
    const session = {
      cookie: ownCookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: ownCookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
    await request(app.getHttpServer())
      .put('/api/v1/sending-quota')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ limit: 500, period: 'month' })
      .expect(200);

    const otherEmail = `quota-write-other-${randomUUID()}@test.dev`;
    await dataSource.getRepository(AppUserEntity).save({ tenantId: otherTenant.id, email: otherEmail, displayName: 'Other Admin', role: 'admin', passwordHash: await testPasswordHash(password), status: 'active' });
    const otherLogin = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: otherEmail, password });
    const otherCookies = otherLogin.headers['set-cookie'] as unknown as string[];
    const otherCookie = otherCookies.map((entry) => entry.split(';')[0]).join('; ');
    const otherCsrf = otherCookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1];

    // Tenant B writes its own quota. It must not read back tenant A's 500.
    await request(app.getHttpServer())
      .put('/api/v1/sending-quota')
      .set('Cookie', otherCookie).set('x-csrf-token', otherCsrf)
      .send({ limit: 7, period: 'day' })
      .expect(200);

    const otherRead = await request(app.getHttpServer()).get('/api/v1/sending-quota').set('Cookie', otherCookie).expect(200);
    expect(otherRead.body.limit).toBe(7);
    expect(otherRead.body.period).toBe('day');

    const ownRead = await request(app.getHttpServer()).get('/api/v1/sending-quota').set('Cookie', session.cookie).expect(200);
    expect(ownRead.body.limit).toBe(500);

    // Usage is tenant-local too: tenant A's held reservations are invisible to B.
    const otherUsage = await request(app.getHttpServer()).get('/api/v1/sending-quota/usage').set('Cookie', otherCookie).expect(200);
    expect(otherUsage.body.limit).toBe(7);
    expect(otherUsage.body.used).toBe(0);
    expect(JSON.stringify(otherUsage.body)).not.toContain(tenant.id);
  });
});
