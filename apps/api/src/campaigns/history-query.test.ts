import { describe, expect, it } from 'vitest';
import { historyListQuerySchema, historyRecipientsQuerySchema } from './dto/history.dto.js';
import { buildHistoryListSql, buildHistoryRecipientsSql, decodeCursor, encodeCursor, encodeRecipientCursor } from './history-query.js';

describe('historyListQuerySchema (BR-HIS-001)', () => {
  it('defaults limit to 25 without a status filter (newest-first is applied at query time, not here)', () => {
    const parsed = historyListQuerySchema.parse({});
    expect(parsed).toEqual({ limit: 25, includeDrafts: false });
  });

  it('accepts every filter field named by BR-HIS-001', () => {
    const parsed = historyListQuerySchema.parse({
      status: 'partial_failed',
      dateFrom: '2026-08-01T00:00:00Z',
      dateTo: '2026-08-31T23:59:59Z',
      senderConfigId: '11111111-1111-4111-8111-111111111111',
      createdBy: '22222222-2222-4222-8222-222222222222',
      search: 'welcome',
      limit: 10,
      cursor: 'abc',
    });
    expect(parsed.status).toBe('partial_failed');
    expect(parsed.limit).toBe(10);
  });

  it('rejects a limit above 100', () => {
    expect(() => historyListQuerySchema.parse({ limit: 101 })).toThrow();
  });

  it('rejects a limit below 1', () => {
    expect(() => historyListQuerySchema.parse({ limit: 0 })).toThrow();
  });

  it('rejects an unknown query key', () => {
    expect(() => historyListQuerySchema.parse({ bogus: 'x' })).toThrow();
  });

  it('accepts includeDrafts and scope for the campaign list surface (ADR-034)', () => {
    const parsed = historyListQuerySchema.parse({ includeDrafts: 'true', scope: 'mine' });
    expect(parsed.includeDrafts).toBe(true);
    expect(parsed.scope).toBe('mine');
  });

  /**
   * Query parameters arrive as strings, and `z.coerce.boolean()` is
   * `Boolean(input)` -- which makes the string 'false' TRUE. That would turn
   * an explicit opt-out into an opt-in for a permission-bearing flag, so the
   * schema must parse the string form itself rather than coerce it.
   */
  it('treats the string "false" as false, not as a truthy string', () => {
    expect(historyListQuerySchema.parse({ includeDrafts: 'false' }).includeDrafts).toBe(false);
    expect(historyListQuerySchema.parse({ includeDrafts: false }).includeDrafts).toBe(false);
    expect(historyListQuerySchema.parse({ includeDrafts: true }).includeDrafts).toBe(true);
  });

  it('rejects an includeDrafts value that is neither boolean nor "true"/"false"', () => {
    expect(() => historyListQuerySchema.parse({ includeDrafts: 'yes' })).toThrow();
  });

  it('accepts status=draft, which the campaign list can filter to', () => {
    expect(historyListQuerySchema.parse({ status: 'draft' }).status).toBe('draft');
  });

  it('rejects a status outside the campaign vocabulary', () => {
    expect(() => historyListQuerySchema.parse({ status: 'archived' })).toThrow();
  });

  it('rejects an unknown scope', () => {
    expect(() => historyListQuerySchema.parse({ scope: 'everyone' })).toThrow();
  });
});

/**
 * ADR-034. These pin the list query against the same rule
 * CampaignsService.assertDraftAccess applies to a direct GET, so the list can
 * never surface a draft a direct read would refuse. Changing one without the
 * other fails here rather than leaking a draft between users.
 */
