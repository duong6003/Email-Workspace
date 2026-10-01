import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { QuotaRepository } from '../../src/quota/quota.repository.js';
import { testAppDatabaseUrl, testDatabaseUrl } from './test-database-url.js';

describe('BR-CFG-006: quota_reservation is tenant-isolated under the eow_app role', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl() });
    app = new pg.Pool({ connectionString: testAppDatabaseUrl() });
    const a = await owner.query(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [`quota-res-a-${randomUUID()}`]);
    const b = await owner.query(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [`quota-res-b-${randomUUID()}`]);
    tenantA = a.rows[0].id;
    tenantB = b.rows[0].id;
    for (const tenantId of [tenantA, tenantB]) {
      await owner.query(
        `INSERT INTO quota_reservation (tenant_id, campaign_id, period_key, amount, state)
         VALUES ($1, $2, '2026-08', 10, 'held')`,
        [tenantId, randomUUID()],
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (owner) {
      await owner.query(`DELETE FROM quota_reservation WHERE tenant_id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
      await owner.query(`DELETE FROM tenant WHERE id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
    }
    await app?.end();
    await owner?.end();
  }, 60_000);

  it('sees only its own tenant rows through the narrow eow_app role', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      const rows = await client.query(`SELECT tenant_id::text FROM quota_reservation`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].tenant_id).toBe(tenantA);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('rejects an amount of zero or less', async () => {
    await expect(
      owner.query(
        `INSERT INTO quota_reservation (tenant_id, campaign_id, period_key, amount, state)
         VALUES ($1, $2, '2026-08', 0, 'held')`,
        [tenantA, randomUUID()],
      ),
    ).rejects.toThrow(/quota_reservation_amount_positive/);
  });
});


describe('TC-CFG-006: concurrent confirmations do not oversubscribe', () => {
  let owner: pg.Pool;
  let tenantId: string;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testAppDatabaseUrl() });
    const ownerPool = new pg.Pool({ connectionString: testDatabaseUrl() });
    const tenant = await ownerPool.query(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [`quota-conc-${randomUUID()}`]);
    tenantId = tenant.rows[0].id;
    await ownerPool.query(
      `INSERT INTO sending_policy (tenant_id, send_quota_limit, send_quota_period, updated_by)
       VALUES ($1, 100, 'month', NULL)`,
      [tenantId],
    );
    await ownerPool.end();
  }, 60_000);

  afterAll(async () => {
    const ownerPool = new pg.Pool({ connectionString: testDatabaseUrl() });
    await ownerPool.query(`DELETE FROM quota_reservation WHERE tenant_id = $1`, [tenantId]);
    await ownerPool.query(`DELETE FROM sending_policy WHERE tenant_id = $1`, [tenantId]);
    await ownerPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
    await ownerPool.end();
    await owner?.end();
  }, 60_000);

  it('admits the first 60-unit hold and refuses the second, leaving usage at 60', async () => {
    const attempt = async (campaignId: string) => {
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        const repository = new QuotaRepository(client);
        const outcome = await repository.reserve(tenantId, campaignId, null, '2026-08', 60);
        await client.query('COMMIT');
        return outcome;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    const [first, second] = await Promise.all([
      attempt(randomUUID()).catch((error: Error) => error),
      attempt(randomUUID()).catch((error: Error) => error),
    ]);

    const outcomes = [first, second].filter((result): result is { admitted: boolean; usedAfter: number } => !(result instanceof Error));
    expect(outcomes).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.admitted)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.admitted)).toHaveLength(1);

    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const used = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::int AS used FROM quota_reservation WHERE tenant_id = $1 AND period_key = '2026-08' AND state = 'held'`,
        [tenantId],
      );
      expect(used.rows[0].used).toBe(60);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }, 30_000);
});
