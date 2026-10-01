import pg from 'pg';
import { runInTenantTransaction } from '../tenant-database.js';

export type AggregateOutcome =
  | { result: 'completed' | 'partial_failed' | 'failed' }
  | { result: 'not_done' }
  | { result: 'not_claimable' };

/**
 * BR-SEND-001/002's "aggregate" DAG node (SS3.3/SS3.4). Recomputes counts by
 * status rather than trusting any in-memory tally, and applies the terminal
 * sending->{completed,partial_failed,failed} transition only once every
 * actionable (eligibility='sendable') recipient is terminal -- callable
 * every scan pass; it is a safe no-op (not_done) until a campaign larger
 * than one batch has actually finished sending.
 */
export async function aggregateExecution(
  databaseUrl: string,
  tenantId: string,
  campaignId: string,
  executionId: string,
): Promise<AggregateOutcome> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    return await runInTenantTransaction(pool, tenantId, (client) => aggregateInTransaction(client, tenantId, campaignId, executionId));
  } finally {
    await pool.end();
  }
}

async function aggregateInTransaction(
  client: pg.PoolClient,
  tenantId: string,
  campaignId: string,
  executionId: string,
): Promise<AggregateOutcome> {
  const [campaign] = ((await client.query(
    `SELECT status FROM campaign WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId],
  )) as { rows: Array<{ status: string }> }).rows;
  if (!campaign || campaign.status !== 'sending') return { result: 'not_claimable' };

  const [counts] = ((await client.query(
    `SELECT
       count(*) FILTER (WHERE eligibility = 'sendable' AND status IN ('pending', 'queued'))::int AS pending_count,
       count(*) FILTER (WHERE eligibility = 'sendable' AND status = 'failed')::int AS failed_count,
       count(*) FILTER (WHERE eligibility = 'sendable')::int AS actionable_count
     FROM campaign_recipient
     WHERE tenant_id = $1 AND campaign_id = $2 AND execution_id = $3`,
    [tenantId, campaignId, executionId],
  )) as { rows: Array<{ pending_count: number; failed_count: number; actionable_count: number }> }).rows;

  if (counts.pending_count > 0) return { result: 'not_done' };

  const terminalStatus: 'completed' | 'partial_failed' | 'failed' =
    counts.actionable_count > 0 && counts.failed_count === counts.actionable_count
      ? 'failed'
      : counts.failed_count > 0
        ? 'partial_failed'
        : 'completed';

  const claimed = (await client.query(
    `UPDATE campaign SET status = $3, version = version + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'sending'
     RETURNING version`,
    [campaignId, tenantId, terminalStatus],
  )) as { rowCount: number; rows: Array<{ version: string }> };
  if (claimed.rowCount === 0) return { result: 'not_claimable' };

  await client.query(
    `UPDATE campaign_execution SET status = $3, finished_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'sending'`,
    [executionId, tenantId, terminalStatus],
  );
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
     VALUES ($1, NULL, $2, 'campaign', $3, $4, $5::jsonb)`,
    [tenantId, `campaign_send.${terminalStatus}`, campaignId, `campaign-send:${campaignId}`, JSON.stringify({ executionId, ...counts })],
  );
  await client.query(
    `INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload)
     VALUES ($1, 'campaign.execution_state_changed', 'campaign', $2, $3, $4::jsonb)
     ON CONFLICT (aggregate_type, aggregate_id, aggregate_version, event_type) DO NOTHING`,
    [tenantId, campaignId, claimed.rows[0].version, JSON.stringify({ status: terminalStatus, ...counts })],
  );

  return { result: terminalStatus };
}
