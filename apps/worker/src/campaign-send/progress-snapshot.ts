import type pg from 'pg';
import { runInTenantTransaction } from '../tenant-database.js';
import { ETA_WINDOW_MS, type EtaEstimate, type ProgressCounts } from './progress-math.js';
import { estimateEta } from './progress-math.js';
import { buildProgressEvent, type CampaignEventPublisher } from './progress-event.js';

/**
 * Reads and writes the campaign_execution progress summary (migration 028).
 * API-native duplicate at apps/api/src/campaigns/progress-snapshot.ts
 * (DEC-107/DEC-123 transliteration precedent -- neither app can import the
 * other's source). ARCH-PROGRESS-PARITY keeps the two in step.
 */
export type ProgressFacts = {
  counts: ProgressCounts;
  actionable: number;
  etaSampleCount: number;
  etaWindowMs: number;
};

type Queryable = { query: pg.Pool['query'] };

/**
 * The canonical per-status partition (sums to total_snapshot, BR-SEND-002),
 * the actionable denominator (eligibility = 'sendable'), and the ETA sample
 * window -- outcome = 'submitted' attempts only (BR-SEND-005: failed/skipped
 * never inflate throughput).
 */
export async function readProgressFacts(
  client: Queryable,
  tenantId: string,
  snapshotId: string,
  executionId: string,
): Promise<ProgressFacts> {
  const counts: ProgressCounts = { pending: 0, queued: 0, submitted: 0, delivered: 0, bounced: 0, failed: 0, skipped: 0, cancelled: 0 };
  const countRows = (await client.query(
    `SELECT status, count(*)::int AS count FROM campaign_recipient WHERE tenant_id = $1 AND snapshot_id = $2 GROUP BY status`,
    [tenantId, snapshotId],
  )).rows as Array<{ status: keyof ProgressCounts; count: number }>;
  for (const row of countRows) counts[row.status] = row.count;

  const [actionableRow] = (await client.query(
    `SELECT count(*)::int AS actionable FROM campaign_recipient WHERE tenant_id = $1 AND snapshot_id = $2 AND eligibility = 'sendable'`,
    [tenantId, snapshotId],
  )).rows as Array<{ actionable: number }>;

  const [windowRow] = (await client.query(
    `SELECT count(*)::int AS sample_count,
            EXTRACT(EPOCH FROM (max(attempted_at) - min(attempted_at))) * 1000 AS window_ms
     FROM message_attempt
     WHERE tenant_id = $1 AND execution_id = $2 AND outcome = 'submitted'
       AND attempted_at > now() - ($3::double precision * interval '1 millisecond')`,
    [tenantId, executionId, ETA_WINDOW_MS],
  )).rows as Array<{ sample_count: number; window_ms: number | null }>;

  return {
    counts,
    actionable: actionableRow.actionable,
    etaSampleCount: windowRow.sample_count,
    etaWindowMs: windowRow.window_ms ?? 0,
  };
}

export function etaFromFacts(facts: ProgressFacts, remaining: number): EtaEstimate | null {
  return estimateEta(facts.etaSampleCount, facts.etaWindowMs, remaining);
}

/**
 * Persists the given per-status counts and bumps progress_seq by exactly
 * one, inside the same UPDATE (D-116) -- never a client-supplied value.
 * Returns the new progress_seq as a number (pg returns bigint as a string
 * by default).
 */
export async function writeProgressSnapshot(
  client: Queryable,
  tenantId: string,
  executionId: string,
  counts: ProgressCounts,
): Promise<number> {
  const [row] = (await client.query(
    `UPDATE campaign_execution
     SET progress_seq = progress_seq + 1,
         pending_count = $3, queued_count = $4, submitted_count = $5, delivered_count = $6,
         bounced_count = $7, failed_count = $8, skipped_count = $9, cancelled_count = $10
     WHERE id = $1 AND tenant_id = $2
     RETURNING progress_seq`,
    [
      executionId, tenantId,
      counts.pending, counts.queued, counts.submitted, counts.delivered,
      counts.bounced, counts.failed, counts.skipped, counts.cancelled,
    ],
  )).rows as Array<{ progress_seq: string }>;
  return Number(row.progress_seq);
}

/**
 * Reads facts, writes the snapshot and builds+publishes the event in one
 * call -- the single place both the send-loop throttle (send.ts) and the
 * end-of-pass mandatory flush (run.ts) go through, so neither can bump
 * progress_seq without publishing, or publish a payload that disagrees
 * with what was just stored. Publishing happens strictly after the
 * transaction that wrote the snapshot commits (never inside it): a
 * published event that a rollback then erases would make the counters on
 * screen unfalsifiable, exactly the "socket payload as the only copy of
 * business state" failure AGENTS.md forbids. A publish failure is
 * swallowed -- realtime is a hint (ADR-010); PostgreSQL already has the
 * fact -- so an unreachable Redis degrades to the REST polling fallback
 * and never fails a send whose email has already left the building.
 */
export async function publishProgressSnapshot(
  pool: pg.Pool,
  tenantId: string,
  campaignId: string,
  executionId: string,
  publish: CampaignEventPublisher | null,
): Promise<void> {
  if (!publish) return;
  const event = await runInTenantTransaction(pool, tenantId, async (client) => {
    const [row] = ((await client.query(
      `SELECT ce.snapshot_id, cs.total_snapshot, c.status AS campaign_status
       FROM campaign_execution ce
       JOIN campaign_snapshot cs ON cs.id = ce.snapshot_id
       JOIN campaign c ON c.id = ce.campaign_id
       WHERE ce.id = $1 AND ce.tenant_id = $2`,
      [executionId, tenantId],
    )) as { rows: Array<{ snapshot_id: string; total_snapshot: number; campaign_status: string }> }).rows;
    if (!row) return null;

    const facts = await readProgressFacts(client, tenantId, row.snapshot_id, executionId);
    const progressSeq = await writeProgressSnapshot(client, tenantId, executionId, facts.counts);
    const terminal = facts.counts.submitted + facts.counts.delivered + facts.counts.bounced + facts.counts.failed;
    const remaining = Math.max(0, facts.actionable - terminal);
    const eta = etaFromFacts(facts, remaining);

    return buildProgressEvent({
      tenantId, campaignId, executionId, progressSeq,
      counts: facts.counts, actionable: facts.actionable, totalSnapshot: row.total_snapshot,
      status: row.campaign_status, eta,
    });
  });
  if (!event) return;
  try {
    await publish(event);
  } catch {
    // realtime is a hint (ADR-010); PostgreSQL already has the fact
  }
}
