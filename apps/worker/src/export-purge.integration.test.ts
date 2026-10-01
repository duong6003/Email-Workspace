import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { purgeExpiredExportArtifacts } from './export-purge.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from './test-urls.js';

/** audit_log is immutable (BR-SEC-002, audit_log_immutable trigger) -- the
 *  same disable/delete/enable-under-advisory-lock shape as
 *  test-cleanup-helpers.ts's purgeCampaignSendFixtures, scoped to just the
 *  two tables this file's fixtures touch so campaignId can be reused across
 *  every `it` in this file instead of reseeded per test. */
async function purgeExportPurgeFixtures(pool: pg.Pool, tenantId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['eow_export_purge_test_cleanup']);
    await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
    await client.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM export_job WHERE tenant_id = $1', [tenantId]);
    await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * D-131 (found scoping BR-HIS-006 against export_job's own lifecycle, not
 * part of that rule): migration 029's export_job.expires_at already gates
 * *download*, but nothing ever cleared artifact_bytes once an export passed
 * its own expiry. Same cross-tenant sweep shape as every other scan on this
 * worker: an unlocked SELECT over expired_export_artifacts() decides which
 * rows to visit, then one tenant transaction per row clears artifact_bytes
 * and audits it. The row itself (status, filename, row_count, timestamps)
 * is kept -- only the bytea payload is cleared.
 */
describe('purgeExpiredExportArtifacts (D-131)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let createdBy: string;
  let campaignId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`export-purge-${randomUUID()}`])).rows[0].id;
    createdBy = (await pool.query<{ id: string }>(
      `INSERT INTO app_user (tenant_id, email, display_name, role, password_hash, status) VALUES ($1, $2, 'Export Purge Fixture Owner', 'operator', 'x', 'active') RETURNING id`,
      [tenantId, `export-purge-owner-${randomUUID()}@test.dev`],
    )).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `export-purge-template-${randomUUID()}`],
    )).rows[0];
    const templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('4', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
    campaignId = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'completed', $3) RETURNING id`,
      [tenantId, `export-purge-${randomUUID()}`, templateVersionId],
    )).rows[0].id;
  });

  afterEach(async () => {
    await purgeExportPurgeFixtures(pool, tenantId);
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['eow_export_purge_test_cleanup']);
      await client.query('ALTER TABLE email_template_version DISABLE TRIGGER email_template_version_immutable_trigger');
      await client.query('DELETE FROM campaign WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM email_template_version WHERE tenant_id = $1', [tenantId]);
      await client.query('ALTER TABLE email_template_version ENABLE TRIGGER email_template_version_immutable_trigger');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM app_user WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  async function completedExportJob(expiresAt: Date): Promise<string> {
    const row = (await pool.query<{ id: string }>(
      `INSERT INTO export_job (tenant_id, campaign_id, kind, status, row_count, artifact_bytes, artifact_filename, expires_at, created_by, completed_at)
       VALUES ($1, $2, 'campaign_recipients', 'completed', 3, $3, $4, $5, $6, now()) RETURNING id`,
      [tenantId, campaignId, Buffer.from('recipient_email\r\na@test.dev\r\n', 'utf8'), `export-${randomUUID()}.csv`, expiresAt, createdBy],
    )).rows[0];
    return row.id;
  }

  it('clears artifact_bytes for a completed job past its expiry, keeps the row', async () => {
    const jobId = await completedExportJob(new Date(Date.now() - 60_000));

    const results = await purgeExpiredExportArtifacts(testAppDatabaseUrl());

    expect(results).toEqual([{ tenantId, exportJobId: jobId }]);
    const [job] = (await pool.query<{ status: string; artifact_bytes: Buffer | null; artifact_filename: string | null; row_count: number }>(
      `SELECT status, artifact_bytes, artifact_filename, row_count FROM export_job WHERE id = $1`,
      [jobId],
    )).rows;
    expect(job.status).toBe('completed');
    expect(job.artifact_bytes).toBeNull();
    expect(job.artifact_filename).toBeTruthy();
    expect(job.row_count).toBe(3);
  });

  it('leaves an unexpired completed job untouched', async () => {
    const jobId = await completedExportJob(new Date(Date.now() + 60 * 60_000));

    const results = await purgeExpiredExportArtifacts(testAppDatabaseUrl());

    expect(results.find((row) => row.exportJobId === jobId)).toBeUndefined();
    const [job] = (await pool.query<{ artifact_bytes: Buffer | null }>(`SELECT artifact_bytes FROM export_job WHERE id = $1`, [jobId])).rows;
    expect(job.artifact_bytes).not.toBeNull();
  });

  it('writes exactly one audit row per cleared export', async () => {
    const jobId = await completedExportJob(new Date(Date.now() - 60_000));

    await purgeExpiredExportArtifacts(testAppDatabaseUrl());

    const audit = await pool.query(
      `SELECT actor_id, action, entity_type, entity_id FROM audit_log WHERE tenant_id = $1 AND action = 'history.export.purged'`,
      [tenantId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).toBeNull();
    expect(audit.rows[0].entity_type).toBe('export_job');
    expect(audit.rows[0].entity_id).toBe(jobId);
  });

  it('a second run is a no-op and writes no further audit row', async () => {
    const jobId = await completedExportJob(new Date(Date.now() - 60_000));

    await purgeExpiredExportArtifacts(testAppDatabaseUrl());
    const second = await purgeExpiredExportArtifacts(testAppDatabaseUrl());

    expect(second.find((row) => row.exportJobId === jobId)).toBeUndefined();
    const audit = await pool.query(
      `SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND action = 'history.export.purged'`,
      [tenantId],
    );
    expect(audit.rows[0].count).toBe(1);
  });
});
