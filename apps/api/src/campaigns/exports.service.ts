import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { ValidatedEnv } from '../config/env.js';
import { appendAuditLog } from '../common/audit-writer.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { CampaignsRepository } from './campaigns.repository.js';
import { CampaignSnapshotRepository } from './campaign-snapshot.repository.js';
import type { CreateExportDto } from './dto/export.dto.js';
import { renderExportCsv, type ExportRow } from './export-render.js';
import type { CampaignActor } from './campaigns.types.js';

export type ExportJobResponse = {
  id: string;
  campaignId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  kind: string;
  rowCount: number;
  expiresAt: string | null;
  createdAt: string;
};

function toResponse(row: {
  id: string; campaign_id: string; status: string; kind: string; row_count: number;
  expires_at: Date | null; created_at: Date;
}): ExportJobResponse {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    status: row.status as ExportJobResponse['status'],
    kind: row.kind,
    rowCount: row.row_count,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * BR-HIS-003/BR-HIS-007. `POST /campaigns/:id/exports` gated by
 * `history:export` at the controller. Renders inline at or below
 * `EXPORT_INLINE_MAX_ROWS`; above it, leaves the row `queued` for the
 * worker's own export-scan (CP8) to pick up via `queued_export_jobs()`.
 * Either way the client polls/downloads the same two routes.
 */
@Injectable()
export class CampaignExportsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<ValidatedEnv, true>,
  ) {}

  async create(tenantId: string, campaignId: string, actorId: string | null, input: CreateExportDto): Promise<ExportJobResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const campaign = await new CampaignsRepository(manager, tenantId).findActiveById(campaignId);
      if (!campaign) throw new NotFoundException('Campaign was not found.');

      const snapshot = await new CampaignSnapshotRepository(manager, tenantId).findLive(campaign.id);
      const statusFilter = input.kind === 'campaign_failures' ? ['failed'] : (input.statusFilter ?? []);

      const params: unknown[] = [tenantId, snapshot?.id ?? null];
      let statusFilterParamIndex: number | null = null;
      if (statusFilter.length > 0) {
        params.push(statusFilter);
        statusFilterParamIndex = params.length;
      }
      // Reused by both the plain count query and the joined export SELECT
      // below (which also joins `recipient`, a table with its own
      // tenant_id) -- qualifying with cr. keeps both unambiguous.
      const conditions = ['cr.tenant_id = $1', 'cr.snapshot_id = $2'];
      if (statusFilterParamIndex) conditions.push(`cr.status = ANY($${statusFilterParamIndex}::text[])`);

      const [countRow] = (await manager.query(
        `SELECT count(*)::int AS count FROM campaign_recipient cr WHERE ${conditions.join(' AND ')}`,
        params,
      )) as Array<{ count: number }>;
      const rowCount = countRow.count;

      const inlineMaxRows = this.config.get('EXPORT_INLINE_MAX_ROWS', { infer: true });
      const ttlHours = this.config.get('EXPORT_ARTIFACT_TTL_HOURS', { infer: true });
      const shouldRenderInline = rowCount <= inlineMaxRows;

      const [job] = (await manager.query(
        `INSERT INTO export_job (tenant_id, campaign_id, execution_id, kind, status, status_filter, row_count, created_by)
         VALUES ($1, $2, (SELECT id FROM campaign_execution WHERE tenant_id = $1 AND snapshot_id = $3), $4, 'queued', $5, $6, $7)
         RETURNING id, campaign_id, status, kind, row_count, expires_at, created_at`,
        [tenantId, campaign.id, snapshot?.id ?? null, input.kind, statusFilter, rowCount, actorId],
      )) as Array<{ id: string; campaign_id: string; status: string; kind: string; row_count: number; expires_at: Date | null; created_at: Date }>;

      if (!shouldRenderInline) return toResponse(job);

      const rows = (await manager.query(
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
      )) as Array<{ recipient_email: string; status: string; skipped_reason: string | null; attempt_count: number; last_error_code: string | null; last_error_class: string | null; last_error_reason: string | null; submitted_at: Date | null; delivered_at: Date | null }>;

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
      const filename = `campaign-${campaign.id}-export-${job.id}.csv`;
      const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

      // D-125: TypeORM's EntityManager query method returns [rows,
      // affectedCount] for UPDATE/DELETE (unlike SELECT/INSERT, which
      // return bare rows) -- the outer pair must be unwrapped before
      // destructuring a row.
      const [[completed]] = (await manager.query(
        `UPDATE export_job
         SET status = 'completed', artifact_bytes = $2, artifact_filename = $3, expires_at = $4, completed_at = now(), started_at = now()
         WHERE id = $1 AND tenant_id = $5
         RETURNING id, campaign_id, status, kind, row_count, expires_at, created_at`,
        [job.id, Buffer.from(csv, 'utf8'), filename, expiresAt, tenantId],
      )) as [Array<{ id: string; campaign_id: string; status: string; kind: string; row_count: number; expires_at: Date | null; created_at: Date }>, number];

      return toResponse(completed);
    });
  }

  async get(tenantId: string, campaignId: string, exportId: string): Promise<ExportJobResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const [row] = (await manager.query(
        `SELECT id, campaign_id, status, kind, row_count, expires_at, created_at
         FROM export_job WHERE id = $1 AND tenant_id = $2 AND campaign_id = $3`,
        [exportId, tenantId, campaignId],
      )) as Array<{ id: string; campaign_id: string; status: string; kind: string; row_count: number; expires_at: Date | null; created_at: Date }>;
      if (!row) throw new NotFoundException('Export job was not found.');
      return toResponse(row);
    });
  }

  /**
   * BR-HIS-007's "file có expiry và audit download" -- a 410 past expiry
   * serves no bytes, and every successful download writes one audit_log
   * row and increments downloaded_count in the same transaction as the
   * read, so the count is exact even under concurrent downloads.
   */
  async download(tenantId: string, campaignId: string, exportId: string, actor: CampaignActor): Promise<{ fileName: string; contents: Buffer }> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const [row] = (await manager.query(
        `SELECT id, status, artifact_bytes, artifact_filename, expires_at
         FROM export_job WHERE id = $1 AND tenant_id = $2 AND campaign_id = $3`,
        [exportId, tenantId, campaignId],
      )) as Array<{ id: string; status: string; artifact_bytes: Buffer | null; artifact_filename: string | null; expires_at: Date | null }>;
      if (!row || row.status !== 'completed' || !row.artifact_filename) {
        throw new NotFoundException('Export artifact was not found.');
      }
      // D-131: the background purge (apps/worker/src/export-purge.ts) clears
      // artifact_bytes once expires_at passes, but keeps the row -- so an
      // expired job can reach here with a NULL payload well after its own
      // expiry. Check expiry before artifact_bytes so an expired export
      // always reads as 410 Gone, never as 404, regardless of whether the
      // purge has already run against it.
      if (!row.expires_at || row.expires_at.getTime() <= Date.now()) {
        throw new GoneException('Export artifact has expired.');
      }
      if (!row.artifact_bytes) {
        throw new NotFoundException('Export artifact was not found.');
      }

      await manager.query(`UPDATE export_job SET downloaded_count = downloaded_count + 1 WHERE id = $1 AND tenant_id = $2`, [exportId, tenantId]);
      await appendAuditLog(manager, {
        tenantId, actorId: actor.actorId, action: 'history.export.downloaded', entityType: 'export_job', entityId: exportId, traceId: actor.traceId,
        metadata: { campaignId },
      });

      return { fileName: row.artifact_filename, contents: row.artifact_bytes };
    });
  }
}
