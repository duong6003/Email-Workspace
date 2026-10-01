import pg from 'pg';
import { runInTenantTransaction } from '../tenant-database.js';
import { runValidation } from './validate.js';
import { partitionBatch } from './partition.js';
import { sendClaimedBatch } from './send.js';
import { aggregateExecution } from './aggregate.js';
import { publishProgressSnapshot } from './progress-snapshot.js';
import type { CampaignEventPublisher } from './progress-event.js';
import { trace } from '@opentelemetry/api';
import { updateJobContext } from '../observability/job-context.js';
import { jobMetrics } from '../observability/job-metrics.js';
import { workerLogger } from '../observability/logger.js';

const CROSS_TENANT_SCAN_LIMIT = 100;

export type ScanOutcome = 'sent' | 'completed_empty' | 'completed' | 'partial_failed' | 'failed';
export type ScanResult = { campaignId: string; tenantId: string; outcome: ScanOutcome };

/**
 * BR-SEND-001's periodic scan orchestrator (SS3.4/DEC-102) -- the same
 * cross-tenant sweep shape as M5-S2's campaign-dispatcher.ts: an unlocked
 * SELECT over the narrow `queued_campaign_executions()` boundary decides
 * *which* campaigns to visit, then re-enters a tenant transaction per
 * campaign for the actual work. Runs validate, partition, send, then
 * aggregate in one pass so a batch claimed this tick also goes out and gets
 * checked for completion this tick.
 */
export async function scanQueuedCampaigns(
  databaseUrl: string,
  redisUrl: string,
  batchSize: number,
  publishProgress: CampaignEventPublisher | null = null,
): Promise<ScanResult[]> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const due = await pool.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM queued_campaign_executions($1)`,
      [CROSS_TENANT_SCAN_LIMIT],
    );
    const results: ScanResult[] = [];
    for (const row of due.rows) {
      const outcome = await runOneCampaign(databaseUrl, redisUrl, row.tenant_id, row.id, batchSize, publishProgress);
      if (outcome) results.push({ campaignId: row.id, tenantId: row.tenant_id, outcome });
    }
    return results;
  } finally {
    await pool.end();
  }
}

async function runOneCampaign(
  databaseUrl: string,
  redisUrl: string,
  tenantId: string,
  campaignId: string,
  batchSize: number,
  publishProgress: CampaignEventPublisher | null = null,
): Promise<ScanOutcome | null> {
  updateJobContext({ tenantId, campaignId });
  workerLogger.info({ event: 'campaign.send.started' }, 'campaign.send.started');
  const validation = await runValidation(databaseUrl, tenantId, campaignId);
  if (validation.result === 'failed') return 'failed';

  let executionId: string;
  if (validation.result === 'validated') {
    executionId = validation.executionId;
  } else {
    // Already past validating (e.g. mid-'sending' from an earlier scan pass
    // that only partially drained a large batch) -- partition again rather
    // than skip, so a campaign larger than one batchSize still finishes.
    const existing = await currentExecutionId(databaseUrl, tenantId, campaignId);
    if (!existing) return null;
    executionId = existing;
  }

  const effectiveBatchSize = await currentExecutionBatchSize(databaseUrl, tenantId, executionId, batchSize);
  const partitioned = await partitionBatch(databaseUrl, tenantId, campaignId, executionId, effectiveBatchSize);
  if (partitioned.result === 'not_claimable') return null;
  if (partitioned.result === 'completed_empty') return 'completed_empty';
  // 'partitioned' (fresh rows just claimed) and 'drained' (nothing new to
  // claim) both still need send+aggregate: a 'drained' pass is exactly how a
  // due retry or a still-finishing large batch gets picked back up, and
  // returning early here would leave such a campaign stuck in 'sending'
  // forever once its one-time partition pass ran dry.

  const sent = await trace.getTracer('eow-worker').startActiveSpan('provider.send_batch', async (span) => {
    span.setAttributes({ 'eow.tenant_id': tenantId, 'eow.campaign_id': campaignId, 'eow.execution_id': executionId });
    try { return await sendClaimedBatch(databaseUrl, redisUrl, tenantId, campaignId, executionId, effectiveBatchSize, undefined, publishProgress); }
    finally { span.end(); }
  });
  jobMetrics.sendAttempt('submitted', sent.submitted);
  jobMetrics.sendAttempt('retrying', sent.retrying);
  jobMetrics.sendAttempt('failed', sent.failed);
  jobMetrics.sendRetry(sent.retrying);
  jobMetrics.providerReject(sent.failed);
  workerLogger.info({ submitted: sent.submitted, retrying: sent.retrying, failed: sent.failed }, 'campaign.send.batch_completed');

  const aggregated = await aggregateExecution(databaseUrl, tenantId, campaignId, executionId);

  // The mandatory flush (A7, DEC-124's sibling guarantee): unconditional,
  // regardless of what the throttle inside sendClaimedBatch did this pass.
  // Without it, the batch that takes a campaign from 99% to 100% -- or any
  // batch too small to ever cross the throttle's own time/count bounds --
  // can complete without ever publishing, leaving the UI stuck short of
  // its true state. A publish failure here is swallowed the same way
  // publishProgressSnapshot always swallows one: realtime is a hint,
  // PostgreSQL already has the fact.
  if (publishProgress) {
    const flushPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await publishProgressSnapshot(flushPool, tenantId, campaignId, executionId, publishProgress);
    } finally {
      await flushPool.end();
    }
  }

  if (aggregated.result === 'completed' || aggregated.result === 'partial_failed' || aggregated.result === 'failed') {
    return aggregated.result;
  }
  return sent.failed > 0 && sent.submitted === 0 && sent.retrying === 0 ? 'failed' : 'sent';
}

async function currentExecutionBatchSize(databaseUrl: string, tenantId: string, executionId: string, fallback: number): Promise<number> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return await runInTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ batch_size: number }>('SELECT batch_size FROM campaign_execution WHERE id = $1 AND tenant_id = $2', [executionId, tenantId]);
      return result.rows[0]?.batch_size ?? fallback;
    });
  } finally {
    await pool.end();
  }
}

async function currentExecutionId(databaseUrl: string, tenantId: string, campaignId: string): Promise<string> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return await runInTenantTransaction(pool, tenantId, async (client) => {
      const [row] = ((await client.query(
        `SELECT ce.id FROM campaign_execution ce
         JOIN campaign_snapshot cs ON cs.id = ce.snapshot_id AND cs.superseded_at IS NULL
         WHERE ce.tenant_id = $1 AND ce.campaign_id = $2`,
        [tenantId, campaignId],
      )) as { rows: Array<{ id: string }> }).rows;
      return row?.id ?? '';
    });
  } finally {
    await pool.end();
  }
}
