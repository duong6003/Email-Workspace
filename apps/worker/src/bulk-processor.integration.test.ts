import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { processBulkJob } from './bulk-processor.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from './test-urls.js';

describe('bulk processor (real PostgreSQL recovery)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-bulk-${randomUUID()}`])).rows[0].id;
  });

  afterAll(async () => {
    const jobs = await pool.query<{ id: string }>('SELECT id FROM bulk_job WHERE tenant_id = $1', [tenantId]);
    const jobIds = jobs.rows.map((job) => job.id);
    if (jobIds.length > 0) {
      await pool.query('DELETE FROM bulk_job_row WHERE job_id = ANY($1::uuid[])', [jobIds]);
      await pool.query('DELETE FROM bulk_job WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    await pool.query('DELETE FROM recipient_tag WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM recipient_list_member WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tag WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM recipient_list WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM custom_field_definition WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  it('reclaims a stale row and applies a frozen custom-data update only to in-tenant recipients', async () => {
    const recipient = (await pool.query<{ id: string }>(
      `INSERT INTO recipient (tenant_id, email, custom_data) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [tenantId, `bulk-${randomUUID()}@test.dev`],
    )).rows[0];
    await pool.query(
      `INSERT INTO custom_field_definition (tenant_id, field_key, label, data_type, required, sensitive)
       VALUES ($1, 'department_code', 'Department code', 'text', false, false)`,
      [tenantId],
    );
    const job = (await pool.query<{ id: string }>(
      `INSERT INTO bulk_job (tenant_id, action, action_payload, selection_snapshot, resolved_count)
       VALUES ($1, 'set_custom_data', $2::jsonb, $3::jsonb, 1) RETURNING id`,
      [tenantId, JSON.stringify({ key: 'department_code', value: 'MKT' }), JSON.stringify([recipient.id])],
    )).rows[0];
    await pool.query(
      `INSERT INTO bulk_job_row (job_id, recipient_id, status, claimed_at)
       VALUES ($1, $2, 'processing', now() - interval '2 minutes')`,
      [job.id, recipient.id],
    );

    const events: Record<string, unknown>[] = [];
    await processBulkJob(testAppDatabaseUrl(), tenantId, job.id, async (event) => { events.push(event); });

    expect((await pool.query<{ status: string; error: string | null }>('SELECT status, error FROM bulk_job_row WHERE job_id = $1', [job.id])).rows[0])
      .toEqual({ status: 'succeeded', error: null });
    expect((await pool.query<{ custom_data: Record<string, unknown> }>('SELECT custom_data FROM recipient WHERE id = $1', [recipient.id])).rows[0].custom_data)
      .toEqual({ department_code: 'MKT' });
    expect((await pool.query<{ status: string; processed_rows: number; succeeded_rows: number }>('SELECT status, processed_rows, succeeded_rows FROM bulk_job WHERE id = $1', [job.id])).rows[0])
      .toEqual({ status: 'completed', processed_rows: 1, succeeded_rows: 1 });
    expect(events.map((event) => event.event_type)).toEqual(['bulk_update.progress', 'bulk_update.completed']);
  }, 15_000);

  it('preserves a terminal checkpoint while reclaiming only stale unfinished work within the resolved snapshot', async () => {
    const terminalRecipient = (await pool.query<{ id: string }>(
      `INSERT INTO recipient (tenant_id, email, custom_data) VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [tenantId, `bulk-terminal-${randomUUID()}@test.dev`, JSON.stringify({ recovery_department_code: 'DONE' })],
    )).rows[0];
    const staleRecipient = (await pool.query<{ id: string }>(
      `INSERT INTO recipient (tenant_id, email, custom_data) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [tenantId, `bulk-stale-${randomUUID()}@test.dev`],
    )).rows[0];
    await pool.query(
      `INSERT INTO custom_field_definition (tenant_id, field_key, label, data_type, required, sensitive)
       VALUES ($1, 'recovery_department_code', 'Recovery department code', 'text', false, false)`,
      [tenantId],
    );
    const job = (await pool.query<{ id: string }>(
      `INSERT INTO bulk_job (tenant_id, action, action_payload, selection_snapshot, resolved_count)
       VALUES ($1, 'set_custom_data', $2::jsonb, $3::jsonb, 2) RETURNING id`,
      [tenantId, JSON.stringify({ key: 'recovery_department_code', value: 'RECOVERED' }), JSON.stringify([terminalRecipient.id, staleRecipient.id])],
    )).rows[0];
    const terminalRow = (await pool.query<{ id: string }>(
      `INSERT INTO bulk_job_row (job_id, recipient_id, status, claimed_at, processed_at)
       VALUES ($1, $2, 'succeeded', now() - interval '1 day', now() - interval '1 day')
       RETURNING id::text`,
      [job.id, terminalRecipient.id],
    )).rows[0];
    await pool.query(
      `INSERT INTO bulk_job_row (job_id, recipient_id, status, claimed_at)
       VALUES ($1, $2, 'processing', now() - interval '2 minutes')`,
      [job.id, staleRecipient.id],
    );
    const terminalCheckpointBefore = (await pool.query<{ checkpoint: string }>(
      `SELECT concat_ws('|', status, error, claimed_at::text, processed_at::text) AS checkpoint
       FROM bulk_job_row WHERE id = $1`,
      [terminalRow.id],
    )).rows[0].checkpoint;

    const events: Record<string, unknown>[] = [];
    await processBulkJob(testAppDatabaseUrl(), tenantId, job.id, async (event) => { events.push(event); });

    expect((await pool.query<{ checkpoint: string }>(
      `SELECT concat_ws('|', status, error, claimed_at::text, processed_at::text) AS checkpoint
       FROM bulk_job_row WHERE id = $1`,
      [terminalRow.id],
    )).rows[0].checkpoint).toBe(terminalCheckpointBefore);
    expect((await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM bulk_job_row WHERE job_id = $1 AND recipient_id = $2`,
      [job.id, staleRecipient.id],
    )).rows[0]).toEqual({ status: 'succeeded', error: null });
    expect((await pool.query<{ custom_data: Record<string, unknown> }>(
      `SELECT custom_data FROM recipient WHERE id = $1`,
      [terminalRecipient.id],
    )).rows[0].custom_data).toEqual({ recovery_department_code: 'DONE' });
    expect((await pool.query<{ custom_data: Record<string, unknown> }>(
      `SELECT custom_data FROM recipient WHERE id = $1`,
      [staleRecipient.id],
    )).rows[0].custom_data).toEqual({ recovery_department_code: 'RECOVERED' });
    expect((await pool.query<{ affected: string }>(
      `SELECT count(*)::text AS affected
       FROM recipient
       WHERE id = ANY($1::uuid[]) AND custom_data ->> 'recovery_department_code' = 'RECOVERED'`,
      [[terminalRecipient.id, staleRecipient.id]],
    )).rows[0].affected).toBe('1');
    expect((await pool.query<{ resolved_count: number; processed_rows: number; succeeded_rows: number; failed_rows: number; skipped_rows: number }>(
      `SELECT resolved_count, processed_rows, succeeded_rows, failed_rows, skipped_rows
       FROM bulk_job WHERE id = $1`,
      [job.id],
    )).rows[0]).toEqual({ resolved_count: 2, processed_rows: 2, succeeded_rows: 2, failed_rows: 0, skipped_rows: 0 });
    expect(events.map((event) => event.event_type)).toEqual(['bulk_update.progress', 'bulk_update.completed']);
    for (const event of events) {
      const data = event.data as { resolvedCount: number; processedRows: number };
      expect(data.processedRows).toBeLessThanOrEqual(data.resolvedCount);
    }
  }, 15_000);

  it('exports frozen rows and soft-deletes only the tenant-owned recipient', async () => {
    const own = (await pool.query<{ id: string }>(
      `INSERT INTO recipient (tenant_id, email, custom_data) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [tenantId, `bulk-delete-own-${randomUUID()}@test.dev`],
    )).rows[0];
    const foreignTenant = (await pool.query<{ id: string }>(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [`bulk-delete-foreign-${randomUUID()}`])).rows[0];
    const foreign = (await pool.query<{ id: string }>(
      `INSERT INTO recipient (tenant_id, email, custom_data) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [foreignTenant.id, `bulk-delete-foreign-${randomUUID()}@test.dev`],
    )).rows[0];
    const job = (await pool.query<{ id: string }>(
      `INSERT INTO bulk_job (tenant_id, action, action_payload, selection_snapshot, resolved_count)
       VALUES ($1, 'delete', '{}'::jsonb, $2::jsonb, 1) RETURNING id`,
      [tenantId, JSON.stringify([own.id])],
    )).rows[0];
    await pool.query(`INSERT INTO bulk_job_row (job_id, recipient_id) VALUES ($1, $2)`, [job.id, own.id]);

    await processBulkJob(testAppDatabaseUrl(), tenantId, job.id);

    expect((await pool.query<{ deleted_at: string | null }>('SELECT deleted_at FROM recipient WHERE id = $1', [own.id])).rows[0].deleted_at).not.toBeNull();
    expect((await pool.query<{ deleted_at: string | null }>('SELECT deleted_at FROM recipient WHERE id = $1', [foreign.id])).rows[0].deleted_at).toBeNull();
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [foreignTenant.id]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [foreignTenant.id]);
  }, 15_000);
});
