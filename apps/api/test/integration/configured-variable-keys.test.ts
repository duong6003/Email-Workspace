import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { ConfiguredVariablesService } from '../../src/configured-variables/configured-variables.service.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testDatabaseUrl } from './test-database-url.js';

/**
 * ADR-032: a template-local key is unique inside its own template, but may
 * never shadow a system variable, a tenant-global variable or a recipient
 * field. The invariant is symmetric -- it must hold no matter which side is
 * created second.
 */
describe('configured variable key availability', () => {
  let dataSource: DataSource;
  let tenantId: string;
  let templateA: string;
  let templateB: string;
  const service = () => new ConfiguredVariablesService(dataSource);

  const insertTemplate = async (): Promise<string> => {
    const [row] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [tenantId, `Template ${randomUUID()}`],
    ) as Array<{ id: string }>;
    return row.id;
  };

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenantId = (await dataSource.getRepository(TenantEntity).save({ name: `variable-keys-${randomUUID()}` })).id;
    templateA = await insertTemplate();
    templateB = await insertTemplate();
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM configured_variable WHERE tenant_id = $1', [tenantId]);
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await dataSource.getRepository(TenantEntity).delete(tenantId);
    await dataSource.destroy();
  });

  it('lets two templates own the same local key independently', async () => {
    const first = await service().createTemplate(tenantId, templateA, { key: 'campaign_note', label: 'Ghi chú A', required: false, allowCampaignOverride: false });
    const second = await service().createTemplate(tenantId, templateB, { key: 'campaign_note', label: 'Ghi chú B', required: false, allowCampaignOverride: false });
    expect([first.templateId, second.templateId]).toEqual([templateA, templateB]);
    expect(first.label).not.toBe(second.label);
  });

  it('refuses a second variable with the same key inside one template', async () => {
    await service().createTemplate(tenantId, templateA, { key: 'quarter', label: 'Quý', required: false, allowCampaignOverride: false });
    await expect(service().createTemplate(tenantId, templateA, { key: 'quarter', label: 'Quý (lặp)', required: false, allowCampaignOverride: false }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFIGURED_VARIABLE_KEY_CONFLICT' }) });
  });

  it('refuses a template variable that would shadow an existing global', async () => {
    await service().createGlobal(tenantId, { key: 'company_name', label: 'Tên công ty', defaultValue: 'Alta', allowCampaignOverride: false, required: false });
    await expect(service().createTemplate(tenantId, templateA, { key: 'company_name', label: 'Tên công ty', required: false, allowCampaignOverride: false }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFIGURED_VARIABLE_GLOBAL_KEY', variableKey: 'company_name' }) });
  });

  it('refuses a global variable that a template already owns, and names the owning template', async () => {
    await service().createTemplate(tenantId, templateB, { key: 'signature_block', label: 'Chữ ký', required: false, allowCampaignOverride: false });
    await expect(service().createGlobal(tenantId, { key: 'signature_block', label: 'Chữ ký chung', defaultValue: 'Alta', allowCampaignOverride: false, required: false }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFIGURED_VARIABLE_TEMPLATE_KEY', variableKey: 'signature_block', templateId: templateB }) });
  });
});
