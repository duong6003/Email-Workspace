import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { runInTenantContext } from '../../src/database/tenant-transaction.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { RecipientListEntity } from '../../src/database/entities/recipient-list.entity.js';
import { TagEntity } from '../../src/database/entities/tag.entity.js';
import { AudienceCandidatesRepository, type AudienceSelectors } from '../../src/campaigns/audience-candidates.repository.js';
import { resolveAudience } from '../../src/campaigns/audience-resolution.js';
import { testDatabaseUrl } from './test-database-url.js';

/**
 * M4-S2 (BR-SEG-008/009, BR-CMP-002/003, BR-REC-003). Proves the real SQL
 * produces the candidate rows resolveAudience() classifies -- A1-A7 from
 * M4-S2-AUDIENCE-PLAN.md, against real PostgreSQL and real RLS.
 */
describe('Audience candidate query (M4-S2)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;

  const emptySelectors: AudienceSelectors = {
    listIds: [], tagIds: [], recipientIds: [], excludeListIds: [], excludeTagIds: [], excludeRecipientIds: [],
  };

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `audience-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `audience-b-${randomUUID()}` });
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM recipient_tag WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(TagEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(TagEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(TenantEntity).delete([tenantA.id, tenantB.id]);
    await dataSource.destroy();
  });

  async function recipient(tenantId: string, overrides: Partial<RecipientEntity> = {}) {
    return dataSource.getRepository(RecipientEntity).save({
      tenantId, email: `audience-${randomUUID()}@example.test`, ...overrides,
    });
  }

  async function list(tenantId: string) {
    return dataSource.getRepository(RecipientListEntity).save({ tenantId, name: `list-${randomUUID()}` });
  }

  async function tag(tenantId: string) {
    return dataSource.getRepository(TagEntity).save({ tenantId, name: `tag-${randomUUID()}`, color: '#ff0000' });
  }

  async function addToList(tenantId: string, listId: string, recipientId: string) {
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenantId, listId, recipientId, 'manual'],
    );
  }

  async function addTag(tenantId: string, tagId: string, recipientId: string) {
    await dataSource.query(
      'INSERT INTO recipient_tag (tenant_id, tag_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenantId, tagId, recipientId, 'manual'],
    );
  }

  async function candidates(tenantId: string, selectors: AudienceSelectors) {
    return runInTenantContext(dataSource, tenantId, async (manager) => {
      return new AudienceCandidatesRepository(manager, tenantId).findCandidates(selectors);
    });
  }

  it('empty selectors match nothing', async () => {
    const rows = await candidates(tenantA.id, emptySelectors);
    expect(rows).toEqual([]);
  });

  it('BR-SEG-008: two lists sharing a recipient produce two matched rows that resolve to one actionable', async () => {
    const r = await recipient(tenantA.id);
    const listOne = await list(tenantA.id);
    const listTwo = await list(tenantA.id);
    await addToList(tenantA.id, listOne.id, r.id);
    await addToList(tenantA.id, listTwo.id, r.id);

    const rows = await candidates(tenantA.id, { ...emptySelectors, listIds: [listOne.id, listTwo.id] });
    const result = resolveAudience(rows, { sampleLimit: 10 });

    expect(rows).toHaveLength(2);
    expect(result.totalUnique).toBe(1);
    expect(result.deduplicated).toBe(1);
    expect(result.actionable).toBe(1);
  });

  it('BR-CMP-002: an email reused after soft-delete (BR-GEN-006) still resolves to one actionable, not two', async () => {
    // recipient's normalized-email uniqueness is a *partial* index, active
    // rows only (006_recipient_extensions.sql) -- two active rows can never
    // share an email by construction, so the only real way this case arises
    // is a soft-deleted recipient's list membership surviving alongside a new
    // active recipient that reused the freed address (BR-GEN-006).
    const shared = `dup-${randomUUID()}@example.test`;
    const deleted = await recipient(tenantA.id, { email: shared, deletedAt: new Date() });
    const reused = await recipient(tenantA.id, { email: shared.toUpperCase() });
    const l = await list(tenantA.id);
    await addToList(tenantA.id, l.id, deleted.id);
    await addToList(tenantA.id, l.id, reused.id);

    const rows = await candidates(tenantA.id, { ...emptySelectors, listIds: [l.id] });
    const result = resolveAudience(rows, { sampleLimit: 10 });

    expect(result.totalUnique).toBe(1);
    expect(result.deduplicated).toBe(1);
    expect(result.actionable).toBe(1);
  });

  it('BR-SEG-009: excluding by tag drops a recipient included by list, with the reason attributed to the tag', async () => {
    const r = await recipient(tenantA.id);
    const l = await list(tenantA.id);
    const excludeTag = await tag(tenantA.id);
    await addToList(tenantA.id, l.id, r.id);
    await addTag(tenantA.id, excludeTag.id, r.id);

    const rows = await candidates(tenantA.id, { ...emptySelectors, listIds: [l.id], excludeTagIds: [excludeTag.id] });
    const result = resolveAudience(rows, { sampleLimit: 10 });

    expect(result.actionable).toBe(0);
    expect(result.skippedByReason).toEqual([{ reason: 'excluded_by_tag', count: 1 }]);
  });

  it('BR-CMP-003/BR-REC-003: paused, unsubscribed, bounced and soft-deleted recipients are all reported, only active is actionable', async () => {
    const l = await list(tenantA.id);
    const active = await recipient(tenantA.id);
    const paused = await recipient(tenantA.id, { subscriptionStatus: 'paused' });
    const unsub = await recipient(tenantA.id, { subscriptionStatus: 'unsubscribed', unsubscribedAt: new Date() });
    const bounced = await recipient(tenantA.id, { subscriptionStatus: 'bounced' });
    const gone = await recipient(tenantA.id, { deletedAt: new Date() });
    for (const r of [active, paused, unsub, bounced, gone]) await addToList(tenantA.id, l.id, r.id);

    const rows = await candidates(tenantA.id, { ...emptySelectors, listIds: [l.id] });
    const result = resolveAudience(rows, { sampleLimit: 10 });

    expect(result.actionable).toBe(1);
    expect(result.skippedByReason).toEqual(expect.arrayContaining([
      { reason: 'status_paused', count: 1 },
      { reason: 'status_unsubscribed', count: 1 },
      { reason: 'status_bounced', count: 1 },
      { reason: 'deleted', count: 1 },
    ]));
  });

  it('BR-GEN-002: a list, tag and recipient id belonging to another tenant contribute nothing', async () => {
    const rB = await recipient(tenantB.id);
    const listB = await list(tenantB.id);
    const tagB = await tag(tenantB.id);
    await addToList(tenantB.id, listB.id, rB.id);
    await addTag(tenantB.id, tagB.id, rB.id);

    const rows = await candidates(tenantA.id, {
      ...emptySelectors, listIds: [listB.id], tagIds: [tagB.id], recipientIds: [rB.id],
    });

    expect(rows).toEqual([]);
  });

  it('includes a direct recipientIds selection alongside list/tag matches', async () => {
    const direct = await recipient(tenantA.id);

    const rows = await candidates(tenantA.id, { ...emptySelectors, recipientIds: [direct.id] });
    const result = resolveAudience(rows, { sampleLimit: 10 });

    expect(result.actionable).toBe(1);
  });
});
