import pg from 'pg';
import { runInTenantTransaction } from './tenant-database.js';

/** Rows visited per tick. Same bound class as every other cross-tenant scan on this worker. */
const CROSS_TENANT_SCAN_LIMIT = 200;

export type ExportArtifactPurgeResult = {
  tenantId: string;
  exportJobId: string;
};

/**
 * D-131's cleanup: export_job.expires_at (migration 029) already gates
 * *download*, but nothing ever cleared artifact_bytes once an export passed
 * its own expiry. Same cross-tenant sweep shape as export-scan/history-purge:
 * an unlocked SELECT over expired_export_artifacts() decides which rows to
 * visit, then one tenant transaction per row clears the bytea payload and
 * audits it. The row itself (status, filename, row_count, timestamps) is
 * kept for audit/history -- only artifact_bytes is set to NULL.
 *
 * The UPDATE re-checks its own conditions inside the transaction (the same
 * D-121 guard class as every other scan here): a row that a concurrent
 * download-and-extend or re-export changed between the scan and this
 * transaction opening is a safe no-op, not a crash.
 */
export async function purgeExpiredExportArtifacts(databaseUrl: string): Promise<ExportArtifactPurgeResult[]> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const due = await pool.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM expired_export_artifacts($1)`,
      [CROSS_TENANT_SCAN_LIMIT],
    );

    const results: ExportArtifactPurgeResult[] = [];
    for (const row of due.rows) {
      const cleared = await runInTenantTransaction(pool, row.tenant_id, async (client) => {
        const update = await client.query(
          `UPDATE export_job
           SET artifact_bytes = NULL
           WHERE id = $1 AND tenant_id = $2 AND status = 'completed' AND artifact_bytes IS NOT NULL
             AND expires_at IS NOT NULL AND expires_at < now()`,
          [row.id, row.tenant_id],
        );
        if (update.rowCount === 0) return false;
        await client.query(
          `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
           VALUES ($1, NULL, 'history.export.purged', 'export_job', $2, $3, '{}'::jsonb)`,
          [row.tenant_id, row.id, `export-artifact-purge:${row.id}`],
        );
        return true;
      });
      if (cleared) results.push({ tenantId: row.tenant_id, exportJobId: row.id });
    }
    return results;
  } finally {
    await pool.end();
  }
}
