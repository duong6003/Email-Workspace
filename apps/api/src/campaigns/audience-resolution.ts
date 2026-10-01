import type { RecipientSubscriptionStatus } from '../database/entities/recipient.entity.js';

/**
 * One reason per cause, so a preview can answer "why is this person not
 * receiving the email?" concretely. BR-CMP-003 also names a fifth cause,
 * "suppressed", which has no backing data anywhere in the schema or the rule
 * catalogue — it is deliberately absent from this union rather than present
 * and unreachable. See the M4-S2 decision recorded in EXECPLAN §20.
 */
export type AudienceSkipReason =
  | 'deleted'
  | 'status_paused'
  | 'status_unsubscribed'
  | 'status_bounced'
  | 'excluded_by_list'
  | 'excluded_by_tag'
  | 'excluded_by_recipient';

export type AudienceCandidate = {
  recipientId: string;
  normalizedEmail: string;
  displayName: string;
  subscriptionStatus: RecipientSubscriptionStatus;
  deleted: boolean;
  excludedByList: boolean;
  excludedByTag: boolean;
  excludedByRecipient: boolean;
};

export type AudienceSampleEntry = {
  recipientId: string;
  normalizedEmail: string;
  displayName: string;
  subscriptionStatus: RecipientSubscriptionStatus;
  skipReason: AudienceSkipReason | null;
};

export type AudienceResolution = {
  /** Rows matched by the include sources, before any deduplication. */
  totalMatched: number;
  /** The real audience size: distinct people after both dedup rules. */
  totalUnique: number;
  /** How many matched rows collapsed into an already-seen person. */
  deduplicated: number;
  actionable: number;
  skipped: number;
  skippedByReason: { reason: AudienceSkipReason; count: number }[];
  sample: AudienceSampleEntry[];
};

const STATUS_SKIP: Partial<Record<RecipientSubscriptionStatus, AudienceSkipReason>> = {
  paused: 'status_paused',
  unsubscribed: 'status_unsubscribed',
  bounced: 'status_bounced',
};

/**
 * Precedence is deliberate and ordered by how binding the fact is, not by how
 * it was produced:
 *
 * 1. `deleted` — the row is not really there.
 * 2. status — BR-CMP-003 / BR-REC-003 are P0 compliance rules. An unsubscribed
 *    recipient is reported as unsubscribed even when the operator also excluded
 *    them, so operator intent can never mask a compliance fact in the preview.
 * 3. exclusion — BR-SEG-009 operator intent, reported when nothing above applies.
 *
 * `duplicate` is decided before any of these, because identity comes first: the
 * second sighting of one recipient is not a second person to classify.
 */
function classify(candidate: AudienceCandidate): AudienceSkipReason | null {
  if (candidate.deleted) return 'deleted';
  const statusSkip = STATUS_SKIP[candidate.subscriptionStatus];
  if (statusSkip) return statusSkip;
  if (candidate.excludedByRecipient) return 'excluded_by_recipient';
  if (candidate.excludedByList) return 'excluded_by_list';
  if (candidate.excludedByTag) return 'excluded_by_tag';
  return null;
}

/**
 * The single computation both the audience preview and the send path use.
 * Tolerant of duplicate input rows by design: whether the query de-duplicates
 * or not, the same answer comes out, so a preview can never be a mere estimate
 * of what will actually be sent (BR-SEG-008, BR-CMP-002).
 *
 * Deduplication is a *merge*, not a skip. BR-CMP-002's "một recipient chỉ có
 * một campaign_recipient" describes collapsing several matches into one person,
 * so a collapsed row is not a person who was excluded — it never was a second
 * person. It is therefore reported separately as `deduplicated`, and the
 * identity that holds is `actionable + skipped === totalUnique`.
 */
export function resolveAudience(
  candidates: readonly AudienceCandidate[],
  options: { sampleLimit: number },
): AudienceResolution {
  const seenRecipientIds = new Set<string>();
  const seenEmails = new Set<string>();
  const counts = new Map<AudienceSkipReason, number>();
  const sample: AudienceSampleEntry[] = [];

  let totalUnique = 0;
  let deduplicated = 0;
  let actionable = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const email = candidate.normalizedEmail.trim().toLowerCase();
    if (seenRecipientIds.has(candidate.recipientId) || seenEmails.has(email)) {
      deduplicated += 1;
      continue;
    }
    seenRecipientIds.add(candidate.recipientId);
    seenEmails.add(email);
    totalUnique += 1;

    const reason = classify(candidate);
    if (reason) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
      skipped += 1;
    } else {
      actionable += 1;
    }
    if (sample.length < options.sampleLimit) sample.push(entry(candidate, reason));
  }

  return {
    totalMatched: candidates.length,
    totalUnique,
    deduplicated,
    actionable,
    skipped,
    skippedByReason: [...counts.entries()].map(([reason, count]) => ({ reason, count })),
    sample,
  };
}

/**
 * M4-S3 (BR-CMP-004): the full actionable recipient id set, not a bounded
 * sample — unlike resolveAudience()'s response, this never crosses the
 * public preview HTTP boundary, so there is no unbounded-response risk to
 * guard against (see M4-S2's own plan §5). Shares classify()'s eligibility
 * decision with resolveAudience() so the two can never silently disagree
 * about who counts as actionable.
 */
export function resolveActionableRecipientIds(candidates: readonly AudienceCandidate[]): string[] {
  const seenRecipientIds = new Set<string>();
  const seenEmails = new Set<string>();
  const actionableIds: string[] = [];

  for (const candidate of candidates) {
    const email = candidate.normalizedEmail.trim().toLowerCase();
    if (seenRecipientIds.has(candidate.recipientId) || seenEmails.has(email)) continue;
    seenRecipientIds.add(candidate.recipientId);
    seenEmails.add(email);
    if (!classify(candidate)) actionableIds.push(candidate.recipientId);
  }

  return actionableIds;
}

export type SkippedAudienceCandidate = { recipientId: string; reason: AudienceSkipReason };

/**
 * M4-S4 (BR-CMP-007): the full skipped id+reason set, not a bounded sample --
 * a frozen campaign_recipient row is written for every skipped person, so the
 * freeze needs all of them, not resolveAudience()'s preview-sized sample.
 * Shares classify() with resolveAudience()/resolveActionableRecipientIds()
 * so the three can never disagree about who was skipped or why.
 */
export function resolveSkippedRecipients(candidates: readonly AudienceCandidate[]): SkippedAudienceCandidate[] {
  const seenRecipientIds = new Set<string>();
  const seenEmails = new Set<string>();
  const skipped: SkippedAudienceCandidate[] = [];

  for (const candidate of candidates) {
    const email = candidate.normalizedEmail.trim().toLowerCase();
    if (seenRecipientIds.has(candidate.recipientId) || seenEmails.has(email)) continue;
    seenRecipientIds.add(candidate.recipientId);
    seenEmails.add(email);
    const reason = classify(candidate);
    if (reason) skipped.push({ recipientId: candidate.recipientId, reason });
  }

  return skipped;
}

function entry(candidate: AudienceCandidate, skipReason: AudienceSkipReason | null): AudienceSampleEntry {
  return {
    recipientId: candidate.recipientId,
    normalizedEmail: candidate.normalizedEmail,
    displayName: candidate.displayName,
    subscriptionStatus: candidate.subscriptionStatus,
    skipReason,
  };
}
