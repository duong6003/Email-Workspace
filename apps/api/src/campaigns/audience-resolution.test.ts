import { describe, expect, it } from 'vitest';
import { resolveActionableRecipientIds, resolveAudience, resolveSkippedRecipients, type AudienceCandidate } from './audience-resolution.js';

/**
 * M4-S2 (BR-SEG-008/009, BR-CMP-002/003, BR-REC-003). Pure classification over
 * candidate rows, so the union/dedup/eligibility rules are provable without a
 * database. CP2 proves the SQL produces these candidates for real.
 *
 * The resolver is deliberately tolerant of duplicates in its input: whether the
 * query de-duplicates or not, the same answer must come out, because this is
 * the one function both the preview and (later) the send path call. A preview
 * that is merely a good estimate of what will be sent is the defect this slice
 * exists to prevent.
 */
function candidate(overrides: Partial<AudienceCandidate> & Pick<AudienceCandidate, 'recipientId'>): AudienceCandidate {
  return {
    normalizedEmail: `${overrides.recipientId}@example.test`,
    subscriptionStatus: 'active',
    deleted: false,
    excludedByList: false,
    excludedByTag: false,
    excludedByRecipient: false,
    displayName: '',
    ...overrides,
  };
}

describe('resolveAudience', () => {
  it('counts nothing for an empty candidate set', () => {
    const result = resolveAudience([], { sampleLimit: 10 });

    expect(result).toMatchObject({ totalMatched: 0, totalUnique: 0, deduplicated: 0, actionable: 0, skipped: 0 });
    expect(result.skippedByReason).toEqual([]);
    expect(result.sample).toEqual([]);
  });

  it('BR-SEG-008: a recipient matched by two sources is counted once and sent once', () => {
    const result = resolveAudience(
      [candidate({ recipientId: 'r1' }), candidate({ recipientId: 'r1' })],
      { sampleLimit: 10 },
    );

    expect(result.totalMatched).toBe(2);
    expect(result.totalUnique).toBe(1);
    expect(result.deduplicated).toBe(1);
    expect(result.actionable).toBe(1);
  });

  it('BR-CMP-002: two distinct recipient rows sharing a normalized email collapse to one', () => {
    // Deduplication is a merge, not a skip: BR-CMP-002's "một recipient chỉ có
    // một campaign_recipient" collapses several matches into one person, so a
    // collapsed row was never a second person to exclude. It is reported as
    // `deduplicated`, and never appears in `skippedByReason`.
    const result = resolveAudience(
      [
        candidate({ recipientId: 'r1', normalizedEmail: 'shared@example.test' }),
        candidate({ recipientId: 'r2', normalizedEmail: 'shared@example.test' }),
      ],
      { sampleLimit: 10 },
    );

    expect(result.totalUnique).toBe(1);
    expect(result.deduplicated).toBe(1);
    expect(result.actionable).toBe(1);
    expect(result.skippedByReason).toEqual([]);
  });

  it('BR-SEG-009: an included recipient that is also excluded is dropped, naming which exclusion did it', () => {
    const result = resolveAudience(
      [
        candidate({ recipientId: 'byList', excludedByList: true }),
        candidate({ recipientId: 'byTag', excludedByTag: true }),
        candidate({ recipientId: 'byRecipient', excludedByRecipient: true }),
      ],
      { sampleLimit: 10 },
    );

    expect(result.actionable).toBe(0);
    expect(result.skippedByReason).toEqual(
      expect.arrayContaining([
        { reason: 'excluded_by_list', count: 1 },
        { reason: 'excluded_by_tag', count: 1 },
        { reason: 'excluded_by_recipient', count: 1 },
      ]),
    );
  });

  it('BR-CMP-003 / BR-REC-003: every ineligible state is skipped under its own reason, and only active sends', () => {
    const result = resolveAudience(
      [
        candidate({ recipientId: 'active' }),
        candidate({ recipientId: 'paused', subscriptionStatus: 'paused' }),
        candidate({ recipientId: 'unsub', subscriptionStatus: 'unsubscribed' }),
        candidate({ recipientId: 'bounced', subscriptionStatus: 'bounced' }),
        candidate({ recipientId: 'gone', deleted: true }),
      ],
      { sampleLimit: 10 },
    );

    expect(result.actionable).toBe(1);
    expect(result.skippedByReason).toEqual(
      expect.arrayContaining([
        { reason: 'status_paused', count: 1 },
        { reason: 'status_unsubscribed', count: 1 },
        { reason: 'status_bounced', count: 1 },
        { reason: 'deleted', count: 1 },
      ]),
    );
  });

  it('reports the compliance reason, not the intent reason, when a recipient is both unsubscribed and excluded', () => {
    // Deliberate, documented precedence: an unsubscribed recipient must be
    // reported as unsubscribed even when the operator also excluded them.
    // BR-CMP-003/BR-REC-003 are P0 compliance rules; BR-SEG-009 records intent,
    // and intent must not be able to mask a compliance fact in the preview.
    const result = resolveAudience(
      [candidate({ recipientId: 'both', subscriptionStatus: 'unsubscribed', excludedByTag: true })],
      { sampleLimit: 10 },
    );

    expect(result.skippedByReason).toEqual([{ reason: 'status_unsubscribed', count: 1 }]);
  });

  it('keeps both arithmetic identities: unique + deduplicated === matched, and actionable + skipped === unique', () => {
    const result = resolveAudience(
      [
        candidate({ recipientId: 'a' }),
        candidate({ recipientId: 'b', subscriptionStatus: 'paused' }),
        candidate({ recipientId: 'c', excludedByList: true }),
        candidate({ recipientId: 'a' }),
        candidate({ recipientId: 'd', deleted: true }),
      ],
      { sampleLimit: 10 },
    );

    expect(result.totalUnique + result.deduplicated).toBe(result.totalMatched);
    expect(result.actionable + result.skipped).toBe(result.totalUnique);
    expect(result.skippedByReason.reduce((sum, entry) => sum + entry.count, 0)).toBe(result.skipped);
  });

  it('bounds the sample without distorting the counts', () => {
    const many = Array.from({ length: 25 }, (_, index) => candidate({ recipientId: `r${index}` }));

    const result = resolveAudience(many, { sampleLimit: 10 });

    expect(result.sample).toHaveLength(10);
    expect(result.totalUnique).toBe(25);
    expect(result.actionable).toBe(25);
  });

  it('explains each sampled recipient, so a skipped row carries its own reason', () => {
    const result = resolveAudience(
      [candidate({ recipientId: 'ok' }), candidate({ recipientId: 'no', subscriptionStatus: 'bounced' })],
      { sampleLimit: 10 },
    );

    expect(result.sample).toEqual([
      expect.objectContaining({ recipientId: 'ok', skipReason: null }),
      expect.objectContaining({ recipientId: 'no', skipReason: 'status_bounced' }),
    ]);
  });
});

