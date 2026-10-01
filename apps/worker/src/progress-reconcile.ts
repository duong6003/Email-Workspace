import pg from 'pg';
import { runInTenantTransaction } from './tenant-database.js';
import { readProgressFacts, writeProgressSnapshot } from './campaign-send/progress-snapshot.js';
import { buildProgressEvent, type CampaignEventPublisher, type ResyncEvent } from './campaign-send/progress-event.js';
import { decideWebhookOutcome, type MessageStatus } from './campaign-send/delivery-decision.js';
import { suppressRecipient } from './campaign-send/suppression.js';
import { progressReconcileDriftMetric } from './progress-metrics.js';
import { workerLogger } from './observability/logger.js';
import { getJobContext, updateJobContext } from './observability/job-context.js';
import { jobMetrics } from './observability/job-metrics.js';

export const CROSS_TENANT_SCAN_LIMIT = 100;

export type ReconcileResult = {
  executionId: string;
  tenantId: string;
  campaignId: string;
  drift: number;
  repairedRecipients: number;
};

type LedgerCandidate = {
  id: string;
  status: MessageStatus;
  delivery_state_at: Date | null;
  recipient_id: string;
  event_type: 'delivered' | 'bounced' | 'complaint' | 'deferred' | 'unknown';
  occurred_at: Date;
};

/**
 * BR-HIS-008/ADR-026's periodic scan orchestrator, same cross-tenant sweep
 * shape as scanQueuedCampaigns/scanDueCampaigns: an unlocked SELECT over the
 * narrow reconcilable_campaign_executions() boundary decides which
 * executions to visit, then a tenant transaction per execution does the
 * repair.
 */
export async function reconcileProgress(
  databaseUrl: string,
  publish: CampaignEventPublisher | null = null,
): Promise<ReconcileResult[]> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const due = await pool.query<{ id: string; tenant_id: string; campaign_id: string }>(
      `SELECT id, tenant_id, campaign_id FROM reconcilable_campaign_executions($1)`,
      [CROSS_TENANT_SCAN_LIMIT],
    );
    const results: ReconcileResult[] = [];
    for (const row of due.rows) {
      const result = await reconcileOneExecution(pool, row.tenant_id, row.campaign_id, row.id, publish);
      results.push(result);
    }
    return results;
  } finally {
    await pool.end();
  }
}

