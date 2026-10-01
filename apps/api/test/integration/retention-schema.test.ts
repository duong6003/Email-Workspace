import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { testDatabaseUrl } from './test-database-url.js';

/**
 * M6-S4 CP2 (BR-HIS-006, A3/A7/A8). Migration 032's own contract: the
 * per-tenant policy row, the bounded cross-tenant scan, and the purge
 * function's 30-day floor -- the floor lives in the database so a wrong
 * caller cannot delete recent evidence (plan SS0(e)).
 */
describe('Migration 032 retention schema (M6-S4 CP2)', () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`retention-schema-${randomUUID()}`])).rows[0].id;
    otherTenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`retention-schema-other-${randomUUID()}`])).rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM retention_policy WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
    await pool.query('DELETE FROM tenant WHERE id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
    await pool.end();
  });

  it('A8: rejects a retention window below the 30-day floor', async () => {
    await expect(
      pool.query('INSERT INTO retention_policy (tenant_id, message_event_retention_days) VALUES ($1, 29)', [tenantId]),
    ).rejects.toThrow(/retention_policy_days_bounded/);
  });

  it('A8: rejects a retention window above 3650 days', async () => {
    await expect(
      pool.query('INSERT INTO retention_policy (tenant_id, message_event_retention_days) VALUES ($1, 3651)', [tenantId]),
    ).rejects.toThrow(/retention_policy_days_bounded/);
  });

  it('A8: accepts a value inside the bounds and enforces one row per tenant', async () => {
    await pool.query('INSERT INTO retention_policy (tenant_id, message_event_retention_days) VALUES ($1, 30)', [tenantId]);
    await expect(
      pool.query('INSERT INTO retention_policy (tenant_id, message_event_retention_days) VALUES ($1, 60)', [tenantId]),
    ).rejects.toThrow(/retention_policy_tenant_id_key/);
    await pool.query('DELETE FROM retention_policy WHERE tenant_id = $1', [tenantId]);
  });

  it('A3: refuses a cutoff inside the 30-day floor and deletes nothing', async () => {
    await expect(
      pool.query("SELECT * FROM purge_message_events($1, now() - interval '29 days', 100)", [tenantId]),
    ).rejects.toThrow(/30-day floor/);
  });

  it('A3: accepts a cutoff outside the floor and reports zero deletions for an empty tenant', async () => {
    const result = await pool.query<{ message_attempts_deleted: number; delivery_events_deleted: number; executions_affected: number }>(
      "SELECT * FROM purge_message_events($1, now() - interval '400 days', 100)",
      [tenantId],
    );
    expect(result.rows[0]).toEqual({ message_attempts_deleted: 0, delivery_events_deleted: 0, executions_affected: 0 });
  });

  it('A7: omits a tenant with no events at all', async () => {
    const result = await pool.query<{ tenant_id: string }>('SELECT tenant_id FROM purgeable_retention_tenants(365, 25)');
    expect(result.rows.map((row) => row.tenant_id)).not.toContain(tenantId);
  });

  it('the purge functions are not executable by PUBLIC', async () => {
    const result = await pool.query<{ has: boolean }>(
      `SELECT has_function_privilege('public', 'purge_message_events(uuid, timestamptz, integer)', 'EXECUTE') AS has`,
    );
    expect(result.rows[0].has).toBe(false);
  });
});