/**
 * M4-S3 (BR-CMP-004): unlike resolveAudience()'s response (bounded sample only
 * — an unbounded id list has no place in a public preview response, see M4-S2's
 * own plan §5 Risks), variable validation genuinely needs every actionable
 * recipient id to check across, not a page of them. Shares classify()'s
 * eligibility decision with resolveAudience() rather than re-deriving it, so
 * the two can never silently disagree about who is actionable.
 */
describe('resolveActionableRecipientIds', () => {
  it('returns nothing for an empty candidate set', () => {
    expect(resolveActionableRecipientIds([])).toEqual([]);
  });

  it('agrees with resolveAudience() on actionable count for the same input, including dedup and precedence', () => {
    const candidates = [
      candidate({ recipientId: 'r1' }),
      candidate({ recipientId: 'r1' }),
      candidate({ recipientId: 'r2', subscriptionStatus: 'bounced' }),
      candidate({ recipientId: 'r3', excludedByTag: true }),
      candidate({ recipientId: 'r4' }),
    ];

    const ids = resolveActionableRecipientIds(candidates);
    const resolution = resolveAudience(candidates, { sampleLimit: 0 });

    expect(ids).toEqual(['r1', 'r4']);
    expect(ids).toHaveLength(resolution.actionable);
  });

  it('deduplicates a shared normalized email the same way resolveAudience() does', () => {
    const ids = resolveActionableRecipientIds([
      candidate({ recipientId: 'active', normalizedEmail: 'shared@example.test' }),
      candidate({ recipientId: 'deleted-dup', normalizedEmail: 'shared@example.test', deleted: true }),
    ]);
    expect(ids).toEqual(['active']);
  });
});

/**
 * M4-S4 (BR-CMP-007): the freeze must record every skipped recipient with
 * its reason, not just a count -- unlike resolveAudience()'s bounded sample,
 * this is the unbounded id+reason pairing resolveActionableRecipientIds
 * already provides for the sendable half. Shares classify() with both, so
 * a snapshot can never disagree with the preview about who was skipped.
 */
describe('resolveSkippedRecipients', () => {
  it('returns nothing for an empty candidate set', () => {
    expect(resolveSkippedRecipients([])).toEqual([]);
  });

  it('returns nothing when every candidate is actionable', () => {
    expect(resolveSkippedRecipients([candidate({ recipientId: 'r1' })])).toEqual([]);
  });

  it('pairs each skipped recipient with its classify() reason, in the same precedence resolveAudience() uses', () => {
    const skipped = resolveSkippedRecipients([
      candidate({ recipientId: 'active' }),
      candidate({ recipientId: 'gone', deleted: true }),
      candidate({ recipientId: 'both', subscriptionStatus: 'unsubscribed', excludedByTag: true }),
      candidate({ recipientId: 'byList', excludedByList: true }),
    ]);

    expect(skipped).toEqual([
      { recipientId: 'gone', reason: 'deleted' },
      { recipientId: 'both', reason: 'status_unsubscribed' },
      { recipientId: 'byList', reason: 'excluded_by_list' },
    ]);
  });

  it('deduplicates a shared normalized email the same way resolveAudience() does, keeping the first-seen candidate', () => {
    const skipped = resolveSkippedRecipients([
      candidate({ recipientId: 'first', normalizedEmail: 'shared@example.test', excludedByList: true }),
      candidate({ recipientId: 'second-dup', normalizedEmail: 'shared@example.test', excludedByTag: true }),
    ]);

    expect(skipped).toEqual([{ recipientId: 'first', reason: 'excluded_by_list' }]);
  });

  it('agrees with resolveAudience() on the skipped count for the same input', () => {
    const candidates = [
      candidate({ recipientId: 'r1' }),
      candidate({ recipientId: 'r2', subscriptionStatus: 'bounced' }),
      candidate({ recipientId: 'r3', excludedByTag: true }),
      candidate({ recipientId: 'r4' }),
    ];

    const skipped = resolveSkippedRecipients(candidates);
    const resolution = resolveAudience(candidates, { sampleLimit: 0 });

    expect(skipped).toHaveLength(resolution.skipped);
  });
});
