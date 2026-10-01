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
import { RecipientListEntity } from '../../src/database/entities/recipient-list.entity.js';
import { EmailTemplateEntity } from '../../src/database/entities/email-template.entity.js';
import { EmailTemplateVersionEntity } from '../../src/database/entities/email-template-version.entity.js';
import { CustomFieldDefinitionEntity } from '../../src/database/entities/custom-field-definition.entity.js';
import { CampaignRecipientEntity } from '../../src/database/entities/campaign-recipient.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/**
 * M4-S4 CP4 (BR-CMP-007, BR-TPL-001/012, BR-CF-008). This checkpoint closes
 * the node's headline rules: proves that every kind of write that could
 * plausibly leak into a frozen campaign_recipient/campaign_snapshot row --
 * a live custom-field edit, a list membership change, a template v2
 * publish, a template draft edit, and a direct PATCH of the campaign itself
 * -- provably does not. The service guard (A6) and the DB trigger (already
 * proven in campaign-snapshot-immutability.test.ts, CP1) are exercised as
 * two independent layers, per the plan's own discipline: a pass through one
 * is not evidence for the other.
 */
describe('Post-freeze immutability (M4-S4 CP4)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const operator = `post-freeze-operator-${randomUUID()}@test.dev`;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `post-freeze-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Post Freeze Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
    await dataSource.getRepository(CustomFieldDefinitionEntity).save({ tenantId: tenant.id, fieldKey: 'department', label: 'Department', dataType: 'text', required: false });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_snapshot_post_freeze_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        // M5-S3 CP3: a concurrently-running campaign-send-scan can freeze
        // this test's own campaign the instant it reaches 'queued'.
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
    await dataSource.getRepository(CustomFieldDefinitionEntity).delete({ tenantId: tenant.id });
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = $1', [tenant.id]);
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

  async function freshTemplateVersion() {
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1,
      subject: 'v1 subject for {{first_name}}', html: '<p>v1 body for {{first_name}}</p>', textBody: 'v1 text for {{first_name}}',
      requiredVariables: [], variableSchemaJson: { required: [], optional: ['first_name', 'department'] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    return { template, version };
  }

  /** Builds a real draft, freezes it via the actual HTTP send path, and returns everything a post-freeze assertion needs. */
  async function frozenCampaign(session: { cookie: string; csrfToken: string }) {
    const [sender] = await dataSource.query(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status, verified_at)
       VALUES ($1, $2, $3, 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_POST_FREEZE_UNUSED', 'verified', now()) RETURNING id, from_email`,
      [tenant.id, `sender-${randomUUID()}`, `sender-${randomUUID()}@example.test`],
    );
    const { template, version } = await freshTemplateVersion();
    const list = await dataSource.getRepository(RecipientListEntity).save({ tenantId: tenant.id, name: `list-${randomUUID()}` });
    const recipient = await dataSource.getRepository(RecipientEntity).save({
      tenantId: tenant.id, email: `post-freeze-${randomUUID()}@example.test`, firstName: 'Ada', customData: { department: 'Sales' },
    });
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenant.id, list.id, recipient.id, 'manual'],
    );
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Post freeze ${randomUUID()}`, subject: version.subject, templateId: template.id, templateVersionId: version.id, sender: { senderConfigId: sender.id, fromEmail: sender.from_email }, audience: { listIds: [list.id] } });
    const campaignId = created.body.id as string;

    const sent = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());
    expect(sent.status).toBe(202);

    return { campaignId, snapshotId: sent.body.snapshotId as string, template, version, list, recipient };
  }

  async function frozenRecipientRow(snapshotId: string, recipientId: string) {
    return dataSource.getRepository(CampaignRecipientEntity).findOneOrFail({ where: { snapshotId, recipientId } });
  }

  it('A3: BR-CF-008 -- editing a recipient\'s custom-field data after the freeze leaves merge_data_json and email_snapshot unchanged', async () => {
    const session = await login();
    const { snapshotId, recipient } = await frozenCampaign(session);
    const before = await frozenRecipientRow(snapshotId, recipient.id);

    // TC-CF-013's literal scenario: department 'Sales' -> 'Marketing' after the campaign already snapshotted.
    await dataSource.getRepository(RecipientEntity).save({ ...recipient, customData: { department: 'Marketing' } });

    const after = await frozenRecipientRow(snapshotId, recipient.id);
    expect(after.mergeDataJson).toEqual(before.mergeDataJson);
    expect(after.emailSnapshot).toEqual(before.emailSnapshot);
    expect((after.mergeDataJson as Record<string, unknown>).department).toBe('Sales');
  });

  it('A4: adding a new recipient to, or removing the frozen recipient from, the targeted list does not change the frozen recipient set', async () => {
    const session = await login();
    const { snapshotId, list, recipient } = await frozenCampaign(session);
    const before = await dataSource.getRepository(CampaignRecipientEntity).find({ where: { snapshotId } });

    const newcomer = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `post-freeze-newcomer-${randomUUID()}@example.test` });
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenant.id, list.id, newcomer.id, 'manual'],
    );
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = $1 AND list_id = $2 AND recipient_id = $3', [tenant.id, list.id, recipient.id]);

    const after = await dataSource.getRepository(CampaignRecipientEntity).find({ where: { snapshotId } });
    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((row) => row.recipientId))).toEqual(new Set(before.map((row) => row.recipientId)));
  });

  it('A6: PATCH /campaigns/{id} on a frozen (queued) campaign is rejected 409 at the service layer', async () => {
    const session = await login();
    const { campaignId } = await frozenCampaign(session);

    const response = await request(app.getHttpServer()).patch(`/api/v1/campaigns/${campaignId}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('If-Match', '"1"')
      .send({ name: 'Renamed after freeze' });

    expect(response.status).toBe(409);
  });

  it('A6: the same content-column write is independently rejected with ERRCODE 55000 at the DB trigger layer', async () => {
    const session = await login();
    const { campaignId } = await frozenCampaign(session);

    await expect(
      dataSource.query("UPDATE campaign SET name = 'Direct SQL rename' WHERE id = $1", [campaignId]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('A7/A8: editing the template draft after the freeze changes nothing about the frozen campaign', async () => {
    const session = await login();
    const { snapshotId, recipient, template } = await frozenCampaign(session);
    const before = await frozenRecipientRow(snapshotId, recipient.id);

    const response = await request(app.getHttpServer()).patch(`/api/v1/templates/${template.id}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('if-match', '1')
      .send({ subject: 'v2 draft subject, not yet published' });
    expect(response.status).toBe(200);

    const after = await frozenRecipientRow(snapshotId, recipient.id);
    expect(after.emailSnapshot).toEqual(before.emailSnapshot);
  });

  it('A7: publishing template v2 leaves the frozen campaign on v1 content; v1 itself remains unmodifiable; a new campaign can select v2', async () => {
    const session = await login();
    const { campaignId, snapshotId, recipient, template, version: v1 } = await frozenCampaign(session);
    const before = await frozenRecipientRow(snapshotId, recipient.id);

    await request(app.getHttpServer()).patch(`/api/v1/templates/${template.id}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('if-match', '1')
      .send({ subject: 'v2 subject for {{first_name}}', html: '<p>v2 body for {{first_name}}</p>' });
    const published = await request(app.getHttpServer()).post(`/api/v1/templates/${template.id}/publish`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(published.status).toBe(201);
    const v2Id = published.body.id as string;
    expect(v2Id).not.toBe(v1.id);

    const campaignAfterPublish = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}`).set('Cookie', session.cookie);
    expect(campaignAfterPublish.body.templateVersionId).toBe(v1.id);

    const after = await frozenRecipientRow(snapshotId, recipient.id);
    expect(after.emailSnapshot).toEqual(before.emailSnapshot);
    expect(after.emailSnapshot.subject).not.toContain('v2');

    // v1 itself remains unmodifiable, independent of the campaign snapshot's own immutability.
    const rejectedEdit = await request(app.getHttpServer()).patch(`/api/v1/template-versions/${v1.id}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({});
    expect(rejectedEdit.status).toBe(405);

    // A new campaign can freely select v2.
    const newDraft = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Uses v2 ${randomUUID()}`, templateId: template.id, templateVersionId: v2Id });
    expect(newDraft.status).toBe(201);
    expect(newDraft.body.templateVersionId).toBe(v2Id);
  });
});
