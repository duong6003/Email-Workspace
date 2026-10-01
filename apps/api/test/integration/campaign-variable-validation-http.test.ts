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
import { EmailTemplateVersionEntity, type TemplateVariableSchema } from '../../src/database/entities/email-template-version.entity.js';
import { CustomFieldDefinitionEntity } from '../../src/database/entities/custom-field-definition.entity.js';
import { AuditLogEntity } from '../../src/database/entities/audit-log.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/**
 * M4-S3 (BR-CMP-004/005/006/008, BR-TPL-008) via a real Nest HTTP stack:
 * validate-audience's matrix, and accept-waiver's server-computed,
 * audited decision plus the staleness check when the audience changes
 * after acceptance.
 */
describe('Campaign variable validation HTTP (M4-S3)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const operator = `variable-policy-operator-${randomUUID()}@test.dev`;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `variable-policy-http-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operator, displayName: 'Variable Policy Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
    await dataSource.getRepository(CustomFieldDefinitionEntity).save({
      tenantId: tenant.id, fieldKey: 'city', label: 'city', dataType: 'text', required: false,
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    // campaign rows reference template_id/template_version_id -- must be
    // deleted before the template fixtures they point at, or the FK aborts
    // deleteTemplateVersionFixtures's own transaction. audit_log rows are
    // immutable by design (BR-SEC-002) and are never deleted by any test.
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = $1', [tenant.id]);
    await deleteTemplateVersionFixtures(dataSource, [tenant.id]);
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(CustomFieldDefinitionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  async function login(): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: operator, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return {
      cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
  }

  async function createDraftWithTemplate(session: { cookie: string; csrfToken: string }, schema: TemplateVariableSchema) {
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1,
      subject: 'Hi {{first_name}}', html: '<p>{{first_name}} in {{city}}</p>', textBody: '',
      requiredVariables: schema.required, variableSchemaJson: schema,
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Variable policy draft ${randomUUID()}`, templateId: template.id, templateVersionId: version.id });
    return { campaignId: created.body.id as string, version: created.body.version as number };
  }

  async function addRecipientToList(recipientOverrides: Partial<RecipientEntity> = {}) {
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `varpolicy-${randomUUID()}@example.test`, ...recipientOverrides });
    const list = await dataSource.getRepository(RecipientListEntity).save({ tenantId: tenant.id, name: `list-${randomUUID()}` });
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenant.id, list.id, recipient.id, 'manual'],
    );
    return { recipient, list };
  }

  it('A10: 404s when the campaign has no template selected yet', async () => {
    const session = await login();
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: `No template ${randomUUID()}` });
    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${created.body.id}/validate-audience`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(response.status).toBe(404);
  });

  it('reports complete for an audience where every recipient has the required variable, waiverStatus none', async () => {
    const session = await login();
    const { campaignId, version: draftVersion } = await createDraftWithTemplate(session, { required: ['city'], optional: [], defaults: {} });
    const { recipient, list } = await addRecipientToList({ customData: { city: 'Hanoi' } });
    await request(app.getHttpServer()).patch(`/api/v1/campaigns/${campaignId}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('if-match', String(draftVersion))
      .send({ audience: { listIds: [list.id] } });

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/validate-audience`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ totalActionable: 1, completeCount: 1, missingCount: 0, waiverStatus: 'none', waiverAcceptedAt: null });
    void recipient;
  });

  it('BR-CMP-004/005: reports missing variables, then accept-waiver persists an audited, server-computed decision that clears waiverStatus to valid', async () => {
    const session = await login();
    const { campaignId, version: draftVersion } = await createDraftWithTemplate(session, { required: ['city'], optional: [], defaults: {} });
    const { list } = await addRecipientToList({ customData: {} });
    const updated = await request(app.getHttpServer()).patch(`/api/v1/campaigns/${campaignId}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('if-match', String(draftVersion))
      .send({ audience: { listIds: [list.id] } });

    const before = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/validate-audience`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(before.body).toMatchObject({ completeCount: 0, missingCount: 1, waiverStatus: 'none' });
    expect(before.body.missingByVariable).toEqual([{ key: 'city', label: 'city', count: 1 }]);

    const accepted = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/audience-waiver`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('if-match', String(updated.body.version));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

    const after = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/validate-audience`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(after.body.waiverStatus).toBe('valid');
    expect(after.body.waiverAcceptedAt).not.toBeNull();

    const audit = await dataSource.getRepository(AuditLogEntity).findOne({
      where: { tenantId: tenant.id, action: 'campaign.audience_waiver_accepted', entityId: campaignId }, order: { occurredAt: 'DESC' },
    });
    expect(audit?.metadata).toMatchObject({ missingCount: 1 });
  });

  it('BR-CMP-005: a waiver goes stale once a newly-added recipient is also missing the variable', async () => {
    const session = await login();
    const { campaignId, version: draftVersion } = await createDraftWithTemplate(session, { required: ['city'], optional: [], defaults: {} });
    const first = await addRecipientToList({ customData: {} });
    const updated = await request(app.getHttpServer()).patch(`/api/v1/campaigns/${campaignId}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('if-match', String(draftVersion))
      .send({ audience: { listIds: [first.list.id] } });

    const accepted = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/audience-waiver`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('if-match', String(updated.body.version));
    expect(accepted.status).toBe(201);

    const second = await addRecipientToList({ customData: {} });
    const expanded = await request(app.getHttpServer()).patch(`/api/v1/campaigns/${campaignId}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('if-match', String(accepted.body.version))
      .send({ audience: { listIds: [first.list.id, second.list.id] } });
    expect(expanded.status, JSON.stringify(expanded.body)).toBe(200);

    const revalidated = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/validate-audience`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(revalidated.body.waiverStatus).toBe('stale');
    expect(revalidated.body.missingCount).toBe(2);
  });
});
