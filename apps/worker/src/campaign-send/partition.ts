import pg from 'pg';
import { runInTenantTransaction } from '../tenant-database.js';

export type PartitionOutcome =
  | { result: 'partitioned'; claimedCount: number }
  | { result: 'completed_empty' }
  | { result: 'drained' }
  | { result: 'not_claimable' };

/**
 * BR-SEND-002's "partition" DAG node (SS3.4, A6/A16). Claims a batch of
 * still-owed recipients into 'queued' for one execution. Callable more than
 * once per execution -- a campaign with more sendable recipients than
 * `batchSize` needs several calls, the first from 'validating' (which also
 * carries the campaign into 'sending' via the campaign_execution.status
 * mirror), later ones from 'sending' once already there. The claim itself
 * (`FOR UPDATE SKIP LOCKED` + `WHERE status = 'pending'`) is what makes two
 * genuinely concurrent callers partition disjoint rows rather than double-
 * claim (A16); the campaign-level precondition read is deliberately
 * unlocked so it never serializes that claim.
 */
export async function partitionBatch(
  databaseUrl: string,
  tenantId: string,
  campaignId: string,
  executionId: string,
  batchSize: number,
): Promise<PartitionOutcome> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    return await runInTenantTransaction(pool, tenantId, (client) =>
      partitionInTransaction(client, tenantId, campaignId, executionId, batchSize));
  } finally {
    await pool.end();
  }
}

async function partitionInTransaction(
  client: pg.PoolClient,
  tenantId: string,
  campaignId: string,
  executionId: string,
  batchSize: number,
): Promise<PartitionOutcome> {
  const [campaign] = ((await client.query(
    `SELECT status FROM campaign WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId],
  )) as { rows: Array<{ status: string }> }).rows;
  if (!campaign || (campaign.status !== 'validating' && campaign.status !== 'sending')) {
    return { result: 'not_claimable' };
  }

  const claimed = (await client.query(
    `WITH rows_to_claim AS (
       SELECT id
       FROM campaign_recipient
       WHERE tenant_id = $1 AND campaign_id = $2 AND eligibility = 'sendable' AND status = 'pending'
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT $3
     )
     UPDATE campaign_recipient row
     SET status = 'queued', execution_id = $4, batch_no = 1
     FROM rows_to_claim
     WHERE row.id = rows_to_claim.id
     RETURNING row.id`,
    [tenantId, campaignId, batchSize, executionId],
  )) as { rowCount: number };
  const claimedCount = claimed.rowCount;

  if (campaign.status === 'validating') {
    if (claimedCount > 0) {
      await client.query(
        `UPDATE campaign SET status = 'sending', version = version + 1, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND status = 'validating'`,
        [campaignId, tenantId],
      );
      await client.query(
        `UPDATE campaign_execution SET status = 'sending' WHERE id = $1 AND tenant_id = $2 AND status = 'validating'`,
        [executionId, tenantId],
      );
      return { result: 'partitioned', claimedCount };
    }
    await client.query(
      `UPDATE campaign SET status = 'completed', version = version + 1, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'validating'`,
      [campaignId, tenantId],
    );
    await client.query(
      `UPDATE campaign_execution SET status = 'completed', finished_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'validating'`,
      [executionId, tenantId],
    );
    return { result: 'completed_empty' };
  }

  return claimedCount > 0 ? { result: 'partitioned', claimedCount } : { result: 'drained' };
}
