import type { HistoryListQueryDto, HistoryRecipientsQueryDto } from './dto/history.dto.js';

/**
 * BR-HIS-001 keyset pagination cursor. Same encoding as
 * NotificationsRepository.listForUser (`base64url` of
 * `${isoTimestamp}|${id}`) so the pattern is not reinvented a second time.
 */
export function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(`${sortValue}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { sortValue: string; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (decoded.length !== 2 || !decoded[0] || !decoded[1]) throw new Error('Invalid history cursor.');
  return { sortValue: decoded[0], id: decoded[1] };
}

export type HistoryListSql = { sql: string; params: unknown[] };

export type HistoryListRow = {
  id: string; name: string; subject: string; status: string;
  scheduledAtUtc: string | Date | null; scheduledTimezone: string | null;
  createdAt: string | Date; createdBy: string | null;
  executionId: string | null; startedAt: string | Date | null; finishedAt: string | Date | null;
  senderConfigId: string | null; sortValue: string | Date;
};

export type HistoryProgressRow = {
  executionId: string; executionStatus: string; progressSeq: string | number;
  pendingCount: number; queuedCount: number; submittedCount: number; deliveredCount: number;
  bouncedCount: number; failedCount: number; skippedCount: number; cancelledCount: number;
  totalSnapshot: number; sendableCount: number;
};

/**
 * BR-HIS-001's list query: newest-first by default, server-filtered,
 * server-paginated. Sort key is `COALESCE(execution.started_at,
 * campaign.scheduled_at_utc, campaign.created_at)` -- a started campaign
 * sorts by when it started, a merely-scheduled one by when it will run, and
 * anything else by creation, which is what "mới nhất" means on this screen.
 * `campaign` has no `started_at` of its own; it lives on the live
 * `campaign_execution` row, joined here via the live (non-superseded)
 * snapshot -- the same live-join pattern `run.ts`'s own
 * `currentExecutionId` already uses.
 */
/**
 * ADR-034. The SQL-side mirror of CampaignsService.assertDraftAccess:
 * `canManageAllDrafts` means admin-role AND settings:manage, exactly as
 * CampaignsService.canManageAllDrafts computes it -- not role alone. Keeping
 * the two in step is what stops the list surfacing a draft that a direct
 * GET /campaigns/:id would refuse.
 */
export type CampaignListViewer = {
  actorId: string | null;
  canManageContent: boolean;
  canManageAllDrafts: boolean;
};

export function buildHistoryListSql(query: HistoryListQueryDto, tenantId: string, viewer: CampaignListViewer): HistoryListSql {
  const params: unknown[] = [tenantId];
  const conditions: string[] = [
    'campaign.tenant_id = $1',
    'campaign.deleted_at IS NULL',
  ];

  // A caller who asks for drafts without content:manage is downgraded to the
  // non-draft result rather than refused: 403 would blank a list they are
  // entitled to read (ADR-034). An actor with no id cannot own anything, so
  // "own drafts only" collapses to "no drafts" rather than an unbounded read.
  const draftsVisible = query.includeDrafts && viewer.canManageContent;
  const ownDraftsOnly = draftsVisible && (!viewer.canManageAllDrafts || query.scope === 'mine');
  if (!draftsVisible || (ownDraftsOnly && !viewer.actorId)) {
    conditions.push("campaign.status <> 'draft'");
  } else if (ownDraftsOnly) {
    params.push(viewer.actorId);
    conditions.push(`(campaign.status <> 'draft' OR campaign.created_by = $${params.length})`);
  }

  if (query.status) {
    params.push(query.status);
    conditions.push(`campaign.status = $${params.length}`);
  }
  if (query.dateFrom) {
    params.push(query.dateFrom);
    conditions.push(`COALESCE(ce.started_at, campaign.scheduled_at_utc, campaign.created_at) >= $${params.length}`);
  }
  if (query.dateTo) {
    params.push(query.dateTo);
    conditions.push(`COALESCE(ce.started_at, campaign.scheduled_at_utc, campaign.created_at) <= $${params.length}`);
  }
  if (query.senderConfigId) {
    params.push(query.senderConfigId);
    conditions.push(`ce.sender_config_id = $${params.length}`);
  }
  if (query.createdBy) {
    params.push(query.createdBy);
    conditions.push(`campaign.created_by = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    conditions.push(`(campaign.name ILIKE $${params.length} OR campaign.subject ILIKE $${params.length})`);
  }
  if (query.cursor) {
    const { sortValue, id } = decodeCursor(query.cursor);
    params.push(sortValue, id);
    const sortParam = params.length - 1;
    const idParam = params.length;
    conditions.push(
      `(COALESCE(ce.started_at, campaign.scheduled_at_utc, campaign.created_at), campaign.id) < (CAST($${sortParam} AS timestamptz), CAST($${idParam} AS uuid))`,
    );
  }

  params.push(query.limit);
  const limitParam = params.length;

  const sql = `
    SELECT campaign.id AS "id", campaign.name AS "name", campaign.subject AS "subject", campaign.status AS "status",
           campaign.scheduled_at_utc AS "scheduledAtUtc", campaign.scheduled_timezone AS "scheduledTimezone",
           campaign.created_at AS "createdAt", campaign.created_by AS "createdBy",
           ce.id AS "executionId", ce.started_at AS "startedAt", ce.finished_at AS "finishedAt",
           ce.sender_config_id AS "senderConfigId",
           COALESCE(ce.started_at, campaign.scheduled_at_utc, campaign.created_at) AS "sortValue"
    FROM campaign
    LEFT JOIN campaign_snapshot cs ON cs.tenant_id = campaign.tenant_id AND cs.campaign_id = campaign.id AND cs.superseded_at IS NULL
    LEFT JOIN campaign_execution ce ON ce.tenant_id = campaign.tenant_id AND ce.snapshot_id = cs.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY COALESCE(ce.started_at, campaign.scheduled_at_utc, campaign.created_at) DESC, campaign.id DESC
    LIMIT $${limitParam}
  `;
  return { sql, params };
}

