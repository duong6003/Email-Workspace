import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildJobEvent } from './job-events.js';
import { runInTenantTransaction } from './tenant-database.js';
import { writeJobNotification, type NotificationEventPublisher } from './notification-writer.js';
import { jobMetrics } from './observability/job-metrics.js';

export const IMPORT_QUEUE = 'import-processing';
export const IMPORT_JOB_NAME = 'process-import-job';
const CLAIM_TTL_MS = 60_000;
const CLAIM_BATCH_SIZE = 100;

type ImportRowStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'skipped';
type JobStatus = 'queued' | 'running' | 'completed' | 'partial_success' | 'failed';

type JobCounters = { total: number; succeeded: number; failed: number; skipped: number };

export function classifyJobStatus(counters: JobCounters): JobStatus {
  if (counters.total === 0 || (counters.succeeded === 0 && counters.failed === 0 && counters.skipped > 0)) return 'completed';
  if (counters.failed > 0 && (counters.succeeded > 0 || counters.skipped > 0)) return 'partial_success';
  if (counters.failed > 0) return 'failed';
  return 'completed';
}

/** BR-IMP-005: import never bypasses the explicit re-consent flow. */
export function validateClaimedImportRow(input: { existingStatus: string | null; importedStatus: string | null }): void {
  if ((input.existingStatus === 'unsubscribed' || input.existingStatus === 'bounced') && input.importedStatus === 'active') {
    throw new Error('CONSENT_REQUIRED');
  }
}

/** Maps only explicit `custom_<field_key>` entries, so arbitrary spreadsheet columns never become custom data. */
export function customDataFromImportRow(mapping: Record<string, string>, rawData: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(mapping)
      .filter(([target]) => target.startsWith('custom_'))
      .flatMap(([target, source]) => {
        const value = rawData[source];
        return value === undefined || value === '' ? [] : [[target.slice('custom_'.length), value]];
      }),
  );
}

function mappedSegmentName(mapping: Record<string, string>, rawData: Record<string, unknown>, target: 'list' | 'tag'): string | null {
  const source = mapping[target];
  const value = source ? rawData[source] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mappedText(mapping: Record<string, string>, rawData: Record<string, unknown>, target: 'firstName' | 'lastName'): string | null {
  const source = mapping[target];
  const value = source ? rawData[source] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function addMappedSegmentMemberships(client: pg.PoolClient, tenantId: string, recipientId: string, mapping: Record<string, string>, rawData: Record<string, unknown>): Promise<void> {
  const listName = mappedSegmentName(mapping, rawData, 'list');
  if (listName) {
    const list = await client.query<{ id: string }>(
      `SELECT id FROM recipient_list WHERE tenant_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND deleted_at IS NULL`,
      [tenantId, listName],
    );
    if (!list.rows[0]) throw new Error('UNKNOWN_LIST');
    await client.query(
      `INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, source)
       VALUES ($1, $2, $3, 'import') ON CONFLICT (list_id, recipient_id) DO NOTHING`,
      [tenantId, list.rows[0].id, recipientId],
    );
  }

  const tagName = mappedSegmentName(mapping, rawData, 'tag');
  if (tagName) {
    const tag = await client.query<{ id: string }>(
      `SELECT id FROM tag WHERE tenant_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND deleted_at IS NULL`,
      [tenantId, tagName],
    );
    if (!tag.rows[0]) throw new Error('UNKNOWN_TAG');
    await client.query(
      `INSERT INTO recipient_tag (tenant_id, tag_id, recipient_id)
       VALUES ($1, $2, $3) ON CONFLICT (tag_id, recipient_id) DO NOTHING`,
      [tenantId, tag.rows[0].id, recipientId],
    );
  }
}

type ClaimedRow = { id: string; row_number: number; raw_data: Record<string, unknown> };

export type JobEventPublisher = (event: Record<string, unknown>) => Promise<void>;

export async function processImportJob(databaseUrl: string, tenantId: string, jobId: string, publish?: JobEventPublisher, publishNotification?: NotificationEventPublisher): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await runInTenantTransaction(pool, tenantId, async (client) => {
      const verified = await client.query('SELECT 1 FROM import_job WHERE id = $1 AND tenant_id = $2', [jobId, tenantId]);
      if (verified.rowCount !== 1) throw new Error(`Import job ${jobId} does not belong to tenant ${tenantId}.`);
      await reclaimStaleRows(client, jobId);
      await client.query(`UPDATE import_job SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'queued'`, [jobId, tenantId]);
    });

    for (;;) {
      const rows = await claimPendingRows(pool, tenantId, jobId);
      if (rows.length === 0) break;
      for (const row of rows) await processClaimedRow(pool, tenantId, jobId, row);
      await publishImportProgress(pool, tenantId, jobId, publish);
    }
    await finalizeImportJob(pool, tenantId, jobId, publish);
    await writeJobNotification(pool, { tenantId, sourceEventId: `import.completed:${jobId}`, type: 'import_completed', severity: 'success', title: 'Import đã hoàn tất', body: `Đã xử lý xong tệp người nhận ${jobId}.`, category: 'import', messageKey: 'import.completed', params: { jobId }, deepLinkRoute: '/recipients?view=imports', entityType: 'import_job', entityId: jobId }, publishNotification);
  } finally {
    await pool.end();
  }
}