describe('campaign list draft visibility (ADR-034)', () => {
  const parse = (input: Record<string, unknown>) => historyListQuerySchema.parse(input);
  const viewer = { actorId: 'u-1', canManageContent: false, canManageAllDrafts: false };
  const operator = { actorId: 'u-1', canManageContent: true, canManageAllDrafts: false };
  const admin = { actorId: 'u-1', canManageContent: true, canManageAllDrafts: true };

  it('excludes drafts when includeDrafts is not set', () => {
    const built = buildHistoryListSql(parse({}), 'tenant-1', admin);
    expect(built.sql).toContain("campaign.status <> 'draft'");
  });

  it('excludes drafts for a caller without content:manage even when asked', () => {
    const built = buildHistoryListSql(parse({ includeDrafts: 'true' }), 'tenant-1', viewer);
    expect(built.sql).toContain("campaign.status <> 'draft'");
    expect(built.sql).not.toContain('campaign.created_by =');
  });

  it('limits drafts to the caller own rows for a non-admin content manager', () => {
    const built = buildHistoryListSql(parse({ includeDrafts: 'true' }), 'tenant-1', operator);
    expect(built.sql).toContain("(campaign.status <> 'draft' OR campaign.created_by =");
    expect(built.params).toContain('u-1');
  });

  it('applies no draft predicate at all for an admin who manages every draft', () => {
    const built = buildHistoryListSql(parse({ includeDrafts: 'true' }), 'tenant-1', admin);
    expect(built.sql).not.toContain("campaign.status <> 'draft'");
    expect(built.sql).not.toContain('campaign.created_by =');
  });

  it('honours scope=mine for an admin, restricting drafts to their own', () => {
    const built = buildHistoryListSql(parse({ includeDrafts: 'true', scope: 'mine' }), 'tenant-1', admin);
    expect(built.sql).toContain("(campaign.status <> 'draft' OR campaign.created_by =");
  });

  it('falls back to excluding drafts when the caller has no actor id', () => {
    const anonymous = { actorId: null, canManageContent: true, canManageAllDrafts: false };
    const built = buildHistoryListSql(parse({ includeDrafts: 'true' }), 'tenant-1', anonymous);
    expect(built.sql).toContain("campaign.status <> 'draft'");
    expect(built.sql).not.toContain('campaign.created_by =');
  });

  it('keeps the tenant predicate and its parameter first in every case', () => {
    for (const caller of [viewer, operator, admin]) {
      const built = buildHistoryListSql(parse({ includeDrafts: 'true' }), 'tenant-1', caller);
      expect(built.sql).toContain('campaign.tenant_id = $1');
      expect(built.params[0]).toBe('tenant-1');
    }
  });
});

describe('history recipient drill-down (BR-HIS-003)', () => {
  it('validates message status, search and bounded page size', () => {
    expect(historyRecipientsQuerySchema.parse({ status: 'failed', search: 'an@example.test', limit: 25 })).toEqual({ status: 'failed', search: 'an@example.test', limit: 25 });
    expect(() => historyRecipientsQuerySchema.parse({ status: 'unknown' })).toThrow();
  });

  it('builds a tenant/campaign scoped query over frozen recipient email and latest attempt reason', () => {
    const cursor = encodeRecipientCursor('a@example.test', '33333333-3333-4333-8333-333333333333');
    const built = buildHistoryRecipientsSql(historyRecipientsQuerySchema.parse({ status: 'failed', cursor }), 'tenant-1', 'campaign-1');
    expect(built.sql).toContain('cr.tenant_id = $1');
    expect(built.sql).toContain('cr.campaign_id = $2');
    expect(built.sql).toContain('WITH recipient_page AS MATERIALIZED');
    expect(built.sql).toContain('page.recipient_email AS email');
    expect(built.sql).toContain('latest.provider_response AS "failureReason"');
    expect(built.sql.indexOf('LIMIT')).toBeLessThan(built.sql.indexOf('LEFT JOIN LATERAL'));
  });
});

describe('history cursor (BR-HIS-001 keyset pagination)', () => {
  it('round-trips a sort value and id', () => {
    const cursor = encodeCursor('2026-08-10T14:20:00.000Z', '33333333-3333-4333-8333-333333333333');
    expect(decodeCursor(cursor)).toEqual({
      sortValue: '2026-08-10T14:20:00.000Z',
      id: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('throws a message naming the cursor as invalid when malformed', () => {
    expect(() => decodeCursor('not-a-real-cursor')).toThrow('Invalid history cursor.');
  });

  it('throws when a decoded part is empty', () => {
    const cursor = Buffer.from('|missing-sort-value', 'utf8').toString('base64url');
    expect(() => decodeCursor(cursor)).toThrow('Invalid history cursor.');
  });
});
