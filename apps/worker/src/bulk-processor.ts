import pg from 'pg';
import { buildJobEvent } from './job-events.js';
import type { JobEventPublisher } from './import-processor.js';
import { runInTenantTransaction } from './tenant-database.js';
import { writeJobNotification, type NotificationEventPublisher } from './notification-writer.js';
import { jobMetrics } from './observability/job-metrics.js';

export const BULK_QUEUE = 'bulk-processing';
export const BULK_JOB_NAME = 'process-bulk-job';
const CLAIM_TTL_MS = 60_000;
const CLAIM_BATCH_SIZE = 100;

type JobStatus = 'queued' | 'running' | 'completed' | 'partial_success' | 'failed';
type Counters = { total: number; succeeded: number; failed: number; skipped: number };
type ClaimedRow = { id: string; recipient_id: string };
type BulkAction = 'add_tag' | 'remove_tag' | 'add_list' | 'remove_list' | 'set_custom_data' | 'export' | 'delete';

export function bulkQueueJobId(bulkJobId: string): string {
  return `bulk-${bulkJobId}`;
}

export function classifyBulkJobStatus(counters: Counters): JobStatus {
  if (counters.total === 0 || (counters.succeeded === 0 && counters.failed === 0 && counters.skipped > 0)) return 'completed';
  if (counters.failed > 0 && (counters.succeeded > 0 || counters.skipped > 0)) return 'partial_success';
  if (counters.failed > 0) return 'failed';
  return 'completed';
}

/**
 * BR-CF-005/BR-REC-009: this processor consumes only the rows written from
 * the frozen selection snapshot. It never re-evaluates the caller's query.
 */
export async function processBulkJob(databaseUrl: string, tenantId: string, jobId: string, publish?: JobEventPublisher, publishNotification?: NotificationEventPublisher): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await runInTenantTransaction(pool, tenantId, async (client) => {
    const verified = await client.query('SELECT 1 FROM bulk_job WHERE id = $1 AND tenant_id = $2', [jobId, tenantId]);
    if (verified.rowCount !== 1) throw new Error(`Bulk job ${jobId} does not belong to tenant ${tenantId}.`);
    await reclaimStaleRows(client, jobId);
    await client.query(
      `UPDATE bulk_job SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
       WHERE id = $1 AND status = 'queued'`,
      [jobId],
    );
    });

    for (;;) {
      const rows = await claimPendingRows(pool, tenantId, jobId);
      if (rows.length === 0) break;
      for (const row of rows) await processClaimedRow(pool, tenantId, jobId, row);
      await publishBulkProgress(pool, tenantId, jobId, publish);
    }
    await finalizeBulkJob(pool, tenantId, jobId, publish);
    await writeJobNotification(pool, { tenantId, sourceEventId: `bulk_update.completed:${jobId}`, type: 'bulk_update_completed', severity: 'success', title: 'Cập nhật hàng loạt đã hoàn tất', body: `Đã xử lý xong tác vụ ${jobId}.`, category: 'bulk', messageKey: 'bulk_update.completed', params: { jobId }, deepLinkRoute: '/recipients', entityType: 'bulk_job', entityId: jobId }, publishNotification);
  } finally {
    await pool.end();
  }
}

