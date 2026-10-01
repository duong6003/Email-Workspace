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
 * M6-S3 CP6 (BR-HIS-005, ADR-027, DEC-133). POST /campaigns/:id/resend
 * creates a *new* snapshot generation over the parent execution's failed
 * recipients only, superseding the parent, and linking parent_execution_id.
 */
describe('Campaign resend HTTP (M6-S3 CP6)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let templateVersionId: string;
  const password = 'correct-horse-battery-staple';
  const operator = `resend-operator-${randomUUID()}@test.dev`;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `resend-http-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Resend Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `resend-t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1, subject: 'Hi', html: '<p>Hi</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    templateVersionId = version.id;
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_resend_http_test_cleanup'))");
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
    // audit_log is immutable (BR-SEC-002) -- left in place, established norm.
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = $1', [tenant.id]);
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

  async function fixture(recipientStatuses: Array<{ eligibility: 'sendable' | 'skipped'; status: string }>, campaignStatus: string, resendGeneration = 0) {
    const campaign = await dataSource.getRepository(CampaignEntity).save({
      tenantId: tenant.id, name: `Resend http ${randomUUID()}`, templateVersionId,
      senderJson: { fromEmail: 'ops@example.test' }, audienceJson: {}, settingsJson: {}, status: campaignStatus, version: 0,
    });
    const [snapshot] = await dataSource.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, variable_schema_json, total_snapshot, sendable_count, skipped_count, frozen_by)
       VALUES ($1, $2, $3, '{"fromEmail":"ops@example.test"}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{"required":[],"optional":[]}'::jsonb, $4, $5, $6, NULL) RETURNING id`,
      [tenant.id, campaign.id, templateVersionId, recipientStatuses.length,
        recipientStatuses.filter((r) => r.eligibility === 'sendable').length,
        recipientStatuses.filter((r) => r.eligibility === 'skipped').length],
    );
    const [execution] = await dataSource.query(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status, resend_generation)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.id, campaign.id, snapshot.id, `resend-http-${randomUUID()}`, campaignStatus === 'sending' ? 'sending' : campaignStatus, resendGeneration],
    );
    const recipientIds: string[] = [];
    for (const row of recipientStatuses) {
      const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `resend-http-${randomUUID()}@example.test` });
      await dataSource.query(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, email_snapshot, eligibility, skipped_reason, status, execution_id)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, '{"subject":"Hi","html":"<p>Hi</p>","textBody":"Hi"}'::jsonb, $5, $6, $7, $8)`,
        [tenant.id, campaign.id, snapshot.id, recipient.id, row.eligibility, row.eligibility === 'skipped' ? 'status_bounced' : null, row.status, execution.id],
      );
      recipientIds.push(recipient.id as string);
    }
    return { campaignId: campaign.id as string, snapshotId: snapshot.id as string, executionId: execution.id as string, recipientIds };
  }

  it('creates a child snapshot+execution linked to the parent, over failed recipients only', async () => {
    const session = await login();
    const { campaignId, snapshotId, executionId } = await fixture([
      { eligibility: 'sendable', status: 'failed' },
      { eligibility: 'sendable', status: 'failed' },
      { eligibility: 'sendable', status: 'failed' },
      { eligibility: 'sendable', status: 'delivered' },
      { eligibility: 'sendable', status: 'delivered' },
      { eligibility: 'sendable', status: 'delivered' },
      { eligibility: 'sendable', status: 'delivered' },
      { eligibility: 'sendable', status: 'delivered' },
      { eligibility: 'sendable', status: 'delivered' },
      { eligibility: 'sendable', status: 'delivered' },
    ], 'partial_failed');

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/resend`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(202);
    expect(response.body.recipientCount).toBe(3);
    const childExecutionId = response.body.executionId as string;
    expect(childExecutionId).not.toBe(executionId);

    const [childExecution] = await dataSource.query(
      `SELECT parent_execution_id, resend_generation, snapshot_id FROM campaign_execution WHERE id = $1`,
      [childExecutionId],
    );
    expect(childExecution.parent_execution_id).toBe(executionId);
    expect(childExecution.resend_generation).toBe(1);

    const [childSnapshot] = await dataSource.query(
      `SELECT parent_snapshot_id, total_snapshot, sendable_count FROM campaign_snapshot WHERE id = $1`,
      [childExecution.snapshot_id],
    );
    expect(childSnapshot.parent_snapshot_id).toBe(snapshotId);
    expect(childSnapshot.total_snapshot).toBe(3);
    expect(childSnapshot.sendable_count).toBe(3);

    const [parentSnapshot] = await dataSource.query(`SELECT superseded_at FROM campaign_snapshot WHERE id = $1`, [snapshotId]);
    expect(parentSnapshot.superseded_at).not.toBeNull();

    const childRecipients = await dataSource.query(
      `SELECT status, eligibility FROM campaign_recipient WHERE snapshot_id = $1`,
      [childExecution.snapshot_id],
    );
    expect(childRecipients).toHaveLength(3);
    for (const row of childRecipients) {
      expect(row.status).toBe('pending');
      expect(row.eligibility).toBe('sendable');
    }

    const campaign = await dataSource.getRepository(CampaignEntity).findOneOrFail({ where: { id: campaignId } });
    expect(campaign.status).toBe('queued');
  });

  it('a second resend increments resend_generation to 2', async () => {
    const session = await login();
    const { campaignId } = await fixture([{ eligibility: 'sendable', status: 'failed' }], 'partial_failed', 1);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/resend`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(202);
    const [childExecution] = await dataSource.query(`SELECT resend_generation FROM campaign_execution WHERE id = $1`, [response.body.executionId]);
    expect(childExecution.resend_generation).toBe(2);
  });

  it('refuses with 409 when the campaign is still sending', async () => {
    const session = await login();
    const { campaignId } = await fixture([{ eligibility: 'sendable', status: 'failed' }], 'sending');

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/resend`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(409);
  });

  it('refuses with 409 when there are zero failed recipients', async () => {
    const session = await login();
    const { campaignId } = await fixture([{ eligibility: 'sendable', status: 'delivered' }], 'completed');

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/resend`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(409);
  });
});
