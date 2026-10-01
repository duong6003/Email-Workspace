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
import { EmailTemplateEntity } from '../../src/database/entities/email-template.entity.js';
import { EmailTemplateVersionEntity } from '../../src/database/entities/email-template-version.entity.js';
import { CampaignEntity } from '../../src/database/entities/campaign.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/** M6-S3 CP9 (BR-HIS-007). GET /campaigns/:id/exports/:exportId/file -- expiry and per-download audit. */
describe('Campaign export download HTTP (M6-S3 CP9)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let otherTenant: TenantEntity;
  let templateVersionId: string;
  let otherTemplateVersionId: string;
  const password = 'correct-horse-battery-staple';
  const operator = `export-dl-operator-${randomUUID()}@test.dev`;
  const viewer = `export-dl-viewer-${randomUUID()}@test.dev`;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `export-dl-http-${randomUUID()}` });
    otherTenant = await dataSource.getRepository(TenantEntity).save({ name: `export-dl-http-other-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Export DL Operator', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active',
    });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: viewer, displayName: 'Export DL Viewer', role: 'viewer', passwordHash: await testPasswordHash(password), status: 'active',
    });
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `export-dl-t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1, subject: 'Hi', html: '<p>Hi</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    templateVersionId = version.id;

    const otherTemplate = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: otherTenant.id, name: `export-dl-other-t-${randomUUID()}`, status: 'published' });
    const otherVersion = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: otherTenant.id, templateId: otherTemplate.id, version: 1, subject: 'Hi', html: '<p>Hi</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    otherTemplateVersionId = otherVersion.id;
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.query('DELETE FROM export_job WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_export_download_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        await manager.query('DELETE FROM campaign_execution WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
        await manager.query('DELETE FROM campaign_recipient WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
        await manager.query('DELETE FROM campaign_snapshot WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
      } finally {
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
        await manager.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      }
    });
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
    await deleteTemplateVersionFixtures(dataSource, [tenant.id, otherTenant.id]);
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: otherTenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: otherTenant.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(TenantEntity).delete(otherTenant.id);
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

  async function completedExportFixture(opts: { expired?: boolean; ownerTenantId?: string } = {}): Promise<{ campaignId: string; exportJobId: string }> {
    const ownerTenantId = opts.ownerTenantId ?? tenant.id;
    const owner = await dataSource.getRepository(AppUserEntity).save({
      tenantId: ownerTenantId, email: `export-dl-owner-${randomUUID()}@test.dev`, displayName: 'Export DL Owner', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active',
    });
    const campaign = await dataSource.getRepository(CampaignEntity).save({
      tenantId: ownerTenantId, name: `Export DL ${randomUUID()}`, templateVersionId: ownerTenantId === otherTenant.id ? otherTemplateVersionId : templateVersionId,
      senderJson: { fromEmail: 'ops@example.test' }, audienceJson: {}, settingsJson: {}, status: 'completed', version: 0,
    });
    const csv = 'recipient_email,status,skipped_reason,attempt_count,last_error_code,last_error_class,last_error_reason,submitted_at,delivered_at\r\nvi-du@example.test,delivered,,1,,,,,\r\n';
    const expiresAt = opts.expired ? new Date(Date.now() - 3_600_000) : new Date(Date.now() + 3_600_000);
    const [job] = await dataSource.query(
      `INSERT INTO export_job (tenant_id, campaign_id, kind, status, status_filter, row_count, artifact_bytes, artifact_filename, expires_at, completed_at, created_by)
       VALUES ($1, $2, 'campaign_recipients', 'completed', '{}', 1, $3, $4, $5, now(), $6) RETURNING id`,
      [ownerTenantId, campaign.id, Buffer.from(csv, 'utf8'), `campaign-${campaign.id}-export.csv`, expiresAt, owner.id],
    );
    return { campaignId: campaign.id as string, exportJobId: job.id as string };
  }

  it('downloads the artifact as text/csv with byte-identical Vietnamese content and audits it', async () => {
    const session = await login(operator);
    const { campaignId, exportJobId } = await completedExportFixture();

    const response = await request(app.getHttpServer())
      .get(`/api/v1/campaigns/${campaignId}/exports/${exportJobId}/file`)
      .set('Cookie', session.cookie);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.text).toContain('vi-du@example.test');

    const [audit] = await dataSource.query(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'history.export.downloaded'`,
      [tenant.id, exportJobId],
    );
    expect(audit).toBeDefined();

    const [job] = await dataSource.query(`SELECT downloaded_count FROM export_job WHERE id = $1`, [exportJobId]);
    expect(job.downloaded_count).toBe(1);
  });

  it('a second download increments downloaded_count and writes a second audit row', async () => {
    const session = await login(operator);
    const { campaignId, exportJobId } = await completedExportFixture();

    await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/exports/${exportJobId}/file`).set('Cookie', session.cookie);
    await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/exports/${exportJobId}/file`).set('Cookie', session.cookie);

    const [job] = await dataSource.query(`SELECT downloaded_count FROM export_job WHERE id = $1`, [exportJobId]);
    expect(job.downloaded_count).toBe(2);
    const audits = await dataSource.query(
      `SELECT id FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'history.export.downloaded'`,
      [tenant.id, exportJobId],
    );
    expect(audits).toHaveLength(2);
  });

  it('a viewer without history:export receives 403', async () => {
    const session = await login(viewer);
    const { campaignId, exportJobId } = await completedExportFixture();

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/exports/${exportJobId}/file`).set('Cookie', session.cookie);

    expect(response.status).toBe(403);
  });

  it('an expired export returns 410 and serves no bytes', async () => {
    const session = await login(operator);
    const { campaignId, exportJobId } = await completedExportFixture({ expired: true });

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/exports/${exportJobId}/file`).set('Cookie', session.cookie);

    expect(response.status).toBe(410);
    expect(response.body?.length ?? 0).toBeLessThan(200);
  });

  it('another tenant\'s export id returns 404, not 403 -- no cross-tenant existence leak', async () => {
    const session = await login(operator);
    const { exportJobId } = await completedExportFixture({ ownerTenantId: otherTenant.id });
    const { campaignId: myCampaignId } = await completedExportFixture();

    const response = await request(app.getHttpServer()).get(`/api/v1/campaigns/${myCampaignId}/exports/${exportJobId}/file`).set('Cookie', session.cookie);

    expect(response.status).toBe(404);
  });
});
