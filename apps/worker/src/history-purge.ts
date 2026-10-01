import pg from 'pg';
import { runInTenantTransaction } from './tenant-database.js';
import { retentionCutoff } from './retention-window.js';

/** Tenants visited per tick. Bounded like every other cross-tenant scan on this worker. */
const TENANT_SCAN_LIMIT = 25;
/** Rows deleted per table per tenant per tick: a multi-year backlog drains across ticks
 *  instead of holding locks in one statement. */
const PURGE_BATCH_ROWS = 5000;

export type HistoryPurgeResult = {
  tenantId: string;
  retentionDays: number;
  source: 'policy' | 'default';
  cutoff: Date;
  messageAttemptsDeleted: number;
  deliveryEventsDeleted: number;
  executionsAffected: number;
};

/**
 * BR-HIS-006's purge, same cross-tenant sweep shape as reconcileProgress and
 * export-scan: an unlocked SELECT over the narrow
 * purgeable_retention_tenants() boundary decides which tenants to visit,
 * then one tenant transaction per tenant deletes and audits.
 *
 * Only message_attempt/delivery_event are touched (DEC-140). campaign,
 * campaign_execution, campaign_snapshot and campaign_recipient are never
 * deleted, which is what keeps the stored 028 summary -- the only thing the
 * history report reads (D-130) -- exactly as it was.
 */
export async function purgeHistoryEvents(
  databaseUrl: string,
  defaultRetentionDays: number,
  now: Date = new Date(),
): Promise<HistoryPurgeResult[]> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const due = await pool.query<{ tenant_id: string; retention_days: number; from_policy: boolean }>(
      `SELECT tenant_id, retention_days, from_policy FROM purgeable_retention_tenants($1, $2)`,
      [defaultRetentionDays, TENANT_SCAN_LIMIT],
    );

    const results: HistoryPurgeResult[] = [];
    for (const row of due.rows) {
      const cutoff = retentionCutoff(Number(row.retention_days), now);
      const source: 'policy' | 'default' = row.from_policy ? 'policy' : 'default';
      const purged = await runInTenantTransaction(pool, row.tenant_id, async (client) => {
        const deleted = await client.query<{ message_attempts_deleted: number; delivery_events_deleted: number; executions_affected: number }>(
          `SELECT * FROM purge_message_events($1, $2, $3)`,
          [row.tenant_id, cutoff.toISOString(), PURGE_BATCH_ROWS],
        );
        const counts = deleted.rows[0];
        const total = Number(counts.message_attempts_deleted) + Number(counts.delivery_events_deleted);
        if (total === 0) return null;

        const metadata = {
          retentionDays: Number(row.retention_days),
          source,
          cutoff: cutoff.toISOString(),
          messageAttemptsDeleted: Number(counts.message_attempts_deleted),
          deliveryEventsDeleted: Number(counts.delivery_events_deleted),
          executionsAffected: Number(counts.executions_affected),
        };
        await client.query(
          `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
           VALUES ($1, NULL, 'history.purged', 'tenant', $1, $2, $3::jsonb)`,
          [row.tenant_id, `history-purge:${row.tenant_id}:${cutoff.toISOString()}`, JSON.stringify(metadata)],
        );
        return metadata;
      });

      if (purged) {
        results.push({
          tenantId: row.tenant_id,
          retentionDays: purged.retentionDays,
          source,
          cutoff,
          messageAttemptsDeleted: purged.messageAttemptsDeleted,
          deliveryEventsDeleted: purged.deliveryEventsDeleted,
          executionsAffected: purged.executionsAffected,
        });
      }
    }
    return results;
  } finally {
    await pool.end();
  }
}
