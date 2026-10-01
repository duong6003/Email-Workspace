import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { testPasswordHash } from './test-password.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { EmailTemplateEntity } from '../../src/database/entities/email-template.entity.js';
import { EmailTemplateVersionEntity } from '../../src/database/entities/email-template-version.entity.js';
import { CampaignSnapshotEntity } from '../../src/database/entities/campaign-snapshot.entity.js';
import { CampaignRecipientEntity } from '../../src/database/entities/campaign-recipient.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/**
 * M4-S4 (BR-CMP-007, A5): a frozen campaign_snapshot row, and the frozen
 * half of a campaign_recipient row, are immutable by PostgreSQL trigger
 * (migration 022), not merely by application convention. These rows are
 * hand-inserted here via repository/manager calls -- freezeCampaignSnapshot
 * does not exist until CP2.
 */
describe('Campaign snapshot immutability (M4-S4 CP1: A5)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let operatorId: string;
  let sameTenantOperatorId: string;
  let otherTenant: TenantEntity;
  let otherOperatorId: string;
  let otherRecipient: RecipientEntity;
  let otherTemplateVersion: EmailTemplateVersionEntity;
  const password = 'correct-horse-battery-staple';
  const operator = `snapshot-immutability-operator-${randomUUID()}@test.dev`;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `snapshot-immutability-${randomUUID()}` });
    const primaryOperator = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Snapshot Immutability Operator', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active',
    });
    operatorId = primaryOperator.id;
    const sameTenantOperator = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: `snapshot-immutability-same-tenant-${randomUUID()}@test.dev`, displayName: 'Second Snapshot Operator', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active',
    });
    sameTenantOperatorId = sameTenantOperator.id;
    otherTenant = await dataSource.getRepository(TenantEntity).save({ name: `snapshot-immutability-other-${randomUUID()}` });
    const otherOperator = await dataSource.getRepository(AppUserEntity).save({
      tenantId: otherTenant.id, email: `snapshot-immutability-other-${randomUUID()}@test.dev`, displayName: 'Other Snapshot Operator', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active',
    });
    otherOperatorId = otherOperator.id;
    otherRecipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: otherTenant.id, email: `snapshot-other-recipient-${randomUUID()}@example.test` });
    const otherTemplate = await dataSource.getRepository(EmailTemplateEntity).save({
      tenantId: otherTenant.id,
      name: `snapshot-other-template-${randomUUID()}`,
      status: 'published',
    });
    otherTemplateVersion = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: otherTenant.id,
      templateId: otherTemplate.id,
      version: 1,
      subject: 'Other tenant subject',
      html: '<p>Other tenant HTML</p>',
      textBody: 'Other tenant text',
      requiredVariables: [],
      variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'),
      publishedAt: new Date(),
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    // campaign_snapshot/campaign_recipient are immutable by trigger (022);
    // disable both under a transaction-scoped advisory lock so cleanup can
    // still delete the fixtures, mirroring deleteTemplateVersionFixtures's
    // own pattern for email_template_version_immutable_trigger.
    const tenantIds = [tenant.id, otherTenant.id];
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_snapshot_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        // M5-S3 CP3: a concurrently-running campaign-send-scan can freeze
        // one of these campaigns the instant it reaches 'queued'.
        await manager.query('DELETE FROM message_attempt WHERE tenant_id = ANY($1)', [tenantIds]);
        await manager.query('DELETE FROM campaign_execution WHERE tenant_id = ANY($1)', [tenantIds]);
        await manager.query('DELETE FROM campaign_recipient WHERE tenant_id = ANY($1)', [tenantIds]);
        await manager.query('DELETE FROM campaign_snapshot WHERE tenant_id = ANY($1)', [tenantIds]);
      } finally {
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
        await manager.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      }
    });
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = ANY($1)', [tenantIds]);
    await deleteTemplateVersionFixtures(dataSource, tenantIds);
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = ANY($1)', [tenantIds]);
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: otherTenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: otherTenant.id });
    await dataSource.query('DELETE FROM login_attempt WHERE tenant_id = ANY($1)', [tenantIds]);
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_snapshot_audit_cleanup'))");
      await manager.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
      try {
        await manager.query('DELETE FROM audit_log WHERE tenant_id = ANY($1)', [tenantIds]);
      } finally {
        await manager.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable');
      }
    });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: otherTenant.id });
    await dataSource.getRepository(TenantEntity).delete(tenantIds);
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

  async function createCampaignWithTemplate(session: { cookie: string; csrfToken: string }) {
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1,
      subject: 'Hi {{first_name}}', html: '<p>{{first_name}}</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Snapshot immutability ${randomUUID()}`, templateId: template.id, templateVersionId: version.id });
    return { campaignId: created.body.id as string, version: version };
  }

  async function insertSnapshot(campaignId: string, templateVersionId: string, frozenBy: string | null = null) {
    return dataSource.getRepository(CampaignSnapshotEntity).save({
      tenantId: tenant.id,
      campaignId,
      templateVersionId,
      senderJson: { fromEmail: 'ops@example.com' },
      audienceQueryJson: { recipientIds: [] },
      policyResultJson: { totalActionable: 1, completeCount: 1, missingCount: 0, missingByVariable: [], waiver: null, webOrigin: 'http://localhost:5173' },
      variableSchemaJson: { required: [], optional: [] },
      totalSnapshot: 1,
      sendableCount: 1,
      skippedCount: 0,
      frozenBy,
      frozenAt: new Date(),
      supersededAt: null,
    });
  }

  it('A5: an UPDATE against a frozen campaign_snapshot row is rejected with ERRCODE 55000', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    const snapshot = await insertSnapshot(campaignId, version.id);

    await expect(
      dataSource.query('UPDATE campaign_snapshot SET total_snapshot = total_snapshot + 1 WHERE id = $1', [snapshot.id]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('A5: a DELETE against a frozen campaign_snapshot row is rejected with ERRCODE 55000', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    const snapshot = await insertSnapshot(campaignId, version.id);

    await expect(
      dataSource.query('DELETE FROM campaign_snapshot WHERE id = $1', [snapshot.id]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('A5: superseding a snapshot is its sole legal update', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    const snapshot = await insertSnapshot(campaignId, version.id);

    await expect(
      dataSource.query('UPDATE campaign_snapshot SET superseded_at = now() WHERE id = $1', [snapshot.id]),
    ).resolves.toBeDefined();
  });

  it('A5: a supersede cannot mutate snapshot identity, tenancy, or freezer', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    const [idSnapshot, tenantSnapshot, frozenBySnapshot] = await Promise.all([
      insertSnapshot(campaignId, version.id),
      (async () => { const next = await createCampaignWithTemplate(session); return insertSnapshot(next.campaignId, next.version.id); })(),
      (async () => {
        const next = await createCampaignWithTemplate(session);
        return insertSnapshot(next.campaignId, next.version.id, operatorId);
      })(),
    ]);

    await expect(
      dataSource.query('UPDATE campaign_snapshot SET superseded_at = now(), id = $1 WHERE id = $2', [randomUUID(), idSnapshot.id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      dataSource.query('UPDATE campaign_snapshot SET superseded_at = now(), tenant_id = $1 WHERE id = $2', [otherTenant.id, tenantSnapshot.id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      dataSource.query('UPDATE campaign_snapshot SET superseded_at = now(), frozen_by = NULL WHERE id = $1', [frozenBySnapshot.id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      dataSource.query('UPDATE campaign_snapshot SET superseded_at = now(), frozen_by = $1 WHERE id = $2', [sameTenantOperatorId, frozenBySnapshot.id]),
    ).rejects.toMatchObject({ code: '55000' });
    // M6-S3 (migration 029, ADR-027): resend lineage must be exactly as
    // immutable as every other frozen column once superseded -- a
    // snapshot's parentage does not change after it is written.
    const lineage = await createCampaignWithTemplate(session);
    const lineageSnapshot = await insertSnapshot(lineage.campaignId, lineage.version.id);
    await expect(
      dataSource.query('UPDATE campaign_snapshot SET superseded_at = now(), parent_snapshot_id = $1 WHERE id = $2', [idSnapshot.id, lineageSnapshot.id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      dataSource.query('UPDATE campaign_snapshot SET superseded_at = now() WHERE id = $1', [idSnapshot.id]),
    ).resolves.toBeDefined();
    await expect(
      dataSource.query('UPDATE campaign_snapshot SET superseded_at = now() WHERE id = $1', [idSnapshot.id]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('A5: a recipient progress update cannot mutate identity or tenancy', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    const snapshot = await insertSnapshot(campaignId, version.id);
    const recipient = await dataSource.getRepository(RecipientEntity).save({
      tenantId: tenant.id,
      email: `snapshot-recipient-identity-${randomUUID()}@example.test`,
    });
    const campaignRecipient = await dataSource.getRepository(CampaignRecipientEntity).save({
      tenantId: tenant.id,
      campaignId,
      snapshotId: snapshot.id,
      recipientId: recipient.id,
      recipientEmail: recipient.email,
      mergeDataJson: {},
      emailSnapshot: { subject: '', html: '', textBody: '' },
      eligibility: 'sendable',
      skippedReason: null,
      status: 'queued',
      providerMessageId: null,
      lastErrorCode: null,
      updatedAt: new Date(),
    });

    await expect(
      dataSource.query("UPDATE campaign_recipient SET status = 'submitted', id = $1 WHERE id = $2", [randomUUID(), campaignRecipient.id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      dataSource.query("UPDATE campaign_recipient SET status = 'submitted', tenant_id = $1 WHERE id = $2", [otherTenant.id, campaignRecipient.id]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('DEC-084: invalid snapshot totals are rejected by PostgreSQL', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);

    await expect(dataSource.query(
      `INSERT INTO campaign_snapshot (
        tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json,
        variable_schema_json, total_snapshot, sendable_count, skipped_count
      ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, 1)`,
      [tenant.id, campaignId, version.id],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(dataSource.query(
      `INSERT INTO campaign_snapshot (
        tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json,
        variable_schema_json, total_snapshot, sendable_count, skipped_count
      ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, -1, 0, 0)`,
      [tenant.id, campaignId, version.id],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('A16: snapshots reject cross-tenant campaign and template-version relationships', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);

    await expect(dataSource.query(
      `INSERT INTO campaign_snapshot (
        tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json,
        variable_schema_json, total_snapshot, sendable_count, skipped_count
      ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 0)`,
      [otherTenant.id, campaignId, version.id],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(dataSource.query(
      `INSERT INTO campaign_snapshot (
        tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json,
        variable_schema_json, total_snapshot, sendable_count, skipped_count
      ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 0)`,
      [tenant.id, campaignId, otherTemplateVersion.id],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(dataSource.query(
      `INSERT INTO campaign_snapshot (
        tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json,
        variable_schema_json, total_snapshot, sendable_count, skipped_count, frozen_by
      ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 0, $4)`,
      [tenant.id, campaignId, version.id, otherOperatorId],
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('A5: a campaign_recipient\'s frozen columns (merge_data_json) are locked, but status remains writable', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    const snapshot = await insertSnapshot(campaignId, version.id);
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `snapshot-recipient-${randomUUID()}@example.test` });
    const campaignRecipient = await dataSource.getRepository(CampaignRecipientEntity).save({
      tenantId: tenant.id,
      campaignId,
      snapshotId: snapshot.id,
      recipientId: recipient.id,
      recipientEmail: recipient.email,
      mergeDataJson: { first_name: 'Ada' },
      emailSnapshot: { subject: 'Hi Ada', html: '<p>Hi Ada</p>', textBody: 'Hi Ada' },
      eligibility: 'sendable',
      skippedReason: null,
      status: 'queued',
      providerMessageId: null,
      lastErrorCode: null,
      updatedAt: new Date(),
    });

    await expect(
      dataSource.query("UPDATE campaign_recipient SET merge_data_json = '{\"first_name\":\"Mutated\"}'::jsonb WHERE id = $1", [campaignRecipient.id]),
    ).rejects.toMatchObject({ code: '55000' });

    const updatedAt = new Date('2026-08-16T12:00:00.000Z');
    await expect(
      dataSource.query(
        "UPDATE campaign_recipient SET status = 'submitted', provider_message_id = 'provider-123', last_error_code = 'transient', updated_at = $1 WHERE id = $2",
        [updatedAt, campaignRecipient.id],
      ),
    ).resolves.toBeDefined();
    const [row] = await dataSource.query(
      'SELECT status, provider_message_id, last_error_code, updated_at FROM campaign_recipient WHERE id = $1',
      [campaignRecipient.id],
    ) as Array<{ status: string; provider_message_id: string; last_error_code: string; updated_at: Date }>;
    expect(row).toMatchObject({ status: 'submitted', provider_message_id: 'provider-123', last_error_code: 'transient' });
    expect(row.updated_at).toEqual(updatedAt);

  });

  it('A16: recipients reject cross-tenant parents and mismatched snapshot campaign', async () => {
    const session = await login();
    const first = await createCampaignWithTemplate(session);
    const second = await createCampaignWithTemplate(session);
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      insertSnapshot(first.campaignId, first.version.id),
      insertSnapshot(second.campaignId, second.version.id),
    ]);
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `snapshot-recipient-a16-${randomUUID()}@example.test` });

    const insertCampaignRecipient = (values: { tenantId: string; campaignId: string; snapshotId: string; recipientId: string; recipientEmail: string }) => dataSource.query(
      `INSERT INTO campaign_recipient (
        tenant_id, campaign_id, snapshot_id, recipient_id, recipient_email, merge_data_json, email_snapshot, eligibility, status
      ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '{"subject":"","html":"","textBody":""}'::jsonb, 'sendable', 'queued')`,
      [values.tenantId, values.campaignId, values.snapshotId, values.recipientId, values.recipientEmail],
    );

    await expect(insertCampaignRecipient({ tenantId: otherTenant.id, campaignId: first.campaignId, snapshotId: firstSnapshot.id, recipientId: recipient.id, recipientEmail: recipient.email }))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insertCampaignRecipient({ tenantId: tenant.id, campaignId: first.campaignId, snapshotId: firstSnapshot.id, recipientId: otherRecipient.id, recipientEmail: otherRecipient.email }))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insertCampaignRecipient({ tenantId: tenant.id, campaignId: second.campaignId, snapshotId: firstSnapshot.id, recipientId: recipient.id, recipientEmail: recipient.email }))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insertCampaignRecipient({ tenantId: tenant.id, campaignId: second.campaignId, snapshotId: secondSnapshot.id, recipientId: recipient.id, recipientEmail: recipient.email }))
      .resolves.toBeDefined();
  });

  it('uses database defaults that match frozen JSON entity shapes', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    const [snapshot] = await dataSource.query(
      `INSERT INTO campaign_snapshot (
        tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json,
        total_snapshot, sendable_count, skipped_count
      ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 0)
      RETURNING id, variable_schema_json`,
      [tenant.id, campaignId, version.id],
    ) as Array<{ id: string; variable_schema_json: unknown }>;
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `snapshot-default-recipient-${randomUUID()}@example.test` });
    const [campaignRecipient] = await dataSource.query(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)
       RETURNING email_snapshot`,
      [tenant.id, campaignId, snapshot.id, recipient.id],
    ) as Array<{ email_snapshot: unknown }>;

    expect(snapshot.variable_schema_json).toEqual({ required: [], optional: [] });
    expect(campaignRecipient.email_snapshot).toEqual({ subject: '', html: '', textBody: '' });
  });

  it('A5: skipped recipients require a non-null recognized skipped reason', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    const snapshot = await insertSnapshot(campaignId, version.id);
    const recipient = await dataSource.getRepository(RecipientEntity).save({
      tenantId: tenant.id,
      email: `snapshot-skipped-reason-${randomUUID()}@example.test`,
    });

    await expect(dataSource.query(
      `INSERT INTO campaign_recipient (
        tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, email_snapshot, eligibility, skipped_reason
      ) VALUES ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, 'skipped', NULL)`,
      [tenant.id, campaignId, snapshot.id, recipient.id],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('A5: a campaign_recipient row cannot be deleted once frozen', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    const snapshot = await insertSnapshot(campaignId, version.id);
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `snapshot-recipient-${randomUUID()}@example.test` });
    const campaignRecipient = await dataSource.getRepository(CampaignRecipientEntity).save({
      tenantId: tenant.id, campaignId, snapshotId: snapshot.id, recipientId: recipient.id, recipientEmail: recipient.email,
      mergeDataJson: {}, emailSnapshot: { subject: '', html: '', textBody: '' },
      eligibility: 'sendable', skippedReason: null, status: 'queued', providerMessageId: null, lastErrorCode: null, updatedAt: new Date(),
    });

    await expect(
      dataSource.query('DELETE FROM campaign_recipient WHERE id = $1', [campaignRecipient.id]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('A5: every snapshot frozen field rejects mutation with ERRCODE 55000', async () => {
    const session = await login();
    const primary = await createCampaignWithTemplate(session);
    const alternate = await createCampaignWithTemplate(session);
    const cases: Array<{ name: string; sql: string; values: unknown[] }> = [
      { name: 'id', sql: 'UPDATE campaign_snapshot SET id = $1 WHERE id = $2', values: [randomUUID()] },
      { name: 'tenant_id', sql: 'UPDATE campaign_snapshot SET tenant_id = $1 WHERE id = $2', values: [otherTenant.id] },
      { name: 'campaign_id', sql: 'UPDATE campaign_snapshot SET campaign_id = $1 WHERE id = $2', values: [alternate.campaignId] },
      { name: 'template_version_id', sql: 'UPDATE campaign_snapshot SET template_version_id = $1 WHERE id = $2', values: [alternate.version.id] },
      { name: 'frozen_by', sql: 'UPDATE campaign_snapshot SET frozen_by = NULL WHERE id = $1', values: [] },
      { name: 'sender_json', sql: "UPDATE campaign_snapshot SET sender_json = '{\"fromEmail\":\"changed@example.test\"}'::jsonb WHERE id = $1", values: [] },
      { name: 'audience_query_json', sql: "UPDATE campaign_snapshot SET audience_query_json = '{\"recipientIds\":[\"changed\"]}'::jsonb WHERE id = $1", values: [] },
      { name: 'policy_result_json', sql: "UPDATE campaign_snapshot SET policy_result_json = '{\"totalActionable\":0}'::jsonb WHERE id = $1", values: [] },
      { name: 'variable_schema_json', sql: "UPDATE campaign_snapshot SET variable_schema_json = '{\"required\":[\"changed\"],\"optional\":[]}'::jsonb WHERE id = $1", values: [] },
      { name: 'total_snapshot', sql: 'UPDATE campaign_snapshot SET total_snapshot = 2 WHERE id = $1', values: [] },
      { name: 'sendable_count', sql: 'UPDATE campaign_snapshot SET sendable_count = 0 WHERE id = $1', values: [] },
      { name: 'skipped_count', sql: 'UPDATE campaign_snapshot SET skipped_count = 1 WHERE id = $1', values: [] },
      { name: 'frozen_at', sql: 'UPDATE campaign_snapshot SET frozen_at = now() + interval \'1 second\' WHERE id = $1', values: [] },
    ];

    for (const { sql, values } of cases) {
      const current = await createCampaignWithTemplate(session);
      const snapshot = await insertSnapshot(current.campaignId, current.version.id, operatorId);
      await expect(dataSource.query(sql, [...values, snapshot.id])).rejects.toMatchObject({ code: '55000' });
    }
  });

  it('DEC-084: each nonnegative snapshot count rejects negative values', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);

    for (const [column, values] of [
      ['total_snapshot', [-1, 0, 0]],
      ['sendable_count', [0, -1, 1]],
      ['skipped_count', [0, 1, -1]],
    ] as const) {
      await expect(dataSource.query(
        `INSERT INTO campaign_snapshot (
          tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json,
          variable_schema_json, total_snapshot, sendable_count, skipped_count
        ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, $5, $6)`,
        [tenant.id, campaignId, version.id, ...values],
      ), column).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('A5: every campaign_recipient frozen field rejects mutation with ERRCODE 55000', async () => {
    const session = await login();
    const primary = await createCampaignWithTemplate(session);
    const alternate = await createCampaignWithTemplate(session);
    const snapshot = await insertSnapshot(primary.campaignId, primary.version.id);
    const alternateSnapshot = await insertSnapshot(alternate.campaignId, alternate.version.id);
    const alternateRecipient = await dataSource.getRepository(RecipientEntity).save({
      tenantId: tenant.id,
      email: `snapshot-recipient-alternate-${randomUUID()}@example.test`,
    });
    const createFrozenRecipient = async () => {
      const recipient = await dataSource.getRepository(RecipientEntity).save({
        tenantId: tenant.id,
        email: `snapshot-recipient-frozen-${randomUUID()}@example.test`,
      });
      return dataSource.getRepository(CampaignRecipientEntity).save({
        tenantId: tenant.id,
        campaignId: primary.campaignId,
        snapshotId: snapshot.id,
        recipientId: recipient.id,
        recipientEmail: recipient.email,
        mergeDataJson: { first_name: 'Ada' },
        emailSnapshot: { subject: 'Hi Ada', html: '<p>Hi Ada</p>', textBody: 'Hi Ada' },
        eligibility: 'sendable',
        skippedReason: null,
        status: 'queued',
        providerMessageId: null,
        lastErrorCode: null,
        updatedAt: new Date(),
      });
    };
    const cases: Array<{ name: string; sql: string; values: unknown[] }> = [
      { name: 'id', sql: 'UPDATE campaign_recipient SET id = $1 WHERE id = $2', values: [randomUUID()] },
      { name: 'tenant_id', sql: 'UPDATE campaign_recipient SET tenant_id = $1 WHERE id = $2', values: [otherTenant.id] },
      { name: 'snapshot_id', sql: 'UPDATE campaign_recipient SET snapshot_id = $1 WHERE id = $2', values: [alternateSnapshot.id] },
      { name: 'campaign_id', sql: 'UPDATE campaign_recipient SET campaign_id = $1 WHERE id = $2', values: [alternate.campaignId] },
      { name: 'recipient_id', sql: 'UPDATE campaign_recipient SET recipient_id = $1 WHERE id = $2', values: [alternateRecipient.id] },
      { name: 'recipient_email', sql: "UPDATE campaign_recipient SET recipient_email = 'changed@example.test' WHERE id = $1", values: [] },
      { name: 'merge_data_json', sql: "UPDATE campaign_recipient SET merge_data_json = '{\"first_name\":\"Changed\"}'::jsonb WHERE id = $1", values: [] },
      { name: 'email_snapshot', sql: "UPDATE campaign_recipient SET email_snapshot = '{\"subject\":\"Changed\",\"html\":\"\",\"textBody\":\"\"}'::jsonb WHERE id = $1", values: [] },
      { name: 'eligibility', sql: "UPDATE campaign_recipient SET eligibility = 'skipped' WHERE id = $1", values: [] },
      { name: 'skipped_reason', sql: "UPDATE campaign_recipient SET skipped_reason = 'deleted' WHERE id = $1", values: [] },
    ];

    for (const { name, sql, values } of cases) {
      const campaignRecipient = await createFrozenRecipient();
      await expect(dataSource.query(sql, [...values, campaignRecipient.id])).rejects.toMatchObject({ code: '55000' });
    }
  });

  it('A5: each recipient progress field remains independently writable', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    const snapshot = await insertSnapshot(campaignId, version.id);
    const recipient = await dataSource.getRepository(RecipientEntity).save({
      tenantId: tenant.id,
      email: `snapshot-recipient-progress-${randomUUID()}@example.test`,
    });
    const campaignRecipient = await dataSource.getRepository(CampaignRecipientEntity).save({
      tenantId: tenant.id,
      campaignId,
      snapshotId: snapshot.id,
      recipientId: recipient.id,
      recipientEmail: recipient.email,
      mergeDataJson: {},
      emailSnapshot: { subject: '', html: '', textBody: '' },
      eligibility: 'sendable',
      skippedReason: null,
      status: 'queued',
      providerMessageId: null,
      lastErrorCode: null,
      updatedAt: new Date(),
    });

    await expect(dataSource.query("UPDATE campaign_recipient SET status = 'submitted' WHERE id = $1", [campaignRecipient.id])).resolves.toBeDefined();
    await expect(dataSource.query("UPDATE campaign_recipient SET provider_message_id = 'provider-independent' WHERE id = $1", [campaignRecipient.id])).resolves.toBeDefined();
    await expect(dataSource.query("UPDATE campaign_recipient SET last_error_code = 'none' WHERE id = $1", [campaignRecipient.id])).resolves.toBeDefined();
    await expect(dataSource.query("UPDATE campaign_recipient SET updated_at = now() + interval '1 second' WHERE id = $1", [campaignRecipient.id])).resolves.toBeDefined();
  });

  it('A5: every frozen campaign field rejects draft-to-draft mutation while a live snapshot exists', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    await insertSnapshot(campaignId, version.id);
    const mutations: Array<{ name: string; assignment: string }> = [
      { name: 'name', assignment: "name = 'changed name'" },
      { name: 'subject', assignment: "subject = 'changed subject'" },
      { name: 'template_id', assignment: 'template_id = NULL' },
      { name: 'template_version_id', assignment: 'template_version_id = NULL' },
      { name: 'sender_json', assignment: "sender_json = '{\"fromEmail\":\"changed@example.test\"}'::jsonb" },
      { name: 'audience_json', assignment: "audience_json = '{\"recipientIds\":[]}'::jsonb" },
      { name: 'settings_json', assignment: "settings_json = '{\"cc\":[\"changed@example.test\"]}'::jsonb" },
      { name: 'scheduled_at_utc', assignment: "scheduled_at_utc = '2030-01-01T00:00:00Z'::timestamptz" },
      { name: 'scheduled_timezone', assignment: "scheduled_timezone = 'UTC'" },
      { name: 'deleted_at', assignment: 'deleted_at = now()' },
    ];

    for (const { name, assignment } of mutations) {
      await expect(
        dataSource.query(`UPDATE campaign SET ${assignment} WHERE id = $1`, [campaignId]),
        name,
      ).rejects.toMatchObject({ code: '55000' });
    }
  });

  it('A5: queued to draft is blocked while the campaign still has a live snapshot', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    await insertSnapshot(campaignId, version.id);
    await dataSource.query("UPDATE campaign SET status = 'queued' WHERE id = $1", [campaignId]);

    await expect(
      dataSource.query("UPDATE campaign SET status = 'draft' WHERE id = $1", [campaignId]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('A5: superseding the live snapshot permits a clean queued-to-draft refresh and replacement history', async () => {
    const session = await login();
    const { campaignId, version } = await createCampaignWithTemplate(session);
    const original = await insertSnapshot(campaignId, version.id);
    await dataSource.query("UPDATE campaign SET status = 'queued' WHERE id = $1", [campaignId]);
    await dataSource.query('UPDATE campaign_snapshot SET superseded_at = now() WHERE id = $1', [original.id]);

    await expect(
      dataSource.query(
        "UPDATE campaign SET status = 'draft', subject = 'bundled mutation' WHERE id = $1",
        [campaignId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      dataSource.query("UPDATE campaign SET status = 'draft' WHERE id = $1", [campaignId]),
    ).resolves.toBeDefined();
    await expect(
      dataSource.query("UPDATE campaign SET subject = 'replacement subject' WHERE id = $1", [campaignId]),
    ).resolves.toBeDefined();

    const replacement = await insertSnapshot(campaignId, version.id);
    const snapshots = await dataSource.query(
      `SELECT id, superseded_at
       FROM campaign_snapshot
       WHERE campaign_id = $1
       ORDER BY frozen_at, id`,
      [campaignId],
    ) as Array<{ id: string; superseded_at: Date | null }>;
    expect(snapshots).toHaveLength(2);
    expect(snapshots.filter((snapshot) => snapshot.superseded_at === null)).toEqual([
      expect.objectContaining({ id: replacement.id, superseded_at: null }),
    ]);
    expect(snapshots).toContainEqual(expect.objectContaining({ id: original.id, superseded_at: expect.any(Date) }));
  });

  it('A5: becoming queued cannot be combined with a frozen content mutation', async () => {
    const session = await login();
    const { campaignId } = await createCampaignWithTemplate(session);

    await expect(
      dataSource.query(
        "UPDATE campaign SET status = 'queued', audience_json = '{\"listIds\":[]}'::jsonb WHERE id = $1",
        [campaignId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('A5: every frozen campaign field rejects mutation in every non-draft state', async () => {
    const session = await login();
    const statuses = ['scheduled', 'queued', 'validating', 'sending', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled'];
    const mutations: Array<{ name: string; assignment: string }> = [
      { name: 'name', assignment: "name = 'changed name'" },
      { name: 'subject', assignment: "subject = 'changed subject'" },
      { name: 'template_id', assignment: 'template_id = NULL' },
      { name: 'template_version_id', assignment: 'template_version_id = NULL' },
      { name: 'sender_json', assignment: "sender_json = '{\"fromEmail\":\"changed@example.test\"}'::jsonb" },
      { name: 'audience_json', assignment: "audience_json = '{\"recipientIds\":[]}'::jsonb" },
      { name: 'settings_json', assignment: "settings_json = '{\"cc\":[\"changed@example.test\"]}'::jsonb" },
      { name: 'scheduled_at_utc', assignment: "scheduled_at_utc = '2030-01-01T00:00:00Z'::timestamptz" },
      { name: 'scheduled_timezone', assignment: "scheduled_timezone = 'UTC'" },
      { name: 'deleted_at', assignment: 'deleted_at = now()' },
    ];

    for (const status of statuses) {
      const { campaignId } = await createCampaignWithTemplate(session);
      await dataSource.query('UPDATE campaign SET status = $1 WHERE id = $2', [status, campaignId]);
      for (const { name, assignment } of mutations) {
        await expect(
          dataSource.query(`UPDATE campaign SET ${assignment} WHERE id = $1`, [campaignId]),
          `${status}: ${name}`,
        ).rejects.toMatchObject({ code: '55000' });
      }
    }
  });

  it('A5: a queued campaign cannot be soft-deleted at the DB layer', async () => {
    const session = await login();
    const { campaignId } = await createCampaignWithTemplate(session);
    await dataSource.query("UPDATE campaign SET status = 'queued' WHERE id = $1", [campaignId]);

    await expect(
      dataSource.query('UPDATE campaign SET deleted_at = now() WHERE id = $1', [campaignId]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('A5: once a campaign is queued for sending, its frozen content (audience_json) can no longer be edited at the DB layer', async () => {
    const session = await login();
    const { campaignId } = await createCampaignWithTemplate(session);
    await dataSource.query("UPDATE campaign SET status = 'queued' WHERE id = $1", [campaignId]);

    await expect(
      dataSource.query("UPDATE campaign SET audience_json = '{\"listIds\":[]}'::jsonb WHERE id = $1", [campaignId]),
    ).rejects.toMatchObject({ code: '55000' });
  });
});