async function reclaimStaleRows(pool: Pick<pg.PoolClient, 'query'>, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE bulk_job_row
     SET status = 'pending', claimed_at = NULL
     WHERE job_id = $1 AND status = 'processing' AND claimed_at < now() - ($2::bigint * interval '1 millisecond')`,
    [jobId, CLAIM_TTL_MS],
  );
}

async function claimPendingRows(pool: pg.Pool, tenantId: string, jobId: string): Promise<ClaimedRow[]> {
  return runInTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<ClaimedRow>(
      `WITH rows_to_claim AS (
         SELECT id
         FROM bulk_job_row
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE bulk_job_row row
       SET status = 'processing', claimed_at = now()
       FROM rows_to_claim
       WHERE row.id = rows_to_claim.id
       RETURNING row.id::text, row.recipient_id`,
      [jobId, CLAIM_BATCH_SIZE],
    );
    return result.rows;
  });
}

async function processClaimedRow(pool: pg.Pool, tenantId: string, jobId: string, row: ClaimedRow): Promise<void> {
  try {
    await runInTenantTransaction(pool, tenantId, async (client) => {
    const jobResult = await client.query<{ id: string; tenant_id: string; created_by: string | null; action: BulkAction; action_payload: Record<string, unknown> }>(
      `SELECT id, tenant_id, created_by, action, action_payload FROM bulk_job WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [jobId, tenantId],
    );
    const job = jobResult.rows[0];
    if (!job) throw new Error(`Bulk job ${jobId} was not found.`);

    const recipient = await client.query<{ id: string; custom_data: Record<string, unknown> }>(
      `SELECT id, custom_data FROM recipient WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [row.recipient_id, job.tenant_id],
    );
    if (recipient.rows.length === 0) {
      await markRow(client, row.id, 'skipped', 'RECIPIENT_UNAVAILABLE');
      return;
    }

    await applyBulkAction(client, job, row.recipient_id, recipient.rows[0].custom_data ?? {});
    await markRow(client, row.id, 'succeeded', null);
    });
  } catch {
    await runInTenantTransaction(pool, tenantId, (client) => client.query(
      `UPDATE bulk_job_row SET status = 'failed', error = 'ROW_PROCESSING_FAILED', processed_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [row.id],
    ).then(() => undefined));
  }
}

async function applyBulkAction(
  client: pg.PoolClient,
  job: { id: string; tenant_id: string; created_by: string | null; action: BulkAction; action_payload: Record<string, unknown> },
  recipientId: string,
  currentCustomData: Record<string, unknown>,
): Promise<void> {
  // An export succeeds per resolved row; its compact durable result is the
  // job's successful recipient checkpoints, exposed by the API as CSV.
  if (job.action === 'export') return;

  // BR-GEN-006/BR-REC-009: never hard-delete recipient history. The tenant
  // predicate is deliberately repeated here, at the authoritative mutation.
  if (job.action === 'delete') {
    await client.query(
      `UPDATE recipient
       SET deleted_at = now(), version = version + 1, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [recipientId, job.tenant_id],
    );
    return;
  }

  if (job.action === 'set_custom_data') {
    const key = typeof job.action_payload.key === 'string' ? job.action_payload.key : null;
    if (!key || !Object.hasOwn(job.action_payload, 'value')) throw new Error('Invalid custom-data action.');
    const field = await client.query<{ sensitive: boolean }>(
      `SELECT sensitive FROM custom_field_definition WHERE tenant_id = $1 AND field_key = $2`,
      [job.tenant_id, key],
    );
    if (!field.rows[0]) throw new Error('Custom field no longer exists.');
    const before = currentCustomData[key];
    const after = job.action_payload.value;
    await client.query(
      `UPDATE recipient
       SET custom_data = jsonb_set(COALESCE(custom_data, '{}'::jsonb), ARRAY[$1], $2::jsonb, true),
           version = version + 1, updated_at = now()
       WHERE id = $3 AND tenant_id = $4`,
      [key, JSON.stringify(job.action_payload.value), recipientId, job.tenant_id],
    );
    if (job.created_by && JSON.stringify(before) !== JSON.stringify(after)) {
      const sensitive = field.rows[0].sensitive;
      const metadata: Record<string, unknown> = {
        fieldKey: key,
        sourceJob: job.id,
        after: sensitive ? '***' : after,
      };
      if (before !== undefined) metadata.before = sensitive ? '***' : before;
      await client.query(
        `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
         VALUES ($1, $2, 'recipient.custom_data.updated', 'recipient', $3, $4, $5::jsonb)`,
        [job.tenant_id, job.created_by, recipientId, `job:${job.id}`, JSON.stringify(metadata)],
      );
    }
    return;
  }

  const targetId = job.action === 'add_tag' || job.action === 'remove_tag' ? job.action_payload.tagId : job.action_payload.listId;
  if (typeof targetId !== 'string') throw new Error('Invalid relation action.');

  if (job.action === 'add_tag') {
    await client.query(
      `INSERT INTO recipient_tag (tenant_id, tag_id, recipient_id)
       SELECT $1, id, $2 FROM tag WHERE id = $3 AND tenant_id = $1 AND deleted_at IS NULL
       ON CONFLICT (tag_id, recipient_id) DO NOTHING`,
      [job.tenant_id, recipientId, targetId],
    );
  } else if (job.action === 'remove_tag') {
    await client.query(
      `DELETE FROM recipient_tag WHERE tenant_id = $1 AND tag_id = $2 AND recipient_id = $3`,
      [job.tenant_id, targetId, recipientId],
    );
  } else if (job.action === 'add_list') {
    await client.query(
      `INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id)
       SELECT $1, id, $2 FROM recipient_list WHERE id = $3 AND tenant_id = $1 AND deleted_at IS NULL
       ON CONFLICT (list_id, recipient_id) DO NOTHING`,
      [job.tenant_id, recipientId, targetId],
    );
  } else {
    await client.query(
      `DELETE FROM recipient_list_member WHERE tenant_id = $1 AND list_id = $2 AND recipient_id = $3`,
      [job.tenant_id, targetId, recipientId],
    );
  }
}

async function markRow(
  client: pg.PoolClient,
  id: string,
  status: 'succeeded' | 'skipped',
  error: string | null,
): Promise<void> {
  await client.query(
    `UPDATE bulk_job_row SET status = $2, error = $3, processed_at = now() WHERE id = $1 AND status = 'processing'`,
    [id, status, error],
  );
}

async function bulkCounters(client: pg.PoolClient, tenantId: string, jobId: string): Promise<{ tenantId: string; total: number; succeeded: number; failed: number; skipped: number; processed: number }> {
  const job = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM bulk_job WHERE id = $1 AND tenant_id = $2', [jobId, tenantId]);
  const result = await client.query<{ total: string; succeeded: string; failed: string; skipped: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
            count(*) FILTER (WHERE status = 'failed')::text AS failed,
            count(*) FILTER (WHERE status = 'skipped')::text AS skipped
     FROM bulk_job_row WHERE job_id = $1`,
    [jobId],
  );
  const counters = result.rows[0];
  if (!counters || !job.rows[0]) throw new Error(`Bulk job ${jobId} was not found.`);
  const total = Number(counters.total);
  const succeeded = Number(counters.succeeded);
  const failed = Number(counters.failed);
  const skipped = Number(counters.skipped);
  return { tenantId: job.rows[0].tenant_id, total, succeeded, failed, skipped, processed: succeeded + failed + skipped };
}

