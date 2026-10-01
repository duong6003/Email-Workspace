import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { CustomFieldsService } from '../../src/custom-fields/custom-fields.service.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

describe('custom-field template dependency protection', () => {
  let dataSource: DataSource;
  let tenantId: string;
  let userId: string;
  const service = () => new CustomFieldsService(dataSource);

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenantId = (await dataSource.getRepository(TenantEntity).save({ name: `custom-field-dependency-${randomUUID()}` })).id;
    userId = (await dataSource.getRepository(AppUserEntity).save({ tenantId, email: `custom-field-${randomUUID()}@example.test`, displayName: 'Custom Field Owner', role: 'admin' })).id;
  });

  afterAll(async () => {
    await deleteTemplateVersionFixtures(dataSource, [tenantId]);
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await dataSource.query('DELETE FROM custom_field_definition WHERE tenant_id = $1', [tenantId]);
    await dataSource.getRepository(AppUserEntity).delete(userId);
    await dataSource.getRepository(TenantEntity).delete(tenantId);
    await dataSource.destroy();
  });

  it('refuses deletion while an active draft references the field key', async () => {
    const field = await service().create(tenantId, { key: 'department', label: 'Department', type: 'text', required: false, sensitive: false });
    const [template] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, draft_subject, draft_html, draft_text_body)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenantId, `Template ${randomUUID()}`, 'Hello {{department}}', '<p>{{department}}</p>', 'Department: {{department}}'],
    );
    await expect(service().remove(tenantId, field.id)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CUSTOM_FIELD_IN_USE', templateId: template.id }) });
  });

  it('allows deletion when no template references the field key', async () => {
    const field = await service().create(tenantId, { key: `unused_${randomUUID().replaceAll('-', '').slice(0, 8)}`, label: 'Unused', type: 'text', required: false, sensitive: false });
    await expect(service().remove(tenantId, field.id)).resolves.toBeUndefined();
  });

  it('refuses deletion when a published version references the field and does not confuse prefix keys', async () => {
    const referenced = await service().create(tenantId, { key: 'team', label: 'Team', type: 'text', required: false, sensitive: false });
    const prefix = await service().create(tenantId, { key: 'team_name', label: 'Team name', type: 'text', required: false, sensitive: false });
    const [template] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1,$2,'published') RETURNING id`,
      [tenantId, `Published ${randomUUID()}`],
    );
    await dataSource.query(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, required_variables, variable_schema_json, content_hash, published_at)
       VALUES ($1,$2,1,'Hello','<p>{{team}}</p>','Hello',ARRAY[]::text[],$3::jsonb,$4,now())`,
      [tenantId, template.id, JSON.stringify({ required: [], optional: ['team'] }), createHash('sha256').update(randomUUID()).digest('hex')],
    );

    await expect(service().remove(tenantId, referenced.id)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CUSTOM_FIELD_IN_USE', templateId: template.id }) });
    await expect(service().remove(tenantId, prefix.id)).resolves.toBeUndefined();
  });

  // Archiving is one-way: there is no unarchive path, and requireActive refuses
  // every change with TEMPLATE_ARCHIVED. So an archived template can never
  // reference the field again, and holding the field hostage forever makes the
  // tenant's custom-field list grow in one direction only -- the draft query
  // beside this one has always filtered deleted_at, this one had not.
  it('allows deletion when the only referencing template has been archived', async () => {
    const key = `retired_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const field = await service().create(tenantId, { key, label: 'Retired', type: 'text', required: false, sensitive: false });
    const [template] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, status, deleted_at) VALUES ($1,$2,'archived', now()) RETURNING id`,
      [tenantId, `Archived ${randomUUID()}`],
    );
    await dataSource.query(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, required_variables, variable_schema_json, content_hash, published_at)
       VALUES ($1,$2,1,'Hello','<p>{{${key}}}</p>','Hello',ARRAY[]::text[],$3::jsonb,$4,now())`,
      [tenantId, template.id, JSON.stringify({ required: [], optional: [key] }), createHash('sha256').update(randomUUID()).digest('hex')],
    );

    await expect(service().remove(tenantId, field.id)).resolves.toBeUndefined();
  });

  it('still refuses deletion when a live template alongside an archived one references the field', async () => {
    const key = `shared_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const field = await service().create(tenantId, { key, label: 'Shared', type: 'text', required: false, sensitive: false });
    const [archived] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, status, deleted_at) VALUES ($1,$2,'archived', now()) RETURNING id`,
      [tenantId, `Archived shared ${randomUUID()}`],
    );
    const [live] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1,$2,'published') RETURNING id`,
      [tenantId, `Live shared ${randomUUID()}`],
    );
    for (const template of [archived, live]) {
      await dataSource.query(
        `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, required_variables, variable_schema_json, content_hash, published_at)
         VALUES ($1,$2,1,'Hello','<p>{{${key}}}</p>','Hello',ARRAY[]::text[],$3::jsonb,$4,now())`,
        [tenantId, template.id, JSON.stringify({ required: [], optional: [key] }), createHash('sha256').update(randomUUID()).digest('hex')],
      );
    }

    await expect(service().remove(tenantId, field.id)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CUSTOM_FIELD_IN_USE', templateId: live.id }) });
  });
});
