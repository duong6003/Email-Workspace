import pg from 'pg';
import { buildJobEvent } from './job-events.js';
import type { JobEventPublisher } from './import-processor.js';
import { runInTenantTransaction } from './tenant-database.js';
import { writeJobNotification } from './notification-writer.js';
import type { NotificationEventPublisher } from './notification-writer.js';

/**
 * BR-HIS-003/BR-HIS-007's export artifact. API-native duplicate at
 * apps/api/src/campaigns/export-render.ts (DEC-107/DEC-123 transliteration
 * precedent -- ARCH-EXPORT-PARITY keeps the two in step: any edit here
 * needs the matching edit there). Pure and DB-free so both copies are
 * exhaustively unit-testable without a database.
 *
 * Exactly the documented delivery columns, drawn only from campaign_recipient/
 * recipient/message_attempt -- never sender_config (secret_ref) or
 * app_user, so no secret can reach this file by construction (BR-HIS-007:
 * "Export ... khong bao gom secret").
 */
export type ExportRow = {
  recipientEmail: string;
  status: string;
  skippedReason: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorClass: string | null;
  lastErrorReason: string | null;
  submittedAt: string | null;
  deliveredAt: string | null;
};

function escapeCsv(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function renderExportCsv(rows: ExportRow[]): string {
  const header = 'recipient_email,status,skipped_reason,attempt_count,last_error_code,last_error_class,last_error_reason,submitted_at,delivered_at';
  const records = rows.map((row) => [
    row.recipientEmail,
    row.status,
    row.skippedReason ?? '',
    String(row.attemptCount),
    row.lastErrorCode ?? '',
    row.lastErrorClass ?? '',
    row.lastErrorReason ?? '',
    row.submittedAt ?? '',
    row.deliveredAt ?? '',
  ]);
  return [header, ...records.map((record) => record.map(escapeCsv).join(','))].join('\r\n') + '\r\n';
}

type ExportJobRow = { id: string; campaign_id: string; snapshot_id: string | null; status_filter: string[] };

/**
 * BR-HIS-003's background export -- picked up via the cross-tenant
 * `queued_export_jobs()` scan (main.ts's `export-scan` case) once a
 * creation request exceeded EXPORT_INLINE_MAX_ROWS. D-121's own guard
 * class from the very first line: the scan's own unlocked SELECT can list
 * a job whose campaign row a genuinely concurrent transaction has since
 * changed, so a missing row is a safe no-op, never a crash.
 */
export async function processExportJob(databaseUrl: string, tenantId: string, jobId: string, publish?: JobEventPublisher, publishNotification?: NotificationEventPublisher): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const job = await runInTenantTransaction(pool, tenantId, async (client) => {
      // export_job has no snapshot_id of its own -- it carries execution_id
      // (the live execution at creation time), so the snapshot comes from
      // joining through campaign_execution, the same live-join shape
      // run.ts's own currentExecutionId already uses.
      const [row] = ((await client.query(
        `SELECT ej.id, ej.campaign_id, ce.snapshot_id::text AS snapshot_id, ej.status_filter
         FROM export_job ej
         LEFT JOIN campaign_execution ce ON ce.id = ej.execution_id AND ce.tenant_id = ej.tenant_id
         WHERE ej.id = $1 AND ej.tenant_id = $2 AND ej.status = 'queued'`,
        [jobId, tenantId],
      )) as { rows: ExportJobRow[] }).rows;
      if (!row) return null;
      await client.query(`UPDATE export_job SET status = 'running', started_at = now() WHERE id = $1`, [jobId]);
      return row;
    });
    if (!job) return;

    if (!job.snapshot_id) {
      await runInTenantTransaction(pool, tenantId, (client) =>
        client.query(`UPDATE export_job SET status = 'failed', failure_code = 'NO_LIVE_SNAPSHOT', completed_at = now() WHERE id = $1`, [jobId]));
      return;
    }

    const conditions = ['cr.tenant_id = $1', 'cr.snapshot_id = $2'];
    const params: unknown[] = [tenantId, job.snapshot_id];
    if (job.status_filter.length > 0) {
      params.push(job.status_filter);
      conditions.push(`cr.status = ANY($${params.length}::text[])`);
    }

    const rows = await runInTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `SELECT cr.recipient_email, cr.status, cr.skipped_reason, cr.attempt_count,
                ma.error_code AS last_error_code, ma.error_class AS last_error_class, ma.provider_response AS last_error_reason,
                sub.attempted_at AS submitted_at, del.occurred_at AS delivered_at
         FROM campaign_recipient cr
         LEFT JOIN LATERAL (
           SELECT error_code, error_class, provider_response FROM message_attempt
           WHERE campaign_recipient_id = cr.id AND tenant_id = cr.tenant_id
           ORDER BY attempt_no DESC LIMIT 1
         ) ma ON true
         LEFT JOIN LATERAL (
           SELECT attempted_at FROM message_attempt
           WHERE campaign_recipient_id = cr.id AND tenant_id = cr.tenant_id AND outcome = 'submitted'
           ORDER BY attempt_no DESC LIMIT 1
         ) sub ON true
         LEFT JOIN LATERAL (
           SELECT occurred_at FROM delivery_event
           WHERE campaign_recipient_id = cr.id AND tenant_id = cr.tenant_id AND event_type = 'delivered'
           ORDER BY occurred_at DESC LIMIT 1
         ) del ON true
         WHERE ${conditions.join(' AND ')}
         ORDER BY cr.recipient_email`,
        params,
      ).then((result) => result.rows as Array<{
        recipient_email: string; status: string; skipped_reason: string | null; attempt_count: number;
        last_error_code: string | null; last_error_class: string | null; last_error_reason: string | null; submitted_at: Date | null; delivered_at: Date | null;
      }>));

    const exportRows: ExportRow[] = rows.map((row) => ({
      recipientEmail: row.recipient_email,
      status: row.status,
      skippedReason: row.skipped_reason,
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code,
      lastErrorClass: row.last_error_class,
      lastErrorReason: row.last_error_reason,
      submittedAt: row.submitted_at ? row.submitted_at.toISOString() : null,
      deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
    }));
    const csv = renderExportCsv(exportRows);
    const filename = `campaign-${job.campaign_id}-export-${job.id}.csv`;

    await runInTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `UPDATE export_job
         SET status = 'completed', artifact_bytes = $2, artifact_filename = $3,
             expires_at = now() + (($4::text || ' hours')::interval), completed_at = now()
         WHERE id = $1`,
        [jobId, Buffer.from(csv, 'utf8'), filename, String(Number(process.env.EXPORT_ARTIFACT_TTL_HOURS ?? 72))],
      ));

    if (publish) {
      await publish(buildJobEvent({ tenantId, jobId, eventType: 'export.completed', version: 1, data: { jobId, campaignId: job.campaign_id, rowCount: rows.length, status: 'completed' } }));
    }
    await writeJobNotification(pool, {
      tenantId, sourceEventId: `export.completed:${jobId}`, type: 'export_completed', severity: 'success',
      title: 'Xuất dữ liệu đã hoàn tất', body: `Tệp xuất cho tác vụ ${jobId} đã sẵn sàng để tải xuống.`,
      category: 'export', messageKey: 'export.completed', params: { jobId }, deepLinkRoute: '/history',
      entityType: 'campaign', entityId: job.campaign_id,
    }, publishNotification);
  } finally {
    await pool.end();
  }
}
