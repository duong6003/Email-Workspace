import pg from 'pg';
import { runInTenantTransaction } from './tenant-database.js';
import { writeJobNotification } from './notification-writer.js';
import { jobMetrics } from './observability/job-metrics.js';
import { getJobContext, updateJobContext } from './observability/job-context.js';
import { workerLogger } from './observability/logger.js';

const CROSS_TENANT_SCAN_LIMIT = 100;

export type DispatchOutcome = 'dispatched' | 'missed' | 'blocked';
export type DispatchResult = { campaignId: string; tenantId: string; outcome: DispatchOutcome };

/**
 * BR-SCH-006/007/009. Cross-tenant sweep over the narrow OUTBOX_DATABASE_URL
 * boundary (worker/main.ts's own outbox-publish precedent: "Owner/superuser
 * credentials are forbidden") to find due campaigns, then re-enters a tenant
 * transaction per campaign for the actual claim. This scan's own SELECT is
 * unlocked and only decides *which* claim statement to attempt; the claim
 * itself -- one UPDATE guarded by `WHERE status = 'scheduled'` -- is the sole
 * distributed lock (SS3.4): a second dispatcher racing the same campaign
 * matches zero rows on whichever statement it attempts, no advisory lock, no
 * lease table.
 */
export async function scanDueCampaigns(
  outboxDatabaseUrl: string,
  misfireGraceSeconds: number,
  now: Date = new Date(),
): Promise<DispatchResult[]> {
  const pool = new pg.Pool({ connectionString: outboxDatabaseUrl, max: 2 });
  try {
    const due = await pool.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM due_scheduled_campaigns($1, $2)`,
      [now, CROSS_TENANT_SCAN_LIMIT],
    );
    const results: DispatchResult[] = [];
    for (const row of due.rows) {
      const outcome = await dispatchOneCampaign(pool, row.tenant_id, row.id, misfireGraceSeconds, now);
      if (outcome) results.push({ campaignId: row.id, tenantId: row.tenant_id, outcome });
    }
    return results;
  } finally {
    await pool.end();
  }
}

async function auditSchedule(client: { query(sql: string, params?: unknown[]): Promise<unknown> }, tenantId: string, campaignId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
     VALUES ($1, NULL, $2, 'campaign', $3, $4, $5::jsonb)`,
    [tenantId, action, campaignId, getJobContext()?.traceId ?? `dispatcher:${campaignId}`, JSON.stringify(metadata)],
  );
}

async function notifyOwner(pool: pg.Pool, tenantId: string, campaignId: string, messageKey: 'schedule.missed' | 'schedule.blocked', title: string, body: string): Promise<void> {
  await writeJobNotification(pool, {
    tenantId,
    sourceEventId: `${messageKey}:${campaignId}`,
    type: messageKey.replace('.', '_'),
    severity: 'critical',
    title,
    body,
    category: 'campaign',
    messageKey,
    params: { campaignId },
    deepLinkRoute: `/campaigns/${campaignId}`,
    entityType: 'campaign',
    entityId: campaignId,
  });
}

/**
 * Per due campaign, in this order (SS3.4): misfire grace, then sender
 * status, then the exactly-once claim to `queued`. Each branch's own
 * `WHERE status = 'scheduled'` is what makes a concurrent second dispatcher
 * -- or a second decision reached from a since-stale unlocked read -- a
 * guaranteed no-op rather than a double transition.
 */
async function dispatchOneCampaign(
  pool: pg.Pool,
  tenantId: string,
  campaignId: string,
  misfireGraceSeconds: number,
  now: Date,
): Promise<DispatchOutcome | null> {
  return runInTenantTransaction(pool, tenantId, async (client) => {
    updateJobContext({ tenantId, campaignId });
    workerLogger.info({ event: 'campaign.dispatch.checked' }, 'campaign.dispatch.checked');
    const [campaign] = ((await client.query(
      `SELECT scheduled_at_utc FROM campaign WHERE id = $1 AND tenant_id = $2 AND status = 'scheduled'`,
      [campaignId, tenantId],
    )) as { rows: Array<{ scheduled_at_utc: string }> }).rows;
    if (!campaign) return null;

    const dueAt = new Date(campaign.scheduled_at_utc);
    const latenessSeconds = Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / 1000));

    if (latenessSeconds > misfireGraceSeconds) {
      const claimed = await client.query(
        `UPDATE campaign SET status = 'missed', scheduled_at_utc = NULL, scheduled_timezone = NULL, version = version + 1, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND status = 'scheduled'`,
        [campaignId, tenantId],
      ) as { rowCount: number };
      if (claimed.rowCount === 0) return null;
      await auditSchedule(client, tenantId, campaignId, 'schedule.missed', { latenessSeconds });
      await notifyOwner(pool, tenantId, campaignId, 'schedule.missed', 'Chiến dịch đã bỏ lỡ lịch gửi', `Chiến dịch trễ ${latenessSeconds} giây so với giờ hẹn và sẽ không tự động gửi.`);
      jobMetrics.scheduleMisfire('missed');
      return 'missed';
    }

    const [snapshot] = ((await client.query(
      `SELECT sender_json FROM campaign_snapshot WHERE tenant_id = $1 AND campaign_id = $2 AND superseded_at IS NULL`,
      [tenantId, campaignId],
    )) as { rows: Array<{ sender_json: { senderConfigId?: string | null } }> }).rows;
    const senderConfigId = snapshot?.sender_json?.senderConfigId;
    if (senderConfigId) {
      const [sender] = ((await client.query(
        `SELECT status FROM sender_config WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [senderConfigId, tenantId],
      )) as { rows: Array<{ status: string }> }).rows;
      if (sender?.status === 'disabled') {
        const claimed = await client.query(
          `UPDATE campaign SET status = 'blocked', version = version + 1, updated_at = now()
           WHERE id = $1 AND tenant_id = $2 AND status = 'scheduled'`,
          [campaignId, tenantId],
        ) as { rowCount: number };
        if (claimed.rowCount === 0) return null;
        await auditSchedule(client, tenantId, campaignId, 'schedule.blocked', { senderConfigId });
        await notifyOwner(pool, tenantId, campaignId, 'schedule.blocked', 'Chiến dịch bị chặn gửi', 'Cấu hình gửi đã bị tắt. Vui lòng chọn cấu hình khác rồi lên lịch lại.');
        jobMetrics.scheduleMisfire('blocked');
        return 'blocked';
      }
    }

    const claimed = await client.query(
      `UPDATE campaign
         SET status = 'queued', actual_started_at = now(), delay_seconds = $3, version = version + 1, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'scheduled'
       RETURNING id`,
      [campaignId, tenantId, latenessSeconds],
    ) as { rowCount: number };
    if (claimed.rowCount === 0) return null;

    const versionRow = ((await client.query(`SELECT version FROM campaign WHERE id = $1 AND tenant_id = $2`, [campaignId, tenantId])) as { rows: Array<{ version: string }> }).rows[0];
    await auditSchedule(client, tenantId, campaignId, 'schedule.dispatched', { delaySeconds: latenessSeconds });
    await client.query(
      `INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload)
       VALUES ($1, 'schedule.state_changed', 'campaign', $2, $3, $4::jsonb)
       ON CONFLICT (aggregate_type, aggregate_id, aggregate_version, event_type) DO NOTHING`,
      [tenantId, campaignId, versionRow.version, JSON.stringify({ status: 'queued', delaySeconds: latenessSeconds })],
    );
    jobMetrics.scheduleMisfire('dispatched');
    return 'dispatched';
  });
}
