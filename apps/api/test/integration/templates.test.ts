import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

describe('Template persistence (M3-S1: BR-TPL-002/009/010, BR-GEN-006)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `templates-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `templates-b-${randomUUID()}` });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await deleteTemplateVersionFixtures(dataSource, [tenantA.id, tenantB.id]);
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.getRepository(TenantEntity).delete([tenantA.id, tenantB.id]);
    await dataSource.destroy();
  });

  it('enforces lifecycle, normalized active names, soft archive, and tenant-bound versions', async () => {
    const name = `  Welcome ${randomUUID()}  `;
    const [template] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, draft_subject, draft_html, draft_text_body)
       VALUES ($1, $2, 'Welcome', '<p>Hello</p>', 'Hello')
       RETURNING id, status, draft_subject, draft_html, draft_text_body`,
      [tenantA.id, name],
    );

    expect(template).toMatchObject({ status: 'draft', draft_subject: 'Welcome', draft_html: '<p>Hello</p>', draft_text_body: 'Hello' });

    await expect(
      dataSource.query(
        `INSERT INTO email_template (tenant_id, name, draft_subject, draft_html, draft_text_body)
         VALUES ($1, $2, 'Duplicate', '<p>Duplicate</p>', 'Duplicate')`,
        [tenantA.id, name.trim().toUpperCase()],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    await dataSource.query(`UPDATE email_template SET status = 'archived', deleted_at = now() WHERE id = $1`, [template.id]);
    await expect(
      dataSource.query(
        `INSERT INTO email_template (tenant_id, name, draft_subject, draft_html, draft_text_body)
         VALUES ($1, $2, 'Replacement', '<p>Replacement</p>', 'Replacement')`,
        [tenantA.id, name.trim().toUpperCase()],
      ),
    ).resolves.toBeDefined();

    await expect(
      dataSource.query(
        `INSERT INTO email_template_version
          (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
         VALUES ($1, $2, 1, 'Cross-tenant', '<p>bad</p>', 'bad', '{"required":[],"optional":[]}'::jsonb, repeat('a', 64), now())`,
        [tenantB.id, template.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('backfills immutable published versions with a SHA-256 content hash', async () => {
    const [template] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, status, draft_subject, draft_html, draft_text_body)
       VALUES ($1, $2, 'published', 'Subject', '<p>Body</p>', 'Body') RETURNING id`,
      [tenantA.id, `Published ${randomUUID()}`],
    );
    const [version] = await dataSource.query(
      `INSERT INTO email_template_version
        (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'Subject', '<p>Body</p>', 'Body', '{"required":[],"optional":[]}'::jsonb, repeat('b', 64), now())
       RETURNING id, content_hash, published_at`,
      [tenantA.id, template.id],
    );

    expect(version.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(version.published_at).toEqual(expect.any(Date));
    await expect(dataSource.query(`UPDATE email_template_version SET subject = 'Mutated' WHERE id = $1`, [version.id])).rejects.toMatchObject({ code: '55000' });
    await expect(dataSource.query(`DELETE FROM email_template_version WHERE id = $1`, [version.id])).rejects.toMatchObject({ code: '55000' });
  });
});
