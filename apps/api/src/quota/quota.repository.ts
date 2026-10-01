export type QuotaQueryable = { query(sql: string, params?: unknown[]): Promise<unknown> };
export type QuotaConfig = { limit: number | null; period: 'day' | 'month' };
export type ReserveOutcome = { admitted: boolean; limit: number | null; usedBefore: number; usedAfter: number };

type Row = Record<string, unknown>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) {
    if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as Row[];
    return result as Row[];
  }
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Row[] }).rows;
  }
  return [];
}

export class QuotaRepository {
  constructor(private readonly db: QuotaQueryable) {}

  async getConfig(tenantId: string): Promise<QuotaConfig> {
    const result = rows(await this.db.query(
      `SELECT send_quota_limit, send_quota_period
         FROM sending_policy
        WHERE tenant_id = $1`,
      [tenantId],
    ));
    const row = result[0];
    return {
      limit: row?.send_quota_limit === null || row?.send_quota_limit === undefined ? null : Number(row.send_quota_limit),
      period: row?.send_quota_period === 'day' ? 'day' : 'month',
    };
  }

  async lockConfig(tenantId: string): Promise<QuotaConfig> {
    const result = rows(await this.db.query(
      `SELECT send_quota_limit, send_quota_period
         FROM sending_policy
        WHERE tenant_id = $1
        FOR UPDATE`,
      [tenantId],
    ));
    const row = result[0];
    return {
      limit: row?.send_quota_limit === null || row?.send_quota_limit === undefined ? null : Number(row.send_quota_limit),
      period: row?.send_quota_period === 'day' ? 'day' : 'month',
    };
  }

  async usedInPeriod(tenantId: string, periodKey: string): Promise<number> {
    const result = rows(await this.db.query(
      `SELECT COALESCE(SUM(amount), 0)::int AS used
         FROM quota_reservation
        WHERE tenant_id = $1 AND period_key = $2 AND state = 'held'`,
      [tenantId, periodKey],
    ));
    return Number(result[0]?.used ?? 0);
  }

  async reserve(tenantId: string, campaignId: string, snapshotId: string | null, periodKey: string, amount: number): Promise<ReserveOutcome> {
    const config = await this.lockConfig(tenantId);
    const usedBefore = await this.usedInPeriod(tenantId, periodKey);
    if (amount <= 0) return { admitted: true, limit: config.limit, usedBefore, usedAfter: usedBefore };
    if (config.limit !== null && usedBefore + amount > config.limit) {
      return { admitted: false, limit: config.limit, usedBefore, usedAfter: usedBefore };
    }
    const inserted = rows(await this.db.query(
      `INSERT INTO quota_reservation (tenant_id, campaign_id, snapshot_id, period_key, amount, state)
            VALUES ($1, $2, $3, $4, $5, 'held')
       ON CONFLICT (tenant_id, campaign_id, period_key) WHERE state = 'held' DO NOTHING
         RETURNING id::text`,
      [tenantId, campaignId, snapshotId, periodKey, amount],
    ));
    return { admitted: true, limit: config.limit, usedBefore, usedAfter: inserted.length === 0 ? usedBefore : usedBefore + amount };
  }

  async release(tenantId: string, campaignId: string, periodKey: string): Promise<number> {
    const released = rows(await this.db.query(
      `UPDATE quota_reservation
          SET state = 'released', released_at = now()
        WHERE tenant_id = $1 AND campaign_id = $2 AND period_key = $3 AND state = 'held'
      RETURNING amount`,
      [tenantId, campaignId, periodKey],
    ));
    return released.reduce((total, row) => total + Number(row.amount ?? 0), 0);
  }

  async releasePartial(tenantId: string, campaignId: string, periodKey: string, keepConsumed: number): Promise<number> {
    const updated = rows(await this.db.query(
      `UPDATE quota_reservation
          SET amount = CASE WHEN $4 > 0 THEN $4 ELSE amount END,
              consumed = CASE WHEN $4 > 0 THEN LEAST(consumed, $4) ELSE consumed END,
              state = CASE WHEN $4 > 0 THEN state ELSE 'released' END,
              released_at = CASE WHEN $4 > 0 THEN released_at ELSE now() END
        WHERE tenant_id = $1 AND campaign_id = $2 AND period_key = $3 AND state = 'held'
      RETURNING amount`,
      [tenantId, campaignId, periodKey, keepConsumed],
    ));
    return updated.reduce((total, row) => total + Number(row.amount ?? 0), 0);
  }

  async claimThreshold(tenantId: string, periodKey: string, threshold: number): Promise<boolean> {
    const claimed = rows(await this.db.query(
      `INSERT INTO quota_threshold_emission (tenant_id, period_key, threshold)
            VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, period_key, threshold) DO NOTHING
         RETURNING threshold`,
      [tenantId, periodKey, threshold],
    ));
    return claimed.length > 0;
  }
}