async function publishBulkProgress(pool: pg.Pool, tenantId: string, jobId: string, publish?: JobEventPublisher): Promise<void> {
  if (!publish) return;
  const event = await runInTenantTransaction(pool, tenantId, async (client) => {
  const claimed = await client.query(
    `UPDATE bulk_job SET last_progress_emitted_at = now(), updated_at = now()
     WHERE id = $1 AND (last_progress_emitted_at IS NULL OR last_progress_emitted_at <= now() - interval '1 second')
     RETURNING id`,
    [jobId],
  );
  if (claimed.rowCount === 0) return null;
  const counters = await bulkCounters(client, tenantId, jobId);
  jobMetrics.bulkRows('succeeded', counters.succeeded);
  jobMetrics.bulkRows('failed', counters.failed);
  jobMetrics.bulkRows('skipped', counters.skipped);
  return buildJobEvent({ tenantId: counters.tenantId, jobId, eventType: 'bulk_update.progress', version: counters.processed, data: { resolvedCount: counters.total, processedRows: counters.processed, succeededRows: counters.succeeded, failedRows: counters.failed, skippedRows: counters.skipped } });
  });
  if (event) await publish(event);
}

async function finalizeBulkJob(pool: pg.Pool, tenantId: string, jobId: string, publish?: JobEventPublisher): Promise<void> {
  const event = await runInTenantTransaction(pool, tenantId, async (client) => {
  const counters = await bulkCounters(client, tenantId, jobId);
  await client.query(
    `UPDATE bulk_job
     SET status = $2, processed_rows = $3, succeeded_rows = $4, failed_rows = $5, skipped_rows = $6,
         completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [jobId, classifyBulkJobStatus(counters), counters.processed, counters.succeeded, counters.failed, counters.skipped],
  );
  return buildJobEvent({ tenantId: counters.tenantId, jobId, eventType: 'bulk_update.completed', version: counters.processed, data: { status: classifyBulkJobStatus(counters), resolvedCount: counters.total, processedRows: counters.processed, succeededRows: counters.succeeded, failedRows: counters.failed, skippedRows: counters.skipped } });
  });
  if (publish) await publish(event);
}
