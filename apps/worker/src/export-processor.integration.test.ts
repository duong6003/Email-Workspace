import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { processExportJob } from './export-processor.js';
import { purgeCampaignSendFixtures } from './test-cleanup-helpers.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from './test-urls.js';

/**
 * M6-S3 CP8 (BR-HIS-003). The worker's own background-export path, picked
 * up via queued_export_jobs() once a creation request exceeded
 * EXPORT_INLINE_MAX_ROWS. Includes the D-121 guard class from its own
 * first line: a job whose row vanished between the scan and this
 * transaction opening is a safe no-op, not a crash -- every other
 * cross-tenant scan in this codebase already has this guard.
 */
describe('processExportJob (M6-S3 CP8)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let templateVersionId: string;
  let createdBy: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-export-${randomUUID()}`])).rows[0].id;
    createdBy = (await pool.query<{ id: string }>(
      `INSERT INTO app_user (tenant_id, email, display_name, role, password_hash, status) VALUES ($1, $2, 'Export Fixture Owner', 'operator', 'x', 'active') RETURNING id`,
      [tenantId, `export-owner-${randomUUID()}@test.dev`],
    )).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `export-template-${randomUUID()}`],
    )).rows[0];
    templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('4', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM export_job WHERE tenant_id = $1', [tenantId]);
    await purgeCampaignSendFixtures(pool, tenantId, 'eow_export_processor_test_cleanup');
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM app_user WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  async function fixture(recipientCount: number): Promise<{ campaignId: string; exportJobId: string }> {
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'completed', $3) RETURNING id`,
      [tenantId, `export-${randomUUID()}`, templateVersionId],
    )).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, $4, 0) RETURNING id`,
      [tenantId, campaign.id, templateVersionId, recipientCount],
    )).rows[0];
    const execution = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
      [tenantId, campaign.id, snapshot.id, `export-${randomUUID()}`],
    )).rows[0];
    for (let i = 0; i < recipientCount; i += 1) {
      const recipient = (await pool.query<{ id: string }>(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [tenantId, `export-worker-${i}-${randomUUID()}@example.test`])).rows[0];
      await pool.query(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, email_snapshot, eligibility, status)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, 'sendable', 'delivered')`,
        [tenantId, campaign.id, snapshot.id, recipient.id],
      );
    }
    const exportJob = (await pool.query<{ id: string }>(
      `INSERT INTO export_job (tenant_id, campaign_id, execution_id, kind, status, status_filter, row_count, created_by)
       VALUES ($1, $2, $3, 'campaign_recipients', 'queued', '{}', $4, $5) RETURNING id`,
      [tenantId, campaign.id, execution.id, recipientCount, createdBy],
    )).rows[0];
    return { campaignId: campaign.id, exportJobId: exportJob.id };
  }

  it('renders the artifact and marks the job completed with a real row_count and expiry', async () => {
    const { exportJobId } = await fixture(3);
    const published: Array<Record<string, unknown>> = [];

    await processExportJob(testAppDatabaseUrl(), tenantId, exportJobId, async (event) => { published.push(event); });

    const [job] = (await pool.query<{ status: string; artifact_bytes: Buffer | null; artifact_filename: string | null; expires_at: Date | null }>(
      `SELECT status, artifact_bytes, artifact_filename, expires_at FROM export_job WHERE id = $1`,
      [exportJobId],
    )).rows;
    expect(job.status).toBe('completed');
    expect(job.artifact_bytes).not.toBeNull();
    expect(job.artifact_bytes!.toString('utf8').split('\r\n').filter(Boolean)).toHaveLength(4);
    expect(job.artifact_filename).toBeTruthy();
    expect(job.expires_at).not.toBeNull();

    expect(published).toHaveLength(1);
    expect(published[0]!.event_type).toBe('export.completed');
    expect(published[0]!.aggregate_id).toBe(exportJobId);
  });

  it('D-121 guard: a job that vanished between scan and transaction is a safe no-op, not a crash', async () => {
    await expect(processExportJob(testAppDatabaseUrl(), tenantId, randomUUID(), async () => {})).resolves.toBeUndefined();
  });

  it('a job with no live snapshot ends failed with a failure_code, not a crash', async () => {
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'completed', $3) RETURNING id`,
      [tenantId, `export-no-snapshot-${randomUUID()}`, templateVersionId],
    )).rows[0];
    const exportJob = (await pool.query<{ id: string }>(
      `INSERT INTO export_job (tenant_id, campaign_id, kind, status, status_filter, row_count, created_by)
       VALUES ($1, $2, 'campaign_recipients', 'queued', '{}', 0, $3) RETURNING id`,
      [tenantId, campaign.id, createdBy],
    )).rows[0];

    await processExportJob(testAppDatabaseUrl(), tenantId, exportJob.id);

    const [job] = (await pool.query<{ status: string; failure_code: string | null }>(`SELECT status, failure_code FROM export_job WHERE id = $1`, [exportJob.id])).rows;
    expect(job.status).toBe('failed');
    expect(job.failure_code).toBe('NO_LIVE_SNAPSHOT');
  });
});