/**
 * Per-row progress, read from the stored 028 summary (never recomputed) for
 * exactly the page's own execution ids -- a second, narrow query instead of
 * a correlated subquery per row.
 */
export function buildHistoryProgressSql(executionIds: string[], tenantId: string): HistoryListSql {
  const sql = `
    SELECT ce.id AS "executionId", ce.status AS "executionStatus", ce.progress_seq AS "progressSeq",
           ce.pending_count AS "pendingCount", ce.queued_count AS "queuedCount", ce.submitted_count AS "submittedCount",
           ce.delivered_count AS "deliveredCount", ce.bounced_count AS "bouncedCount", ce.failed_count AS "failedCount",
           ce.skipped_count AS "skippedCount", ce.cancelled_count AS "cancelledCount",
           cs.total_snapshot AS "totalSnapshot", cs.sendable_count AS "sendableCount"
    FROM campaign_execution ce
    JOIN campaign_snapshot cs ON cs.id = ce.snapshot_id
    WHERE ce.tenant_id = $1 AND ce.id = ANY($2::uuid[])
  `;
  return { sql, params: [tenantId, executionIds] };
}

type RecipientCursor = { email: string; id: string };

export function encodeRecipientCursor(email: string, id: string): string {
  return Buffer.from(JSON.stringify({ email, id } satisfies RecipientCursor), 'utf8').toString('base64url');
}

function decodeRecipientCursor(cursor: string): RecipientCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<RecipientCursor>;
    if (typeof value.email !== 'string' || typeof value.id !== 'string') throw new Error();
    return { email: value.email, id: value.id };
  } catch {
    throw new Error('Invalid history recipient cursor.');
  }
}

export type HistoryRecipientRow = {
  id: string;
  recipientId: string;
  email: string;
  displayName: string | null;
  status: string;
  skippedReason: string | null;
  attemptCount: number;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorClass: string | null;
  failureReason: string | null;
  lastAttemptAt: string | Date | null;
  submittedAt: string | Date | null;
  deliveredAt: string | Date | null;
  nextRetryAt: string | Date | null;
  updatedAt: string | Date;
};

export function buildHistoryRecipientsSql(query: HistoryRecipientsQueryDto, tenantId: string, campaignId: string): HistoryListSql {
  const params: unknown[] = [tenantId, campaignId];
  const conditions = [
    'cr.tenant_id = $1',
    'cr.campaign_id = $2',
    'cs.superseded_at IS NULL',
  ];
  if (query.status) {
    params.push(query.status);
    conditions.push(`cr.status = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    conditions.push(`(cr.recipient_email ILIKE $${params.length} OR concat_ws(' ', cr.merge_data_json->>'first_name', cr.merge_data_json->>'last_name') ILIKE $${params.length})`);
  }
  if (query.cursor) {
    const cursor = decodeRecipientCursor(query.cursor);
    params.push(cursor.email, cursor.id);
    conditions.push(`(lower(cr.recipient_email), cr.id) > (lower(CAST($${params.length - 1} AS text)), CAST($${params.length} AS uuid))`);
  }
  params.push(query.limit + 1);
  const sql = `
    WITH recipient_page AS MATERIALIZED (
      SELECT cr.id, cr.tenant_id, cr.recipient_id, cr.recipient_email, cr.merge_data_json,
             cr.status, cr.skipped_reason, cr.attempt_count, cr.provider_message_id, cr.updated_at
      FROM campaign_recipient cr
      JOIN campaign_snapshot cs ON cs.id = cr.snapshot_id AND cs.tenant_id = cr.tenant_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY lower(cr.recipient_email), cr.id
      LIMIT $${params.length}
    )
    SELECT page.id, page.recipient_id AS "recipientId", page.recipient_email AS email,
           NULLIF(btrim(concat_ws(' ', page.merge_data_json->>'first_name', page.merge_data_json->>'last_name')), '') AS "displayName",
           page.status, page.skipped_reason AS "skippedReason", page.attempt_count AS "attemptCount",
           COALESCE(page.provider_message_id, latest.provider_message_id) AS "providerMessageId",
           latest.error_code AS "lastErrorCode", latest.error_class AS "lastErrorClass",
           latest.provider_response AS "failureReason", latest.attempted_at AS "lastAttemptAt",
           submitted.attempted_at AS "submittedAt", delivered.occurred_at AS "deliveredAt",
           latest.next_retry_at AS "nextRetryAt", page.updated_at AS "updatedAt"
    FROM recipient_page page
    LEFT JOIN LATERAL (
      SELECT provider_message_id, error_code, error_class, provider_response, attempted_at, next_retry_at
      FROM message_attempt
      WHERE tenant_id = page.tenant_id AND campaign_recipient_id = page.id
      ORDER BY attempt_no DESC LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT attempted_at FROM message_attempt
      WHERE tenant_id = page.tenant_id AND campaign_recipient_id = page.id AND outcome = 'submitted'
      ORDER BY attempted_at DESC LIMIT 1
    ) submitted ON true
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM delivery_event
      WHERE tenant_id = page.tenant_id AND campaign_recipient_id = page.id AND event_type = 'delivered'
      ORDER BY occurred_at DESC LIMIT 1
    ) delivered ON true
    ORDER BY lower(page.recipient_email), page.id
  `;
  return { sql, params };
}
