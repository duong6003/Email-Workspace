import type { EntityManager } from 'typeorm';
import type { RecipientSubscriptionStatus } from '../database/entities/recipient.entity.js';
import type { AudienceCandidate } from './audience-resolution.js';

export type AudienceSelectors = {
  listIds: string[];
  tagIds: string[];
  recipientIds: string[];
  excludeListIds: string[];
  excludeTagIds: string[];
  excludeRecipientIds: string[];
};

type CandidateRow = {
  recipientId: string;
  normalizedEmail: string;
  displayName: string;
  subscriptionStatus: RecipientSubscriptionStatus;
  deleted: boolean;
  excludedByList: boolean;
  excludedByTag: boolean;
  excludedByRecipient: boolean;
};

/**
 * Reads the raw candidate rows resolveAudience() classifies. tenant_id is
 * filtered explicitly in every branch -- not relying on RLS alone -- matching
 * every other repository in this codebase; RLS (012_rls.sql) is defence in
 * depth, not the only line.
 *
 * One row per (include-source, recipient) match, deliberately not
 * DISTINCT-ed here: resolveAudience()'s totalMatched/deduplicated split needs
 * to see every match to report BR-SEG-008 correctly, so deduplication belongs
 * there, not in this query.
 *
 * ORDER BY matters and is not cosmetic: resolveAudience() keeps the first
 * candidate it sees for any identity and discards later duplicates, so when
 * an email is shared by an active recipient and a soft-deleted one (the only
 * way BR-CMP-002 duplication actually arises here -- recipient's uniqueness
 * index is partial, WHERE deleted_at IS NULL, per 006_recipient_extensions.sql
 * -- two *active* rows can never collide), the active row must sort first.
 * Getting this backwards reports a real, reachable recipient as `deleted`.
 */
export class AudienceCandidatesRepository {
  constructor(
    private readonly manager: EntityManager,
    private readonly tenantId: string,
  ) {}

  async findCandidates(selectors: AudienceSelectors): Promise<AudienceCandidate[]> {
    const rows = await this.manager.query(
      `
      WITH matched AS (
        SELECT recipient_id FROM recipient_list_member WHERE tenant_id = $1 AND list_id = ANY($2::uuid[])
        UNION ALL
        SELECT recipient_id FROM recipient_tag WHERE tenant_id = $1 AND tag_id = ANY($3::uuid[])
        UNION ALL
        SELECT unnest($4::uuid[]) AS recipient_id
      )
      SELECT
        m.recipient_id AS "recipientId",
        r.normalized_email AS "normalizedEmail",
        COALESCE(NULLIF(btrim(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, '')), ''), r.email) AS "displayName",
        r.subscription_status AS "subscriptionStatus",
        (r.deleted_at IS NOT NULL) AS deleted,
        EXISTS (
          SELECT 1 FROM recipient_list_member elm
          WHERE elm.tenant_id = $1 AND elm.recipient_id = m.recipient_id AND elm.list_id = ANY($5::uuid[])
        ) AS "excludedByList",
        EXISTS (
          SELECT 1 FROM recipient_tag etg
          WHERE etg.tenant_id = $1 AND etg.recipient_id = m.recipient_id AND etg.tag_id = ANY($6::uuid[])
        ) AS "excludedByTag",
        (m.recipient_id = ANY($7::uuid[])) AS "excludedByRecipient"
      FROM matched m
      JOIN recipient r ON r.id = m.recipient_id AND r.tenant_id = $1
      ORDER BY (r.deleted_at IS NOT NULL) ASC, m.recipient_id ASC
      `,
      [
        this.tenantId,
        selectors.listIds,
        selectors.tagIds,
        selectors.recipientIds,
        selectors.excludeListIds,
        selectors.excludeTagIds,
        selectors.excludeRecipientIds,
      ],
    ) as CandidateRow[];

    return rows;
  }
}
