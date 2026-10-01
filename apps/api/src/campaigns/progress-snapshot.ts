import type { DataSource, EntityManager } from 'typeorm';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { ETA_WINDOW_MS, estimateEta, type EtaEstimate, type ProgressCounts } from './progress-math.js';
import { buildProgressEvent, type CampaignEventPublisher } from './progress-event.js';

/**
 * Reads and writes the campaign_execution progress summary (migration 028).
 * Worker-native duplicate at
 * apps/worker/src/campaign-send/progress-snapshot.ts (DEC-107/DEC-123
 * transliteration precedent -- neither app can import the other's source).
 * ARCH-PROGRESS-PARITY keeps the two in step.
 */
export type ProgressFacts = {
  counts: ProgressCounts;
  actionable: number;
  etaSampleCount: number;
  etaWindowMs: number;
};

/**
 * The canonical per-status partition (sums to total_snapshot, BR-SEND-002),
 * the actionable denominator (eligibility = 'sendable'), and the ETA sample
 * window -- outcome = 'submitted' attempts only (BR-SEND-005: failed/skipped
 * never inflate throughput).
 */
export async function readProgressFacts(
  manager: EntityManager,
  tenantId: string,
  snapshotId: string,
  executionId: string,
): Promise<ProgressFacts> {
  const counts: ProgressCounts = { pending: 0, queued: 0, submitted: 0, delivered: 0, bounced: 0, failed: 0, skipped: 0, cancelled: 0 };
  const countRows = (await manager.query(
    `SELECT status, count(*)::int AS count FROM campaign_recipient WHERE tenant_id = $1 AND snapshot_id = $2 GROUP BY status`,
    [tenantId, snapshotId],
  )) as Array<{ status: keyof ProgressCounts; count: number }>;
  for (const row of countRows) counts[row.status] = row.count;

  const [actionableRow] = (await manager.query(
    `SELECT count(*)::int AS actionable FROM campaign_recipient WHERE tenant_id = $1 AND snapshot_id = $2 AND eligibility = 'sendable'`,
    [tenantId, snapshotId],
  )) as Array<{ actionable: number }>;

  const [windowRow] = (await manager.query(
    `SELECT count(*)::int AS sample_count,
            EXTRACT(EPOCH FROM (max(attempted_at) - min(attempted_at))) * 1000 AS window_ms
     FROM message_attempt
     WHERE tenant_id = $1 AND execution_id = $2 AND outcome = 'submitted'
       AND attempted_at > now() - ($3::double precision * interval '1 millisecond')`,
    [tenantId, executionId, ETA_WINDOW_MS],
  )) as Array<{ sample_count: number; window_ms: number | null }>;

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
 *
 * D-125 (M6-S3 CP7): TypeORM's EntityManager query method returns `[rows,
 * affectedCount]` for UPDATE/DELETE statements -- unlike SELECT/INSERT,
 * which return bare rows -- so the outer pair must be unwrapped before
 * destructuring a row. The one-element `[row] = result` pattern that works
 * for every SELECT/INSERT call elsewhere in this codebase silently
 * produced `row = <the rows array itself>` here, making
 * `row.progress_seq` (and therefore this function's entire return value,
 * and the AsyncAPI envelope's `version` field built from it) `NaN` on
 * every call -- serialised as `null` on the wire, defeating D-116/DEC-122's
 * whole monotonic-dedupe-key mechanism. No test in either app asserted on
 * this specific return value before now; every existing test re-read
 * `progress_seq` from a fresh `SELECT` instead, which is why the bug was
 * invisible despite the underlying `UPDATE` always writing the correct
 * value to the database.
 */
export async function writeProgressSnapshot(
  manager: EntityManager,
  tenantId: string,
  executionId: string,
  counts: ProgressCounts,
): Promise<number> {
  const [[row]] = (await manager.query(
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
  )) as [Array<{ progress_seq: string }>, number];
  return Number(row.progress_seq);
}

/**
 * Reads facts, writes the snapshot and builds+publishes the event in one
 * call -- worker-native duplicate of
 * apps/worker/src/campaign-send/progress-snapshot.ts's own
 * publishProgressSnapshot(). Opens its OWN fresh transaction (never the
 * caller's): the caller's own apply transaction must already have
 * committed, or a published event a rollback then erases would make the
 * counters on screen unfalsifiable (AGENTS.md: realtime is a hint, never
 * the only copy of business state). A publish failure is swallowed --
 * realtime is a hint (ADR-010); PostgreSQL already has the fact.
 */
export async function publishProgressSnapshot(
  dataSource: DataSource,
  tenantId: string,
  campaignId: string,
  executionId: string,
  publish: CampaignEventPublisher | null,
): Promise<void> {
  if (!publish) return;
  const event = await runInTenantContext(dataSource, tenantId, async (manager) => {
    const [row] = (await manager.query(
      `SELECT ce.snapshot_id, cs.total_snapshot, c.status AS campaign_status
       FROM campaign_execution ce
       JOIN campaign_snapshot cs ON cs.id = ce.snapshot_id
       JOIN campaign c ON c.id = ce.campaign_id
       WHERE ce.id = $1 AND ce.tenant_id = $2`,
      [executionId, tenantId],
    )) as Array<{ snapshot_id: string; total_snapshot: number; campaign_status: string }>;
    if (!row) return null;

    const facts = await readProgressFacts(manager, tenantId, row.snapshot_id, executionId);
    const progressSeq = await writeProgressSnapshot(manager, tenantId, executionId, facts.counts);
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