async function reclaimStaleRows(pool: Pick<pg.PoolClient, 'query'>, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE import_job_row
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
         FROM import_job_row
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY row_number
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE import_job_row row
       SET status = 'processing', claimed_at = now()
       FROM rows_to_claim
       WHERE row.id = rows_to_claim.id
       RETURNING row.id, row.row_number, row.raw_data`,
      [jobId, CLAIM_BATCH_SIZE],
    );
    return result.rows;
  });
}

async function processClaimedRow(pool: pg.Pool, tenantId: string, jobId: string, row: ClaimedRow): Promise<void> {
  try {
    await runInTenantTransaction(pool, tenantId, async (client) => {
    const jobResult = await client.query<{ tenant_id: string; mode: string; mapping_json: Record<string, string>; created_by: string | null }>(`SELECT tenant_id, mode, mapping_json, created_by FROM import_job WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [jobId, tenantId]);
    const job = jobResult.rows[0];
    if (!job) throw new Error(`Import job ${jobId} was not found in tenant ${tenantId}.`);
    const emailColumn = job.mapping_json.email;
    const email = typeof row.raw_data[emailColumn] === 'string' ? row.raw_data[emailColumn].trim() : '';
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      await markRow(client, row.id, 'failed', 'INVALID_EMAIL');
      return;
    }

    const existingResult = await client.query<{ id: string; subscription_status: string }>(
      `SELECT id, subscription_status FROM recipient WHERE tenant_id = $1 AND normalized_email = lower(trim($2)) AND deleted_at IS NULL FOR UPDATE`,
      [job.tenant_id, email],
    );
    const existing = existingResult.rows[0] ?? null;
    const importedStatus = typeof row.raw_data.subscriptionStatus === 'string' ? row.raw_data.subscriptionStatus : null;
    if ((existing?.subscription_status === 'unsubscribed' || existing?.subscription_status === 'bounced') && importedStatus === 'active') {
      await markRow(client, row.id, 'failed', 'CONSENT_REQUIRED');
      await writePolicyRejectionAudit(client, {
        tenantId: job.tenant_id,
        actorId: job.created_by,
        jobId,
        recipientId: existing.id,
        existingStatus: existing.subscription_status,
        importedStatus,
      });
      return;
    }
    validateClaimedImportRow({ existingStatus: existing?.subscription_status ?? null, importedStatus });

    const importedCustomData = customDataFromImportRow(job.mapping_json, row.raw_data);
    const customData = await validateImportedCustomData(client, job.tenant_id, importedCustomData);
    if (existing && job.mode === 'create_only') {
      await markRow(client, row.id, 'skipped', 'ALREADY_EXISTS', existing.id, 'skipped');
    } else if (!existing && job.mode === 'update_existing') {
      await markRow(client, row.id, 'skipped', 'NOT_FOUND', null, 'skipped');
    } else if (existing) {
      await client.query(
        `UPDATE recipient SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name), custom_data = custom_data || $3::jsonb, updated_at = now(), version = version + 1 WHERE id = $4`,
        [mappedText(job.mapping_json, row.raw_data, 'firstName'), mappedText(job.mapping_json, row.raw_data, 'lastName'), JSON.stringify(customData), existing.id],
      );
      await addMappedSegmentMemberships(client, job.tenant_id, existing.id, job.mapping_json, row.raw_data);
      await markRow(client, row.id, 'succeeded', null, existing.id, 'updated');
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO recipient (tenant_id, email, first_name, last_name, subscription_status, custom_data)
         VALUES ($1, $2, $3, $4, 'active', $5::jsonb)
         RETURNING id`,
        [job.tenant_id, email, mappedText(job.mapping_json, row.raw_data, 'firstName'), mappedText(job.mapping_json, row.raw_data, 'lastName'), JSON.stringify(customData)],
      );
      await addMappedSegmentMemberships(client, job.tenant_id, inserted.rows[0].id, job.mapping_json, row.raw_data);
      await markRow(client, row.id, 'succeeded', null, inserted.rows[0].id, 'created');
    }
    });
  } catch (error) {
    const reason = error instanceof Error && ['CONSENT_REQUIRED', 'UNKNOWN_LIST', 'UNKNOWN_TAG'].includes(error.message) ? error.message : 'ROW_PROCESSING_FAILED';
    await runInTenantTransaction(pool, tenantId, (client) => client.query(`UPDATE import_job_row SET status = 'failed', error = $2, processed_at = now() WHERE id = $1 AND status = 'processing'`, [row.id, reason]).then(() => undefined));
  }
}

/** BR-IMP-005: policy blocks are durable, immutable evidence, not merely failed-row text. */
async function writePolicyRejectionAudit(
  client: pg.PoolClient,
  input: { tenantId: string; actorId: string | null; jobId: string; recipientId: string; existingStatus: string; importedStatus: string },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
     VALUES ($1, $2, 'recipient.import_reactivation_rejected', 'recipient', $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      input.actorId,
      input.recipientId,
      `job:${input.jobId}`,
      JSON.stringify({ reason: 'CONSENT_REQUIRED', sourceJob: input.jobId, existingStatus: input.existingStatus, importedStatus: input.importedStatus }),
    ],
  );
}

async function validateImportedCustomData(client: pg.PoolClient, tenantId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const entries = Object.entries(data);
  if (entries.length === 0) return {};
  const definitions = await client.query<{ field_key: string; data_type: string; enum_options: unknown }>(
    `SELECT field_key, data_type, enum_options FROM custom_field_definition WHERE tenant_id = $1 AND field_key = ANY($2::text[])`,
    [tenantId, entries.map(([key]) => key)],
  );
  if (definitions.rows.length !== entries.length) throw new Error('UNKNOWN_CUSTOM_FIELD');
  const definitionsByKey = new Map(definitions.rows.map((field) => [field.field_key, field]));
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const field = definitionsByKey.get(key);
    if (!field) throw new Error('UNKNOWN_CUSTOM_FIELD');
    result[key] = coerceImportCustomValue(field, value);
  }
  return result;
}

function coerceImportCustomValue(field: { field_key: string; data_type: string; enum_options: unknown }, value: unknown): unknown {
  if (field.data_type === 'text') { if (typeof value === 'string') return value; }
  if (field.data_type === 'number') { const parsed = typeof value === 'number' ? value : Number(value); if (!Number.isNaN(parsed)) return parsed; }
  if (field.data_type === 'boolean') { if (value === true || value === 'true') return true; if (value === false || value === 'false') return false; }
  if (field.data_type === 'date') { if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value; }
  if (field.data_type === 'enum' && Array.isArray(field.enum_options) && field.enum_options.includes(value)) return value;
  throw new Error(`INVALID_CUSTOM_FIELD:${field.field_key}`);
}

async function markRow(client: pg.PoolClient, id: string, status: Extract<ImportRowStatus, 'succeeded' | 'failed' | 'skipped'>, error: string | null, recipientId: string | null = null, outcome: 'created' | 'updated' | 'skipped' | null = null): Promise<void> {
  await client.query(
    `UPDATE import_job_row SET status = $2, error = $3, recipient_id = $4, outcome = $5, processed_at = now() WHERE id = $1 AND status = 'processing'`,
    [id, status, error, recipientId, outcome],
  );
}

async function importCounters(client: pg.PoolClient, tenantId: string, jobId: string): Promise<{ tenantId: string; total: number; succeeded: number; failed: number; skipped: number; processed: number }> {
  const job = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM import_job WHERE id = $1 AND tenant_id = $2', [jobId, tenantId]);
  const result = await client.query<{ total: string; succeeded: string; failed: string; skipped: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
            count(*) FILTER (WHERE status = 'failed')::text AS failed,
            count(*) FILTER (WHERE status = 'skipped')::text AS skipped
     FROM import_job_row WHERE job_id = $1`,
    [jobId],
  );
  const counters = result.rows[0];
  if (!counters || !job.rows[0]) throw new Error(`Import job ${jobId} was not found.`);
  const total = Number(counters.total);
  const succeeded = Number(counters.succeeded);
  const failed = Number(counters.failed);
  const skipped = Number(counters.skipped);
  return { tenantId: job.rows[0].tenant_id, total, succeeded, failed, skipped, processed: succeeded + failed + skipped };
}