async function reconcileOneExecution(
  pool: pg.Pool,
  tenantId: string,
  campaignId: string,
  executionId: string,
  publish: CampaignEventPublisher | null,
): Promise<ReconcileResult> {
  const outcome = await runInTenantTransaction(pool, tenantId, async (client) => {
    // Layer 1: campaign_recipient rows whose status disagrees with their own
    // newest applied delivery_event. The candidate query is deliberately
    // broad -- decideWebhookOutcome (the SAME function the live webhook path
    // uses, A16) is what actually decides whether a repair is safe.
    const candidates = (await client.query(
      `SELECT cr.id, cr.status, cr.delivery_state_at, cr.recipient_id, de.event_type, de.occurred_at
       FROM campaign_recipient cr
       JOIN LATERAL (
         SELECT event_type, occurred_at FROM delivery_event
         WHERE tenant_id = cr.tenant_id AND campaign_recipient_id = cr.id AND outcome = 'applied'
         ORDER BY occurred_at DESC LIMIT 1
       ) de ON true
       WHERE cr.tenant_id = $1 AND cr.execution_id = $2
         AND cr.status <> (CASE de.event_type WHEN 'delivered' THEN 'delivered' WHEN 'bounced' THEN 'bounced' ELSE cr.status END)
       FOR UPDATE OF cr`,
      [tenantId, executionId],
    )) as { rows: LedgerCandidate[] };

    let repairedRecipients = 0;
    for (const candidate of candidates.rows) {
      const decision = decideWebhookOutcome(candidate.event_type, candidate.status, candidate.occurred_at, candidate.delivery_state_at);
      if (decision.outcome !== 'applied') continue;
      if (decision.nextStatus !== null) {
        await client.query(
          `UPDATE campaign_recipient SET status = $3, delivery_state_at = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
          [candidate.id, tenantId, decision.nextStatus, candidate.occurred_at],
        );
      }
      if (decision.suppress !== null) {
        await suppressRecipient(client, tenantId, candidate.recipient_id, decision.suppress, `progress-reconcile:${executionId}`);
      }
      repairedRecipients += 1;
    }

    // Layer 2: the stored summary vs the (possibly just-repaired) true facts.
    const [snapshotRow] = ((await client.query(
      `SELECT ce.snapshot_id, cs.total_snapshot, c.status AS campaign_status,
              ce.pending_count, ce.queued_count, ce.submitted_count, ce.delivered_count,
              ce.bounced_count, ce.failed_count, ce.skipped_count, ce.cancelled_count
       FROM campaign_execution ce
       JOIN campaign_snapshot cs ON cs.id = ce.snapshot_id
       JOIN campaign c ON c.id = ce.campaign_id
       WHERE ce.id = $1 AND ce.tenant_id = $2`,
      [executionId, tenantId],
    )) as {
      rows: Array<{
        snapshot_id: string; total_snapshot: number; campaign_status: string;
        pending_count: number; queued_count: number; submitted_count: number; delivered_count: number;
        bounced_count: number; failed_count: number; skipped_count: number; cancelled_count: number;
      }>;
    }).rows;

    // The execution named by this row was live when reconcilable_campaign_executions()
    // listed it, but campaign_execution/campaign_snapshot/campaign can legitimately
    // change between that unlocked scan and this transaction opening (a concurrent
    // cleanup routine, or -- in this host's shared-database test suite -- a
    // different test file racing the same tenant). Treat "no longer joins" the
    // same way an unmatched claim elsewhere in this codebase is treated: a safe
    // no-op, not a crash.
    if (!snapshotRow) {
      return { drift: 0, repairedRecipients: 0, event: null as ReturnType<typeof buildProgressEvent> | null, resync: null as { userIds: string[]; campaignId: string } | null };
    }

    const facts = await readProgressFacts(client, tenantId, snapshotRow.snapshot_id, executionId);
    const stored = {
      pending: snapshotRow.pending_count, queued: snapshotRow.queued_count,
      submitted: snapshotRow.submitted_count, delivered: snapshotRow.delivered_count,
      bounced: snapshotRow.bounced_count, failed: snapshotRow.failed_count,
      skipped: snapshotRow.skipped_count, cancelled: snapshotRow.cancelled_count,
    };
    const drift = (Object.keys(facts.counts) as Array<keyof typeof facts.counts>)
      .reduce((total, key) => total + Math.abs(facts.counts[key] - stored[key]), 0);

    if (drift === 0 && repairedRecipients === 0) {
      await client.query(`UPDATE campaign_execution SET reconciled_at = now() WHERE id = $1 AND tenant_id = $2`, [executionId, tenantId]);
      return { drift: 0, repairedRecipients: 0, event: null as ReturnType<typeof buildProgressEvent> | null, resync: null as { userIds: string[]; campaignId: string } | null };
    }

    const progressSeq = await writeProgressSnapshot(client, tenantId, executionId, facts.counts);
    await client.query(`UPDATE campaign_execution SET reconciled_at = now() WHERE id = $1 AND tenant_id = $2`, [executionId, tenantId]);
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
       VALUES ($1, NULL, 'progress.reconciled', 'campaign_execution', $2, $3, $4::jsonb)`,
      [tenantId, executionId, getJobContext()?.traceId ?? `progress-reconcile:${executionId}`, JSON.stringify({ before: stored, after: facts.counts, drift, repairedRecipients })],
    );

    const terminal = facts.counts.submitted + facts.counts.delivered + facts.counts.bounced + facts.counts.failed;
    const remaining = Math.max(0, facts.actionable - terminal);
    const event = buildProgressEvent({
      tenantId, campaignId, executionId, progressSeq,
      counts: facts.counts, actionable: facts.actionable, totalSnapshot: snapshotRow.total_snapshot,
      status: snapshotRow.campaign_status, eta: null,
    });

    const affectedUsers = (await client.query(
      `SELECT DISTINCT u.id::text AS id
       FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
       JOIN role_permission rp ON rp.role_id = ur.role_id
       JOIN permission p ON p.id = rp.permission_id AND p.key = 'campaign:read'
       WHERE u.tenant_id = $1 AND u.status = 'active'`,
      [tenantId],
    )) as { rows: Array<{ id: string }> };

    return { drift, repairedRecipients, event, resync: { userIds: affectedUsers.rows.map((r) => r.id), campaignId } };
  });

  const metric = progressReconcileDriftMetric({ tenantId, campaignId, executionId, drift: outcome.drift, repairedRecipients: outcome.repairedRecipients });
  updateJobContext({ tenantId, campaignId });
  workerLogger.info(metric, 'progress.reconcile');
  jobMetrics.progressReconcileDrift(outcome.drift);

  if (publish && outcome.event) {
    try {
      await publish(outcome.event);
    } catch {
      // realtime is a hint (ADR-010); PostgreSQL already has the fact
    }
    if (outcome.resync) {
      for (const userId of outcome.resync.userIds) {
        const resyncEvent: ResyncEvent = {
          event_id: crypto.randomUUID(),
          event_type: 'rt.resync_required',
          occurred_at: new Date().toISOString(),
          tenant_id: tenantId,
          aggregate_id: campaignId,
          version: 0,
          data: { campaign_id: campaignId },
        };
        try {
          await publish({ ...resyncEvent, aggregate_id: userId });
        } catch {
          // realtime is a hint (ADR-010); PostgreSQL already has the fact
        }
      }
    }
  }

  return { executionId, tenantId, campaignId, drift: outcome.drift, repairedRecipients: outcome.repairedRecipients };
}
