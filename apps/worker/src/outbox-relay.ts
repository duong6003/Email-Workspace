import type { Queue } from 'bullmq';
import pg from 'pg';
import { BULK_JOB_NAME, BULK_QUEUE, bulkQueueJobId } from './bulk-processor.js';
import { IMPORT_JOB_NAME, IMPORT_QUEUE } from './import-processor.js';
import { recordOutboxFailure } from './outbox-dead-letter.js';

export function importQueueJobId(importJobId: string): string {
  // BullMQ reserves ':' in custom job ids, so use a hyphenated stable id.
  return `import-${importJobId}`;
}

/**
 * ADR-012 bridge: Postgres is authoritative. This relay reads only committed
 * outbox rows, gives BullMQ a deterministic id, and marks a row published
 * only after BullMQ has accepted it. Retrying a relay run cannot create a
 * second import worker job for the same import job.
 */
export async function relayUnpublishedImportEvents(databaseUrl: string, queue: Queue, limit = 100): Promise<number> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const rows = await pool.query<{ id: string; aggregate_id: string; tenant_id: string; trace_id: string | null }>(
      `SELECT id, aggregate_id, tenant_id, trace_id FROM relay_pending_outbox_events($1, $2, $3)`,
      ['import.job.created', 'import_job', limit],
    );

    let published = 0;
    let failed = 0;
    for (const row of rows.rows) {
      try {
        await queue.add(IMPORT_JOB_NAME, { jobId: row.aggregate_id, tenantId: row.tenant_id, traceId: row.trace_id ?? undefined }, {
          jobId: importQueueJobId(row.aggregate_id),
          removeOnComplete: 100,
          removeOnFail: 500,
        });
        await pool.query(`SELECT relay_mark_outbox_published($1)`, [row.id]);
        published += 1;
      } catch (error) {
        await recordOutboxFailure(pool, row.id, error, row.tenant_id);
        failed += 1;
      }
    }
    if (rows.rows.length > 0 && failed === rows.rows.length) throw new Error('Unable to publish any import outbox event in the batch.');
    return published;
  } finally {
    await pool.end();
  }
}

/** Same ADR-012 guarantee as imports, but for frozen bulk-update jobs. */
export async function relayUnpublishedBulkEvents(databaseUrl: string, queue: Queue, limit = 100): Promise<number> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const rows = await pool.query<{ id: string; aggregate_id: string; tenant_id: string; trace_id: string | null }>(
      `SELECT id, aggregate_id, tenant_id, trace_id FROM relay_pending_outbox_events($1, $2, $3)`,
      ['bulk-update.job.created', 'bulk_job', limit],
    );

    let published = 0;
    let failed = 0;
    for (const row of rows.rows) {
      try {
        await queue.add(BULK_JOB_NAME, { jobId: row.aggregate_id, tenantId: row.tenant_id, traceId: row.trace_id ?? undefined }, {
          jobId: bulkQueueJobId(row.aggregate_id),
          removeOnComplete: 100,
          removeOnFail: 500,
        });
        await pool.query(`SELECT relay_mark_outbox_published($1)`, [row.id]);
        published += 1;
      } catch (error) {
        await recordOutboxFailure(pool, row.id, error, row.tenant_id);
        failed += 1;
      }
    }
    if (rows.rows.length > 0 && failed === rows.rows.length) throw new Error('Unable to publish any bulk outbox event in the batch.');
    return published;
  } finally {
    await pool.end();
  }
}

export { BULK_QUEUE, IMPORT_QUEUE };
