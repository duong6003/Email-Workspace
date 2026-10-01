import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { ConfiguredVariablesService } from '../../src/configured-variables/configured-variables.service.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/**
 * A published version freezes its own variable schema, so it may only pin the
 * variables of *its own* template. ADR-032 lets a local key repeat across
 * templates, which makes the owning template_id part of the dependency, not
 * just the key and the scope.
 */
describe('configured variable delete dependency', () => {
  let dataSource: DataSource;
  let tenantId: string;
  let publishedTemplate: string;
  let otherTemplate: string;
  const service = () => new ConfiguredVariablesService(dataSource);

  const insertTemplate = async (status: 'draft' | 'published'): Promise<string> => {
    const [row] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, `Template ${randomUUID()}`, status],
    ) as Array<{ id: string }>;
    return row.id;
  };

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenantId = (await dataSource.getRepository(TenantEntity).save({ name: `variable-dependency-${randomUUID()}` })).id;
    publishedTemplate = await insertTemplate('published');
    otherTemplate = await insertTemplate('draft');
    await dataSource.query(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, required_variables, variable_schema_json, content_hash, published_at)
       VALUES ($1,$2,1,'Xin chào','<p>{{campaign_note}}</p>','Xin chào',ARRAY[]::text[],$3::jsonb,$4,now())`,
      [
        tenantId,
        publishedTemplate,
        JSON.stringify({ required: [], optional: ['campaign_note'], configured: { campaign_note: { label: 'Ghi chú', scope: 'template', allowCampaignOverride: false } } }),
        createHash('sha256').update(randomUUID()).digest('hex'),
      ],
    );
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM configured_variable WHERE tenant_id = $1', [tenantId]);
    await deleteTemplateVersionFixtures(dataSource, [tenantId]);
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await dataSource.getRepository(TenantEntity).delete(tenantId);
    await dataSource.destroy();
  });

  it('refuses to delete the variable the published version froze', async () => {
    const pinned = await service().createTemplate(tenantId, publishedTemplate, { key: 'campaign_note', label: 'Ghi chú', required: false, allowCampaignOverride: false });
    await expect(service().remove(tenantId, pinned.id, 'template'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFIGURED_VARIABLE_IN_USE', templateId: publishedTemplate }) });
  });

  it('still deletes another template\'s variable that merely shares the key', async () => {
    const unrelated = await service().createTemplate(tenantId, otherTemplate, { key: 'campaign_note', label: 'Ghi chú khác', required: false, allowCampaignOverride: false });
    await expect(service().remove(tenantId, unrelated.id, 'template')).resolves.toBeUndefined();
  });
});