async function publishImportProgress(pool: pg.Pool, tenantId: string, jobId: string, publish?: JobEventPublisher): Promise<void> {
  if (!publish) return;
  const event = await runInTenantTransaction(pool, tenantId, async (client) => {
  const claimed = await client.query(
    `UPDATE import_job SET last_progress_emitted_at = now(), updated_at = now()
     WHERE id = $1 AND (last_progress_emitted_at IS NULL OR last_progress_emitted_at <= now() - interval '1 second')
     RETURNING id`,
    [jobId],
  );
  if (claimed.rowCount === 0) return null;
  const counters = await importCounters(client, tenantId, jobId);
  jobMetrics.bulkRows('succeeded', counters.succeeded);
  jobMetrics.bulkRows('failed', counters.failed);
  jobMetrics.bulkRows('skipped', counters.skipped);
  return buildJobEvent({ tenantId: counters.tenantId, jobId, eventType: 'import.progress', version: counters.processed, data: { totalRows: counters.total, processedRows: counters.processed, succeededRows: counters.succeeded, failedRows: counters.failed, skippedRows: counters.skipped } });
  });
  if (event) await publish(event);
}

async function finalizeImportJob(pool: pg.Pool, tenantId: string, jobId: string, publish?: JobEventPublisher): Promise<void> {
  const event = await runInTenantTransaction(pool, tenantId, async (client) => {
  const counters = await importCounters(client, tenantId, jobId);
  await client.query(
    `UPDATE import_job
     SET status = $2, processed_rows = $3, succeeded_rows = $4, failed_rows = $5, skipped_rows = $6, completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [jobId, classifyJobStatus(counters), counters.processed, counters.succeeded, counters.failed, counters.skipped],
  );
  return buildJobEvent({ tenantId: counters.tenantId, jobId, eventType: 'import.completed', version: counters.processed, data: { status: classifyJobStatus(counters), totalRows: counters.total, processedRows: counters.processed, succeededRows: counters.succeeded, failedRows: counters.failed, skippedRows: counters.skipped, errorFileUrl: `/api/v1/import-jobs/${jobId}/error-file` } });
  });
  if (publish) await publish(event);
}
