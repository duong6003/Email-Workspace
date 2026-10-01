import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { SegmentsService } from '../../src/segments/segments.service.js';
import { RecipientsRepository } from '../../src/recipients/recipients.repository.js';
import { RecipientsService, type ActorContext } from '../../src/recipients/recipients.service.js';
import type { RecipientCreateRequestDto, RecipientListQueryDto, RecipientUpdateRequestDto } from '../../src/recipients/dto/recipient.dto.js';
import { CustomFieldsService } from '../../src/custom-fields/custom-fields.service.js';
import { CustomFieldDefinitionEntity } from '../../src/database/entities/custom-field-definition.entity.js';
import { PERMISSIONS } from '../../src/common/permissions.js';
import { testDatabaseUrl } from './test-database-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

const testActor: ActorContext = { actorId: null, traceId: 'test-trace' };

describe('Recipients (BR-REC-001..010, BR-GEN-002, BR-GEN-006)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `test-tenant-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `test-tenant-b-${randomUUID()}` });
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM recipient_tag WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM recipient_list WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM tag WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(TenantEntity).delete(tenantA.id);
    await dataSource.getRepository(TenantEntity).delete(tenantB.id);
    await dataSource.destroy();
  });

  function repoFor(tenantId: string): RecipientsRepository {
    return new RecipientsRepository(dataSource.manager, tenantId);
  }

  /** Thin per-tenant wrapper over the singleton service, matching this test file's original shape (service is not tenant-bound; every real call site is the controller, which forwards req.auth.tenantId explicitly). */
  function serviceFor(tenantId: string) {
    const customFieldsService = new CustomFieldsService(dataSource);
    const service = new RecipientsService(dataSource, customFieldsService);
    return {
      create: (body: RecipientCreateRequestDto) => service.create(tenantId, body, testActor),
      update: (id: string, body: RecipientUpdateRequestDto, permissions: string[]) => service.update(tenantId, id, body, permissions, testActor),
      remove: (id: string) => service.remove(tenantId, id),
      getOrThrow: (id: string) => service.getOrThrow(tenantId, id),
      list: (query: RecipientListQueryDto) => service.list(tenantId, query),
    };
  }

  function segments(): SegmentsService {
    return new SegmentsService(dataSource);
  }

  async function expectHttpStatus(promise: Promise<unknown>, status: number): Promise<HttpException> {
    try {
      await promise;
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(status);
      return error as HttpException;
    }
    throw new Error(`Expected a rejection with status ${status}, but the promise resolved.`);
  }

  it('BR-REC-001: normalizes email (lowercase + trim) via the DB-generated column', async () => {
    const service = serviceFor(tenantA.id);
    const created = await service.create({ email: '  MiXed.Case@Acme.VN  ', subscriptionStatus: 'active' } as never);
    expect(created.email).toBe('MiXed.Case@Acme.VN');

    const fetched = await repoFor(tenantA.id).findActiveByNormalizedEmail('mixed.case@acme.vn');
    expect(fetched?.id).toBe(created.id);
  });

  it('BR-REC-001: rejects a case/whitespace-insensitive duplicate email within the same tenant with 409 and the existing recipient id', async () => {
    const service = serviceFor(tenantA.id);
    const original = await service.create({ email: `dup-${randomUUID()}@acme.vn`, subscriptionStatus: 'active' } as never);

    const error = await expectHttpStatus(service.create({ email: `  ${original.email.toUpperCase()}  `, subscriptionStatus: 'active' } as never), 409);
    expect((error.getResponse() as { recipientId: string }).recipientId).toBe(original.id);
  });

  it('BR-REC-001: the same email is allowed across different tenants', async () => {
    const email = `cross-tenant-${randomUUID()}@acme.vn`;
    const inA = await serviceFor(tenantA.id).create({ email, subscriptionStatus: 'active' } as never);
    const inB = await serviceFor(tenantB.id).create({ email, subscriptionStatus: 'active' } as never);
    expect(inA.id).not.toBe(inB.id);
  });

  it('BR-GEN-002: a tenant cannot list or read another tenant\'s recipients', async () => {
    const victim = await serviceFor(tenantB.id).create({ email: `victim-${randomUUID()}@tenant-b.test`, subscriptionStatus: 'active' } as never);

    await expectHttpStatus(serviceFor(tenantA.id).getOrThrow(victim.id), 404);

    const listFromA = await serviceFor(tenantA.id).list({ limit: 100 } as never);
    expect(listFromA.items.some((item) => item.id === victim.id)).toBe(false);
  });

  it('BR-GEN-006: delete is soft (deleted_at set), never a hard DELETE — the row still exists and is excluded from the active list', async () => {
    const service = serviceFor(tenantA.id);
    const recipient = await service.create({ email: `soft-delete-${randomUUID()}@acme.vn`, subscriptionStatus: 'active' } as never);

    await service.remove(recipient.id);

    const rawRow = await dataSource.getRepository(RecipientEntity).findOne({ where: { id: recipient.id } });
    expect(rawRow).not.toBeNull();
    expect(rawRow?.deletedAt).not.toBeNull();

    await expectHttpStatus(service.getOrThrow(recipient.id), 404);

    const activeList = await service.list({ limit: 200 } as never);
    expect(activeList.items.some((item) => item.id === recipient.id)).toBe(false);
  });

  it('BR-GEN-006: soft-deleting a recipient frees its email for reuse (a new active recipient may reuse it)', async () => {
    const email = `reuse-${randomUUID()}@acme.vn`;
    const service = serviceFor(tenantA.id);
    const first = await service.create({ email, subscriptionStatus: 'active' } as never);
    await service.remove(first.id);

    const second = await service.create({ email, subscriptionStatus: 'active' } as never);
    expect(second.id).not.toBe(first.id);
  });

  it('BR-REC-003: only active/paused/unsubscribed/bounced are valid statuses (DB CHECK constraint)', async () => {
    await expect(
      dataSource.getRepository(RecipientEntity).save({
        tenantId: tenantA.id,
        email: `bad-status-${randomUUID()}@acme.vn`,
        subscriptionStatus: 'not-a-real-status',
      } as never),
    ).rejects.toThrow();
  });

  it('BR-REC-004: reactivating an unsubscribed recipient is refused without Admin + confirmReconsent', async () => {
    const service = serviceFor(tenantA.id);
    const recipient = await service.create({ email: `unsub-${randomUUID()}@acme.vn`, subscriptionStatus: 'active' } as never);
    await service.update(recipient.id, { subscriptionStatus: 'unsubscribed' } as never, [PERMISSIONS.RECIPIENT_MANAGE]);

    await expectHttpStatus(service.update(recipient.id, { subscriptionStatus: 'active' } as never, [PERMISSIONS.RECIPIENT_MANAGE]), 403);

    await expectHttpStatus(
      service.update(recipient.id, { subscriptionStatus: 'active', confirmReconsent: true } as never, [PERMISSIONS.RECIPIENT_MANAGE]),
      403,
    );
  });

  it('BR-REC-004: Admin + confirmReconsent successfully reactivates an unsubscribed recipient', async () => {
    const service = serviceFor(tenantA.id);
    const recipient = await service.create({ email: `reconsent-${randomUUID()}@acme.vn`, subscriptionStatus: 'active' } as never);
    await service.update(recipient.id, { subscriptionStatus: 'unsubscribed' } as never, [PERMISSIONS.RECIPIENT_MANAGE]);

    const reactivated = await service.update(recipient.id, { subscriptionStatus: 'active', confirmReconsent: true } as never, [
      PERMISSIONS.RECIPIENT_MANAGE,
      PERMISSIONS.SETTINGS_MANAGE,
    ]);
    expect(reactivated.subscriptionStatus).toBe('active');
  });

  it('BR-REC-007/BR-REC-008: search and status filter narrow the result set, cursor pagination is stable', async () => {
    const service = serviceFor(tenantA.id);
    const marker = randomUUID().slice(0, 8);
    for (let i = 0; i < 5; i += 1) {
      await service.create({ email: `page-${marker}-${i}@acme.vn`, firstName: `Marker${marker}`, subscriptionStatus: i === 0 ? 'paused' : 'active' } as never);
    }

    const searched = await service.list({ search: marker, limit: 100 } as never);
    expect(searched.items).toHaveLength(5);

    const filtered = await service.list({ search: marker, status: ['paused'], limit: 100 } as never);
    expect(filtered.items).toHaveLength(1);

    const page1 = await service.list({ search: marker, limit: 2 } as never);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await service.list({ search: marker, limit: 2, cursor: page1.nextCursor! } as never);
    expect(page2.items).toHaveLength(2);
    const page1Ids = page1.items.map((item) => item.id);
    const page2Ids = page2.items.map((item) => item.id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
  });

  it('BR-SEG-007: list/tag recipient filters use active tenant-scoped memberships and combine categories', async () => {
    const service = serviceFor(tenantA.id);
    const marker = randomUUID().slice(0, 8);
    const [inBoth, onlyList, onlyTag] = await Promise.all([
      service.create({ email: `segment-both-${marker}@acme.vn`, subscriptionStatus: 'active' } as never),
      service.create({ email: `segment-list-${marker}@acme.vn`, subscriptionStatus: 'active' } as never),
      service.create({ email: `segment-tag-${marker}@acme.vn`, subscriptionStatus: 'active' } as never),
    ]);
    const list = await segments().createList(tenantA.id, { name: `List ${marker}` });
    const tag = await segments().createTag(tenantA.id, { name: `Tag ${marker}`, color: '#278b6e' });
    await segments().addListMembers(tenantA.id, list.id, [inBoth.id, onlyList.id]);
    await segments().addTagMembers(tenantA.id, tag.id, [inBoth.id, onlyTag.id]);

    const listOnly = await service.list({ search: marker, listIds: [list.id], limit: 100 } as never);
    expect(listOnly.items.map((item) => item.id).sort()).toEqual([inBoth.id, onlyList.id].sort());

    const tagOnly = await service.list({ search: marker, tagIds: [tag.id], limit: 100 } as never);
    expect(tagOnly.items.map((item) => item.id).sort()).toEqual([inBoth.id, onlyTag.id].sort());

    const combined = await service.list({ search: marker, listIds: [list.id], tagIds: [tag.id], limit: 100 } as never);
    expect(combined.items.map((item) => item.id)).toEqual([inBoth.id]);
  });

  it('BR-REC-010: soft-deleting a recipient does not remove or corrupt an existing campaign_recipient snapshot referencing it', async () => {
    // No CampaignEntity/CampaignRecipientEntity exists yet (M4 scope) -- the
    // `campaign` and `campaign_recipient` tables themselves have existed
    // since 001_initial.sql, so this proves the FK/soft-delete interaction
    // directly via raw SQL rather than waiting for M4's ORM entities.
    //
    // M4-S4 (migration 022) made campaign_recipient.snapshot_id NOT NULL and
    // added an immutability trigger, so this fixture now needs a real
    // campaign_snapshot row to reference, and cleanup must briefly disable
    // that trigger (mirroring template-version-fixtures.ts's own pattern)
    // rather than deleting the frozen rows directly.
    const service = serviceFor(tenantA.id);
    const recipient = await service.create({ email: `snapshot-${randomUUID()}@acme.vn`, firstName: 'Snap', lastName: 'Shot' } as never);

    const [campaign] = await dataSource.query('INSERT INTO campaign (tenant_id, name, status) VALUES ($1, $2, $3) RETURNING id', [
      tenantA.id,
      `test-campaign-${randomUUID()}`,
      // BR-SEND-001's actual terminal-success status is 'completed', not the
      // ad-hoc 'sent' this test used before campaign_status_known (added by
      // M4-S1) started enforcing the real state machine.
      'completed',
    ]);
    const [template] = await dataSource.query('INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, $3) RETURNING id', [
      tenantA.id, `snapshot-template-${randomUUID()}`, 'published',
    ]);
    const [version] = await dataSource.query(
      'INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, content_hash, published_at) VALUES ($1, $2, 1, $3, $4, $5, $6, now()) RETURNING id',
      [tenantA.id, template.id, 'Hi', '<p>Hi</p>', '', createHash('sha256').update(randomUUID()).digest('hex')],
    );
    const [snapshot] = await dataSource.query(
      'INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [tenantA.id, campaign.id, version.id, '{}', '{}', '{}'],
    );
    const mergeData = { email: recipient.email, first_name: 'Snap', last_name: 'Shot' };
    await dataSource.query('INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, status) VALUES ($1, $2, $3, $4, $5, $6)', [
      tenantA.id,
      campaign.id,
      snapshot.id,
      recipient.id,
      JSON.stringify(mergeData),
      'submitted',
    ]);

    await service.remove(recipient.id);

    const [snapshotRow] = await dataSource.query('SELECT merge_data_json, status FROM campaign_recipient WHERE recipient_id = $1', [recipient.id]);
    expect(snapshotRow).toBeDefined();
    expect(snapshotRow.merge_data_json).toEqual(mergeData);
    expect(snapshotRow.status).toBe('submitted');

    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_recipient_test_snapshot_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        await manager.query('DELETE FROM campaign_recipient WHERE recipient_id = $1', [recipient.id]);
        await manager.query('DELETE FROM campaign_snapshot WHERE id = $1', [snapshot.id]);
      } finally {
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
        await manager.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      }
    });
    await deleteTemplateVersionFixtures(dataSource, [tenantA.id]);
    await dataSource.query('DELETE FROM email_template WHERE id = $1', [template.id]);
    await dataSource.query('DELETE FROM campaign WHERE id = $1', [campaign.id]);
  });
});
