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

/** M6-S3 CP7 (BR-HIS-003, BR-HIS-007). POST /campaigns/:id/exports. */
describe('Campaign export creation HTTP (M6-S3 CP7)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let templateVersionId: string;
  const password = 'correct-horse-battery-staple';
  const operator = `export-operator-${randomUUID()}@test.dev`;
  const viewer = `export-viewer-${randomUUID()}@test.dev`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    process.env.EXPORT_INLINE_MAX_ROWS = '5';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `export-http-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Export Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: viewer, displayName: 'Export Viewer', role: 'viewer', passwordHash: await hashPassword(password), status: 'active',
    });
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `export-t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1, subject: 'Hi', html: '<p>Hi</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    templateVersionId = version.id;
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    delete process.env.EXPORT_INLINE_MAX_ROWS;
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_export_http_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        await manager.query('DELETE FROM export_job WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM message_attempt WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign_execution WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign_recipient WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign_snapshot WHERE tenant_id = $1', [tenant.id]);
      } finally {
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
        await manager.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      }
    });
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

  async function fixture(recipientCount: number): Promise<{ campaignId: string }> {
    const campaign = await dataSource.getRepository(CampaignEntity).save({
      tenantId: tenant.id, name: `Export http ${randomUUID()}`, templateVersionId,
      senderJson: { fromEmail: 'ops@example.test' }, audienceJson: {}, settingsJson: {}, status: 'completed', version: 0,
    });
    const [snapshot] = await dataSource.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, $4, 0) RETURNING id`,
      [tenant.id, campaign.id, templateVersionId, recipientCount],
    );
    const [execution] = await dataSource.query(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
      [tenant.id, campaign.id, snapshot.id, `export-http-${randomUUID()}`],
    );
    for (let i = 0; i < recipientCount; i += 1) {
      const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `export-http-${i}-${randomUUID()}@example.test` });
      await dataSource.query(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, email_snapshot, eligibility, status, execution_id)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, 'sendable', 'delivered', $5)`,
        [tenant.id, campaign.id, snapshot.id, recipient.id, execution.id],
      );
    }
    return { campaignId: campaign.id as string };
  }

  it('a viewer receives 403', async () => {
    const session = await login(viewer);
    const { campaignId } = await fixture(2);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/exports`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID()).send({});

    expect(response.status).toBe(403);
  });

  it('an operator receives 202 and a completed export at or below EXPORT_INLINE_MAX_ROWS', async () => {
    const session = await login(operator);
    const { campaignId } = await fixture(2);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/exports`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID()).send({});

    expect(response.status).toBe(202);
    expect(response.body.status).toBe('completed');
    expect(response.body.rowCount).toBe(2);
    expect(response.body.expiresAt).toBeDefined();

    const [job] = await dataSource.query(`SELECT artifact_bytes, artifact_filename FROM export_job WHERE id = $1`, [response.body.id]);
    expect(job.artifact_bytes).not.toBeNull();
    expect(job.artifact_filename).toBeTruthy();
  });

  it('an export over EXPORT_INLINE_MAX_ROWS stays queued with no artifact yet', async () => {
    const session = await login(operator);
    const { campaignId } = await fixture(7);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/exports`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID()).send({});

    expect(response.status).toBe(202);
    expect(response.body.status).toBe('queued');
    const [job] = await dataSource.query(`SELECT artifact_bytes FROM export_job WHERE id = $1`, [response.body.id]);
    expect(job.artifact_bytes).toBeNull();
  });

  it('GET returns the export job status', async () => {
    const session = await login(operator);
    const { campaignId } = await fixture(1);

    const created = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/exports`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', randomUUID()).send({});

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/exports/${created.body.id}`)
      .set('Cookie', session.cookie);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(created.body.id);
    expect(response.body.status).toBe('completed');
  });
});
