import { randomUUID } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { RecipientListEntity } from '../../src/database/entities/recipient-list.entity.js';
import { TagEntity } from '../../src/database/entities/tag.entity.js';
import { SegmentsService } from '../../src/segments/segments.service.js';
import { testDatabaseUrl } from './test-database-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

describe('Recipient lists and tags (M2-S2: BR-SEG-001..007/010, BR-REC-005/006)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;
  let recipientA: RecipientEntity;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `segments-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `segments-b-${randomUUID()}` });
    recipientA = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenantA.id, email: `segment-${randomUUID()}@example.test` });
  });

  afterAll(async () => {
    // campaign_snapshot/campaign_recipient are immutable by trigger (M4-S4,
    // migration 022) -- briefly disable them under a transaction-scoped
    // advisory lock, mirroring deleteTemplateVersionFixtures's own pattern,
    // so this defensive cleanup can remove this suite's snapshot fixtures.
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_segments_test_snapshot_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        // M5-S3 CP3: a concurrently-running campaign-send-scan can freeze one
        // of these campaigns the instant it reaches 'queued', so its
        // campaign_execution/message_attempt rows must clear first.
        await manager.query('DELETE FROM message_attempt WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
        await manager.query('DELETE FROM campaign_execution WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
        await manager.query('DELETE FROM campaign_recipient WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
        await manager.query('DELETE FROM campaign_snapshot WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
      } finally {
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
        await manager.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      }
    });
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await deleteTemplateVersionFixtures(dataSource, [tenantA.id, tenantB.id]);
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM recipient_tag WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(TagEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(TagEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(RecipientEntity).delete({ id: recipientA.id });
    await dataSource.getRepository(TenantEntity).delete([tenantA.id, tenantB.id]);
    await dataSource.destroy();
  });

  function service(): SegmentsService {
    return new SegmentsService(dataSource);
  }

  async function expectHttpStatus(promise: Promise<unknown>, status: number): Promise<HttpException> {
    try {
      await promise;
      throw new Error(`Expected HTTP ${status}.`);
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(status);
      return error as HttpException;
    }
  }

  it('keeps list and tag names tenant-scoped, trimmed and case-insensitively unique', async () => {
    const segments = service();
    const list = await segments.createList(tenantA.id, { name: '  Customers  ', description: 'Intentional group' });
    const tag = await segments.createTag(tenantA.id, { name: 'Priority', color: '#ef6f45' });

    expect(list.name).toBe('Customers');
    expect(tag.name).toBe('Priority');
    await expectHttpStatus(segments.createList(tenantA.id, { name: 'customers' }), 409);
    await expectHttpStatus(segments.createTag(tenantA.id, { name: ' priority ', color: '#ef6f45' }), 409);
    await expect(segments.createList(tenantB.id, { name: 'CUSTOMERS' })).resolves.toMatchObject({ name: 'CUSTOMERS' });
  });

  it('computes active-recipient counts and keeps membership idempotent', async () => {
    const segments = service();
    const list = await segments.createList(tenantA.id, { name: `List ${randomUUID()}` });
    const tag = await segments.createTag(tenantA.id, { name: `Tag ${randomUUID()}`, color: '#278b6e' });

    await segments.addListMembers(tenantA.id, list.id, [recipientA.id, recipientA.id]);
    await segments.addTagMembers(tenantA.id, tag.id, [recipientA.id, recipientA.id]);
    await expect(segments.getList(tenantA.id, list.id)).resolves.toMatchObject({ memberCount: 1 });
    await expect(segments.getTag(tenantA.id, tag.id)).resolves.toMatchObject({ memberCount: 1 });

    await dataSource.getRepository(RecipientEntity).update(recipientA.id, { deletedAt: new Date() });
    await expect(segments.getList(tenantA.id, list.id)).resolves.toMatchObject({ memberCount: 0 });
    await expect(segments.getTag(tenantA.id, tag.id)).resolves.toMatchObject({ memberCount: 0 });
    await dataSource.getRepository(RecipientEntity).update(recipientA.id, { deletedAt: null });
    await expect(segments.recipientSegments(tenantA.id, recipientA.id)).resolves.toMatchObject({ lists: [{ id: list.id }], tags: [{ id: tag.id }] });
  });

  it('paginates stable server-side catalogs and never exposes another tenant segment', async () => {
    const segments = service();
    const first = await segments.createList(tenantA.id, { name: `Alpha ${randomUUID()}` });
    const second = await segments.createList(tenantA.id, { name: `Zulu ${randomUUID()}` });
    await expect(segments.listLists(tenantA.id, { search: 'alpha', limit: 1 })).resolves.toMatchObject({ total: 1, items: [{ id: first.id }] });
    const pageOne = await segments.listLists(tenantA.id, { limit: 1 });
    expect(pageOne.nextCursor).toEqual(expect.any(String));
    const pageTwo = await segments.listLists(tenantA.id, { limit: 100, cursor: pageOne.nextCursor! });
    expect(pageTwo.total).toBeGreaterThanOrEqual(2);
    expect(pageTwo.items.map((item) => item.id)).toContain(second.id);
    await expectHttpStatus(segments.getList(tenantB.id, first.id), 404);
  });

  it('soft-deletes lists/tags and removes only their memberships, not recipients', async () => {
    const segments = service();
    const list = await segments.createList(tenantA.id, { name: `Delete list ${randomUUID()}` });
    const tag = await segments.createTag(tenantA.id, { name: `Delete tag ${randomUUID()}`, color: '#7356c8' });
    await segments.addListMembers(tenantA.id, list.id, [recipientA.id]);
    await segments.addTagMembers(tenantA.id, tag.id, [recipientA.id]);

    await segments.removeList(tenantA.id, list.id);
    await segments.removeTag(tenantA.id, tag.id);

    expect(await dataSource.getRepository(RecipientEntity).findOneBy({ id: recipientA.id })).not.toBeNull();
    await expectHttpStatus(segments.getList(tenantA.id, list.id), 404);
    await expectHttpStatus(segments.getTag(tenantA.id, tag.id), 404);
    await expect(dataSource.query('SELECT 1 FROM recipient_list_member WHERE list_id = $1', [list.id])).resolves.toHaveLength(0);
    await expect(dataSource.query('SELECT 1 FROM recipient_tag WHERE tag_id = $1', [tag.id])).resolves.toHaveLength(0);
  });

  it('returns 404 deleting an already-deleted list or tag, and for a nonexistent id', async () => {
    const segments = service();
    const list = await segments.createList(tenantA.id, { name: `Double delete list ${randomUUID()}` });
    const tag = await segments.createTag(tenantA.id, { name: `Double delete tag ${randomUUID()}`, color: '#7356c8' });

    await segments.removeList(tenantA.id, list.id);
    await expectHttpStatus(segments.removeList(tenantA.id, list.id), 404);
    await expectHttpStatus(segments.removeList(tenantA.id, randomUUID()), 404);

    await segments.removeTag(tenantA.id, tag.id);
    await expectHttpStatus(segments.removeTag(tenantA.id, tag.id), 404);
    await expectHttpStatus(segments.removeTag(tenantA.id, randomUUID()), 404);
  });

  it('refuses to delete a list bound to a scheduled campaign snapshot', async () => {
    const segments = service();
    const list = await segments.createList(tenantA.id, { name: `Scheduled list ${randomUUID()}` });
    const [template] = await dataSource.query("INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id", [tenantA.id, `template-${randomUUID()}`]);
    const [version] = await dataSource.query(
      "INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at) VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{\"required\":[],\"optional\":[]}'::jsonb, repeat('a', 64), now()) RETURNING id",
      [tenantA.id, template.id],
    );
    const [campaign] = await dataSource.query("INSERT INTO campaign (tenant_id, name, status, scheduled_at_utc, scheduled_timezone) VALUES ($1, $2, 'scheduled', now() + interval '1 hour', 'Asia/Bangkok') RETURNING id", [tenantA.id, `campaign-${randomUUID()}`]);
    await dataSource.query("INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json) VALUES ($1, $2, $3, '{}'::jsonb, $4::jsonb, '{}'::jsonb)", [tenantA.id, campaign.id, version.id, JSON.stringify({ listIds: [list.id] })]);

    const error = await expectHttpStatus(segments.removeList(tenantA.id, list.id), 409);
    expect(error.getResponse()).toMatchObject({ code: 'LIST_IN_SCHEDULED_CAMPAIGN' });
  });

  it('refuses to delete a list excluded by a scheduled campaign snapshot', async () => {
    const segments = service();
    const list = await segments.createList(tenantA.id, { name: `Scheduled excluded list ${randomUUID()}` });
    const [template] = await dataSource.query("INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id", [tenantA.id, `template-${randomUUID()}`]);
    const [version] = await dataSource.query(
      "INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at) VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{\"required\":[],\"optional\":[]}'::jsonb, repeat('a', 64), now()) RETURNING id",
      [tenantA.id, template.id],
    );
    const [campaign] = await dataSource.query("INSERT INTO campaign (tenant_id, name, status, scheduled_at_utc, scheduled_timezone) VALUES ($1, $2, 'scheduled', now() + interval '1 hour', 'Asia/Bangkok') RETURNING id", [tenantA.id, `campaign-${randomUUID()}`]);
    await dataSource.query("INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json) VALUES ($1, $2, $3, '{}'::jsonb, $4::jsonb, '{}'::jsonb)", [tenantA.id, campaign.id, version.id, JSON.stringify({ excludeListIds: [list.id] })]);

    const error = await expectHttpStatus(segments.removeList(tenantA.id, list.id), 409);
    expect(error.getResponse()).toMatchObject({ code: 'LIST_IN_SCHEDULED_CAMPAIGN' });
  });

  it('deletes a list referenced only by a superseded scheduled campaign snapshot', async () => {
    const segments = service();
    const list = await segments.createList(tenantA.id, { name: `Historical list ${randomUUID()}` });
    const [template] = await dataSource.query("INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id", [tenantA.id, `template-${randomUUID()}`]);
    const [version] = await dataSource.query(
      "INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at) VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{\"required\":[],\"optional\":[]}'::jsonb, repeat('b', 64), now()) RETURNING id",
      [tenantA.id, template.id],
    );
    const [campaign] = await dataSource.query("INSERT INTO campaign (tenant_id, name, status, scheduled_at_utc, scheduled_timezone) VALUES ($1, $2, 'scheduled', now() + interval '1 hour', 'Asia/Bangkok') RETURNING id", [tenantA.id, `campaign-${randomUUID()}`]);
    await dataSource.query("INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, superseded_at) VALUES ($1, $2, $3, '{}'::jsonb, $4::jsonb, '{}'::jsonb, now())", [tenantA.id, campaign.id, version.id, JSON.stringify({ listIds: [list.id] })]);
    await dataSource.query("INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)", [tenantA.id, campaign.id, version.id]);
    const snapshotsBeforeDeletion = await dataSource.query(
      'SELECT to_jsonb(snapshot)::text AS snapshot FROM campaign_snapshot snapshot WHERE campaign_id = $1 ORDER BY frozen_at, id',
      [campaign.id],
    );

    await segments.removeList(tenantA.id, list.id);

    await expectHttpStatus(segments.getList(tenantA.id, list.id), 404);
    await expect(dataSource.query(
      'SELECT to_jsonb(snapshot)::text AS snapshot FROM campaign_snapshot snapshot WHERE campaign_id = $1 ORDER BY frozen_at, id',
      [campaign.id],
    )).resolves.toEqual(snapshotsBeforeDeletion);
  });
});
