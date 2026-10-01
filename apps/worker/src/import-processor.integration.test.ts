import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { processImportJob } from './import-processor.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from './test-urls.js';

describe('import processor (real PostgreSQL recovery)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-import-${randomUUID()}`])).rows[0].id;
  });

  afterAll(async () => {
    const jobs = await pool.query<{ id: string }>('SELECT id FROM import_job WHERE tenant_id = $1', [tenantId]);
    const jobIds = jobs.rows.map((job) => job.id);
    if (jobIds.length > 0) {
      await pool.query('DELETE FROM import_job_row WHERE job_id = ANY($1::uuid[])', [jobIds]);
      await pool.query('DELETE FROM import_job WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    await pool.query('DELETE FROM recipient_tag WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM recipient_list_member WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantId]);
    // audit_log is deliberately immutable and references its tenant. This suite
    // therefore follows the integration-test convention of retaining its tenant
    // and policy-rejection evidence after removing mutable fixture rows.
    await pool.end();
  });

  it('reclaims a stale claimed row, commits valid rows independently, and ends partial_success without reactivating unsubscribed or bounced recipients', async () => {
    const unsubscribed = (await pool.query<{ id: string }>(
      `INSERT INTO recipient (tenant_id, email, subscription_status, custom_data, unsubscribed_at)
       VALUES ($1, $2, 'unsubscribed', '{}'::jsonb, now()) RETURNING id`,
      [tenantId, `unsubscribed-${randomUUID()}@test.dev`],
    )).rows[0];
    const bounced = (await pool.query<{ id: string }>(
      `INSERT INTO recipient (tenant_id, email, subscription_status, custom_data)
       VALUES ($1, $2, 'bounced', '{}'::jsonb) RETURNING id`,
      [tenantId, `bounced-${randomUUID()}@test.dev`],
    )).rows[0];
    const job = (await pool.query<{ id: string }>(
      `INSERT INTO import_job (tenant_id, file_name, mapping_json, total_rows)
       VALUES ($1, 'recipients.csv', $2::jsonb, 4) RETURNING id`,
      [tenantId, JSON.stringify({ email: 'Email', firstName: 'First name', lastName: 'Last name' })],
    )).rows[0];
    await pool.query(
      `INSERT INTO import_job_row (job_id, row_number, raw_data, status, claimed_at) VALUES
       ($1, 2, $2::jsonb, 'processing', now() - interval '2 minutes'),
       ($1, 3, $3::jsonb, 'pending', NULL),
       ($1, 4, $4::jsonb, 'pending', NULL),
       ($1, 5, $5::jsonb, 'pending', NULL)`,
      [
        job.id,
        JSON.stringify({ Email: `fresh-${randomUUID()}@test.dev`, 'First name': 'Fresh' }),
        JSON.stringify({ Email: `unsubscribed-${randomUUID()}@test.dev`, subscriptionStatus: 'active' }),
        JSON.stringify({ Email: `bounced-${randomUUID()}@test.dev`, subscriptionStatus: 'active' }),
        JSON.stringify({ Email: 'not-an-email' }),
      ],
    );
    // Point policy-rejection rows at the pre-existing recipient emails after fixtures are created.
    await pool.query(`UPDATE import_job_row SET raw_data = $2::jsonb WHERE job_id = $1 AND row_number = 3`, [job.id, JSON.stringify({ Email: (await pool.query<{ email: string }>('SELECT email FROM recipient WHERE id = $1', [unsubscribed.id])).rows[0].email, subscriptionStatus: 'active' })]);
    await pool.query(`UPDATE import_job_row SET raw_data = $2::jsonb WHERE job_id = $1 AND row_number = 4`, [job.id, JSON.stringify({ Email: (await pool.query<{ email: string }>('SELECT email FROM recipient WHERE id = $1', [bounced.id])).rows[0].email, subscriptionStatus: 'active' })]);

    const events: Record<string, unknown>[] = [];
    await processImportJob(testAppDatabaseUrl(), tenantId, job.id, async (event) => { events.push(event); });

    const rows = await pool.query<{ row_number: number; status: string; error: string | null; outcome: string | null }>(
      'SELECT row_number, status, error, outcome FROM import_job_row WHERE job_id = $1 ORDER BY row_number', [job.id],
    );
    expect(rows.rows).toEqual([
      { row_number: 2, status: 'succeeded', error: null, outcome: 'created' },
      { row_number: 3, status: 'failed', error: 'CONSENT_REQUIRED', outcome: null },
      { row_number: 4, status: 'failed', error: 'CONSENT_REQUIRED', outcome: null },
      { row_number: 5, status: 'failed', error: 'INVALID_EMAIL', outcome: null },
    ]);
    const finalJob = await pool.query<{ status: string; processed_rows: number; succeeded_rows: number; failed_rows: number }>(
      'SELECT status, processed_rows, succeeded_rows, failed_rows FROM import_job WHERE id = $1', [job.id],
    );
    expect(finalJob.rows[0]).toEqual({ status: 'partial_success', processed_rows: 4, succeeded_rows: 1, failed_rows: 3 });
    const audits = await pool.query<{ action: string; entity_id: string; metadata: Record<string, unknown> }>(
      `SELECT action, entity_id, metadata FROM audit_log
       WHERE tenant_id = $1 AND action = 'recipient.import_reactivation_rejected'
       ORDER BY entity_id`,
      [tenantId],
    );
    expect(audits.rows).toEqual([
      { action: 'recipient.import_reactivation_rejected', entity_id: bounced.id, metadata: { reason: 'CONSENT_REQUIRED', sourceJob: job.id, existingStatus: 'bounced', importedStatus: 'active' } },
      { action: 'recipient.import_reactivation_rejected', entity_id: unsubscribed.id, metadata: { reason: 'CONSENT_REQUIRED', sourceJob: job.id, existingStatus: 'unsubscribed', importedStatus: 'active' } },
    ].sort((left, right) => left.entity_id.localeCompare(right.entity_id)));
    expect(events.map((event) => event.event_type)).toEqual(['import.progress', 'import.completed']);
    expect(events.at(-1)).toMatchObject({ aggregate_id: job.id, data: { status: 'partial_success', errorFileUrl: `/api/v1/import-jobs/${job.id}/error-file` } });
  }, 15_000);

  it('on restart reclaims only stale unfinished work and never mutates a terminal checkpoint', async () => {
    const staleEmail = `restart-stale-${randomUUID()}@test.dev`;
    const job = (await pool.query<{ id: string }>(
      `INSERT INTO import_job (tenant_id, file_name, mapping_json, total_rows)
       VALUES ($1, 'restart.csv', $2::jsonb, 2) RETURNING id`,
      [tenantId, JSON.stringify({ email: 'Email' })],
    )).rows[0];
    const insertedRows = await pool.query<{ row_number: number; claimed_at: Date; processed_at: Date | null }>(
      `INSERT INTO import_job_row (job_id, row_number, raw_data, status, claimed_at, processed_at, error, outcome) VALUES
       ($1, 2, $2::jsonb, 'processing', now() - interval '2 minutes', NULL, NULL, NULL),
       ($1, 3, $3::jsonb, 'failed', now() - interval '2 minutes', now() - interval '3 minutes', 'PREEXISTING_FAILURE', NULL)
       RETURNING row_number, claimed_at, processed_at`,
      [job.id, JSON.stringify({ Email: staleEmail }), JSON.stringify({ Email: 'terminal@example.test' })],
    );
    const terminalBeforeRestart = insertedRows.rows.find((row) => row.row_number === 3);
    expect(terminalBeforeRestart).toBeDefined();

    await processImportJob(testAppDatabaseUrl(), tenantId, job.id);

    const rows = await pool.query<{ row_number: number; status: string; error: string | null; outcome: string | null; claimed_at: Date | null; processed_at: Date | null }>(
      `SELECT row_number, status, error, outcome, claimed_at, processed_at
       FROM import_job_row WHERE job_id = $1 ORDER BY row_number`,
      [job.id],
    );
    expect(rows.rows[0]).toMatchObject({ row_number: 2, status: 'succeeded', error: null, outcome: 'created' });
    expect(rows.rows[0].processed_at).not.toBeNull();
    expect(rows.rows[1]).toEqual({
      row_number: 3,
      status: 'failed',
      error: 'PREEXISTING_FAILURE',
      outcome: null,
      claimed_at: terminalBeforeRestart!.claimed_at,
      processed_at: terminalBeforeRestart!.processed_at,
    });
    expect((await pool.query<{ status: string; processed_rows: number; succeeded_rows: number; failed_rows: number }>(
      'SELECT status, processed_rows, succeeded_rows, failed_rows FROM import_job WHERE id = $1', [job.id],
    )).rows[0]).toEqual({ status: 'partial_success', processed_rows: 2, succeeded_rows: 1, failed_rows: 1 });
  }, 15_000);

  it('reports created, updated, skipped, and failed import outcomes without duplicating a normalized email', async () => {
    const existingEmail = `outcome-existing-${randomUUID()}@test.dev`;
    const missingEmail = `outcome-missing-${randomUUID()}@test.dev`;
    await pool.query(
      `INSERT INTO recipient (tenant_id, email, first_name, custom_data)
       VALUES ($1, $2, 'Before update', '{}'::jsonb)`,
      [tenantId, existingEmail],
    );
    const job = (await pool.query<{ id: string }>(
      `INSERT INTO import_job (tenant_id, file_name, mapping_json, total_rows)
       VALUES ($1, 'outcomes.csv', $2::jsonb, 3) RETURNING id`,
      [tenantId, JSON.stringify({ email: 'Email', firstName: 'First name', lastName: 'Last name' })],
    )).rows[0];
    await pool.query(
      `INSERT INTO import_job_row (job_id, row_number, raw_data) VALUES
       ($1, 2, $2::jsonb), ($1, 3, $3::jsonb), ($1, 4, $4::jsonb)`,
      [
        job.id,
        JSON.stringify({ Email: `outcome-created-${randomUUID()}@test.dev`, 'First name': 'Created', 'Last name': 'Recipient' }),
        JSON.stringify({ Email: existingEmail, 'First name': 'Updated', 'Last name': 'Person' }),
        JSON.stringify({ Email: 'not-an-email' }),
      ],
    );
    await processImportJob(testAppDatabaseUrl(), tenantId, job.id);

    const createOnly = (await pool.query<{ id: string }>(
      `INSERT INTO import_job (tenant_id, file_name, mode, mapping_json, total_rows)
       VALUES ($1, 'create-only.csv', 'create_only', $2::jsonb, 1) RETURNING id`,
      [tenantId, JSON.stringify({ email: 'Email' })],
    )).rows[0];
    const updateOnly = (await pool.query<{ id: string }>(
      `INSERT INTO import_job (tenant_id, file_name, mode, mapping_json, total_rows)
       VALUES ($1, 'update-only.csv', 'update_existing', $2::jsonb, 1) RETURNING id`,
      [tenantId, JSON.stringify({ email: 'Email' })],
    )).rows[0];
    await pool.query(`INSERT INTO import_job_row (job_id, row_number, raw_data) VALUES ($1, 2, $2::jsonb), ($3, 2, $4::jsonb)`, [createOnly.id, JSON.stringify({ Email: existingEmail }), updateOnly.id, JSON.stringify({ Email: missingEmail })]);
    await processImportJob(testAppDatabaseUrl(), tenantId, createOnly.id);
    await processImportJob(testAppDatabaseUrl(), tenantId, updateOnly.id);

    expect((await pool.query<{ outcome: string | null; error: string | null }>(
      `SELECT outcome, error FROM import_job_row WHERE job_id = $1 ORDER BY row_number`, [job.id],
    )).rows).toEqual([
      { outcome: 'created', error: null }, { outcome: 'updated', error: null }, { outcome: null, error: 'INVALID_EMAIL' },
    ]);
    expect((await pool.query<{ status: string; error: string | null; outcome: string | null }>(
      `SELECT status, error, outcome FROM import_job_row WHERE job_id = $1`, [createOnly.id],
    )).rows[0]).toEqual({ status: 'skipped', error: 'ALREADY_EXISTS', outcome: 'skipped' });
    expect((await pool.query<{ status: string; error: string | null; outcome: string | null }>(
      `SELECT status, error, outcome FROM import_job_row WHERE job_id = $1`, [updateOnly.id],
    )).rows[0]).toEqual({ status: 'skipped', error: 'NOT_FOUND', outcome: 'skipped' });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM recipient WHERE tenant_id = $1 AND normalized_email = lower(trim($2))`, [tenantId, existingEmail],
    )).rows[0].count).toBe('1');
    expect((await pool.query<{ first_name: string; last_name: string }>(
      'SELECT first_name, last_name FROM recipient WHERE tenant_id = $1 AND normalized_email = lower(trim($2))', [tenantId, existingEmail],
    )).rows[0]).toEqual({ first_name: 'Updated', last_name: 'Person' });
  }, 15_000);

  it('maps configured list and tag source values to active tenant memberships and rejects unknown values per row', async () => {
    const knownList = `Import list ${randomUUID()}`;
    const knownTag = `Import tag ${randomUUID()}`;
    const [list] = (await pool.query<{ id: string }>(
      `INSERT INTO recipient_list (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [tenantId, knownList],
    )).rows;
    const [tag] = (await pool.query<{ id: string }>(
      `INSERT INTO tag (tenant_id, name, color) VALUES ($1, $2, '#7356c8') RETURNING id`,
      [tenantId, knownTag],
    )).rows;
    const job = (await pool.query<{ id: string }>(
      `INSERT INTO import_job (tenant_id, file_name, mapping_json, total_rows)
       VALUES ($1, 'segments.csv', $2::jsonb, 2) RETURNING id`,
      [tenantId, JSON.stringify({ email: 'Email', list: 'List', tag: 'Tag' })],
    )).rows[0];
    await pool.query(
      `INSERT INTO import_job_row (job_id, row_number, raw_data) VALUES
       ($1, 2, $2::jsonb), ($1, 3, $3::jsonb)`,
      [
        job.id,
        JSON.stringify({ Email: `segment-member-${randomUUID()}@test.dev`, List: knownList, Tag: knownTag }),
        JSON.stringify({ Email: `unknown-segment-${randomUUID()}@test.dev`, List: 'Unknown list', Tag: knownTag }),
      ],
    );

    await processImportJob(testAppDatabaseUrl(), tenantId, job.id);

    const rows = await pool.query<{ row_number: number; status: string; error: string | null; recipient_id: string | null }>(
      `SELECT row_number, status, error, recipient_id FROM import_job_row WHERE job_id = $1 ORDER BY row_number`,
      [job.id],
    );
    expect(rows.rows[0]).toMatchObject({ row_number: 2, status: 'succeeded', error: null });
    expect(rows.rows[1]).toMatchObject({ row_number: 3, status: 'failed', error: 'UNKNOWN_LIST' });
    expect((await pool.query(
      `SELECT 1 FROM recipient_list_member WHERE tenant_id = $1 AND list_id = $2 AND recipient_id = $3`,
      [tenantId, list.id, rows.rows[0].recipient_id],
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM recipient_tag WHERE tenant_id = $1 AND tag_id = $2 AND recipient_id = $3`,
      [tenantId, tag.id, rows.rows[0].recipient_id],
    )).rowCount).toBe(1);
  }, 15_000);
});
