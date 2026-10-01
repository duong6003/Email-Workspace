import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { runInTenantContext } from '../../src/database/tenant-transaction.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { RecipientListEntity } from '../../src/database/entities/recipient-list.entity.js';
import { EmailTemplateEntity } from '../../src/database/entities/email-template.entity.js';
import { EmailTemplateVersionEntity, type TemplateVariableSchema } from '../../src/database/entities/email-template-version.entity.js';
import { CustomFieldDefinitionEntity } from '../../src/database/entities/custom-field-definition.entity.js';
import type { CampaignAudience } from '../../src/database/entities/campaign.entity.js';
import { computeCampaignVariableValidation } from '../../src/campaigns/campaign-variable-validation.js';
import { testDatabaseUrl } from './test-database-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/**
 * M4-S3 (BR-CMP-004/005/006, BR-TPL-008). Proves the real orchestration --
 * audience resolution -> recipient rows -> variable context -> the shared
 * renderer -- against real PostgreSQL, matching M4-S2-AUDIENCE-PLAN.md's own
 * CP2 precedent (repository + aggregation, real DB, no HTTP layer yet).
 */
describe('Campaign variable validation (M4-S3)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;
  const WEB_ORIGIN = 'https://app.example.test';

  const emptyAudience: CampaignAudience = {};

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `varval-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `varval-b-${randomUUID()}` });
  });

  afterAll(async () => {
    await deleteTemplateVersionFixtures(dataSource, [tenantA.id, tenantB.id]);
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(CustomFieldDefinitionEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(CustomFieldDefinitionEntity).delete({ tenantId: tenantB.id });
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(TenantEntity).delete([tenantA.id, tenantB.id]);
    await dataSource.destroy();
  });

  async function recipient(tenantId: string, overrides: Partial<RecipientEntity> = {}) {
    return dataSource.getRepository(RecipientEntity).save({ tenantId, email: `varval-${randomUUID()}@example.test`, ...overrides });
  }

  async function list(tenantId: string) {
    return dataSource.getRepository(RecipientListEntity).save({ tenantId, name: `list-${randomUUID()}` });
  }

  async function addToList(tenantId: string, listId: string, recipientId: string) {
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenantId, listId, recipientId, 'manual'],
    );
  }

  async function templateVersion(tenantId: string, schema: TemplateVariableSchema, overrides: Partial<EmailTemplateVersionEntity> = {}) {
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId, name: `template-${randomUUID()}`, status: 'published' });
    return dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId, templateId: template.id, version: 1,
      subject: 'Hello {{first_name}}', html: '<p>{{first_name}} from {{city}}, {{unsubscribe_url}}</p>', textBody: '',
      requiredVariables: schema.required, variableSchemaJson: schema, contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
      ...overrides,
    });
  }

  async function customField(tenantId: string, overrides: Partial<CustomFieldDefinitionEntity> = {}) {
    return dataSource.getRepository(CustomFieldDefinitionEntity).save({
      tenantId, fieldKey: `city_${randomUUID().slice(0, 8)}`, label: 'City', dataType: 'text', required: false, ...overrides,
    });
  }

  async function validate(tenantId: string, campaign: { id: string; templateVersionId: string | null; audienceJson: CampaignAudience }) {
    return runInTenantContext(dataSource, tenantId, (manager) => computeCampaignVariableValidation(manager, tenantId, campaign, WEB_ORIGIN));
  }

  it('404s when the campaign has no template version yet', async () => {
    await expect(validate(tenantA.id, { id: randomUUID(), templateVersionId: null, audienceJson: emptyAudience }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('reports every actionable recipient complete when the required custom field is set for all of them', async () => {
    const field = await customField(tenantA.id, { fieldKey: 'city' });
    const version = await templateVersion(tenantA.id, { required: ['city'], optional: ['first_name'], defaults: {} });
    const l = await list(tenantA.id);
    const r1 = await recipient(tenantA.id, { customData: { [field.fieldKey]: 'Hanoi' } });
    const r2 = await recipient(tenantA.id, { customData: { [field.fieldKey]: 'Saigon' } });
    await addToList(tenantA.id, l.id, r1.id);
    await addToList(tenantA.id, l.id, r2.id);

    const result = await validate(tenantA.id, { id: randomUUID(), templateVersionId: version.id, audienceJson: { listIds: [l.id] } });

    expect(result).toMatchObject({ totalActionable: 2, completeCount: 2, missingCount: 0 });
  });

  it('BR-CMP-004: reports a per-variable breakdown naming the custom field label when a recipient lacks it', async () => {
    const field = await customField(tenantA.id, { fieldKey: 'region', label: 'Khu vực' });
    const version = await templateVersion(tenantA.id, { required: ['region'], optional: [], defaults: {} });
    const l = await list(tenantA.id);
    const complete = await recipient(tenantA.id, { customData: { [field.fieldKey]: 'North' } });
    const missing = await recipient(tenantA.id, { customData: {} });
    await addToList(tenantA.id, l.id, complete.id);
    await addToList(tenantA.id, l.id, missing.id);

    const result = await validate(tenantA.id, { id: randomUUID(), templateVersionId: version.id, audienceJson: { listIds: [l.id] } });

    expect(result.completeCount).toBe(1);
    expect(result.missingCount).toBe(1);
    expect(result.missingByVariable).toEqual([{ key: 'region', label: 'Khu vực', count: 1 }]);
    expect(result.sample).toEqual([{ recipientId: missing.id, email: missing.email, missingKeys: ['region'] }]);
  });

  it('BR-TPL-008: unsubscribe_url always resolves, so a recipient is never reported missing it', async () => {
    const version = await templateVersion(tenantA.id, { required: ['unsubscribe_url'], optional: [], defaults: {} });
    const l = await list(tenantA.id);
    const r = await recipient(tenantA.id);
    await addToList(tenantA.id, l.id, r.id);

    const result = await validate(tenantA.id, { id: randomUUID(), templateVersionId: version.id, audienceJson: { listIds: [l.id] } });

    expect(result).toMatchObject({ totalActionable: 1, completeCount: 1, missingCount: 0 });
  });

  it('only validates the actionable set: excluded and ineligible recipients are not counted at all', async () => {
    const version = await templateVersion(tenantA.id, { required: [], optional: [], defaults: {} });
    const l = await list(tenantA.id);
    const active = await recipient(tenantA.id);
    const paused = await recipient(tenantA.id, { subscriptionStatus: 'paused' });
    await addToList(tenantA.id, l.id, active.id);
    await addToList(tenantA.id, l.id, paused.id);

    const result = await validate(tenantA.id, { id: randomUUID(), templateVersionId: version.id, audienceJson: { listIds: [l.id] } });

    expect(result.totalActionable).toBe(1);
  });

  it('BR-GEN-002: a custom field belonging to another tenant never contributes a label or a value', async () => {
    const fieldB = await customField(tenantB.id, { fieldKey: 'secret_field', label: 'Should not appear' });
    const version = await templateVersion(tenantA.id, { required: [], optional: ['secret_field'], defaults: {} });
    const l = await list(tenantA.id);
    const r = await recipient(tenantA.id, { customData: { [fieldB.fieldKey]: 'leaked?' } });
    await addToList(tenantA.id, l.id, r.id);

    const result = await validate(tenantA.id, { id: randomUUID(), templateVersionId: version.id, audienceJson: { listIds: [l.id] } });

    expect(result.missingCount).toBe(0);
    expect(result.missingByVariable).toEqual([]);
  });
});
