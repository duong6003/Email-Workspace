import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { CROSS_TENANT_SCAN_LIMIT } from './progress-reconcile.js';
import { purgeCampaignSendFixtures } from './test-cleanup-helpers.js';
import { testOwnerDatabaseUrl } from './test-urls.js';

/**
 * Regression for the 028 ORDER BY bug: reconcilable_campaign_executions()
 * ordered its bounded scan oldest-first, so once the system-wide candidate
 * set (status = 'sending' OR finished_at within 7 days) exceeds
 * CROSS_TENANT_SCAN_LIMIT, the LIMIT permanently keeps the OLDEST
 * executions and starves the NEWEST -- exactly backwards, since a freshly
 * started execution is the one most likely to still need reconciliation
 * soon. 031 fixed this to newest-first. Unlike A15/A17 in
 * progress-reconcile.integration.test.ts (which only failed *incidentally*
 * once the shared dev database happened to already sit at the 100-row
 * cap), this test manufactures the overflow itself so it fails
 * deterministically pre-fix and passes deterministically post-fix,
 * independent of ambient database state.
 */
describe('reconcilable_campaign_executions() scan order (regression for the 028 ORDER BY bug)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;

  afterAll(async () => {
    await purgeCampaignSendFixtures(pool, tenantId, 'eow_progress_reconcile_scan_order_test_cleanup');
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  it('keeps a freshly-started execution in a bounded scan even once older candidates exceed the limit', async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-scan-order-${randomUUID()}`])).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `scan-order-template-${randomUUID()}`],
    )).rows[0];
    const templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('6', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;

    async function insertReconcilableExecution(startedAt: Date): Promise<string> {
      const campaign = (await pool.query<{ id: string }>(
        `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'sending', $3) RETURNING id`,
        [tenantId, `scan-order-${randomUUID()}`, templateVersionId],
      )).rows[0];
      const snapshot = (await pool.query<{ id: string }>(
        `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
         VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, 0) RETURNING id`,
        [tenantId, campaign.id, templateVersionId],
      )).rows[0];
      const execution = (await pool.query<{ id: string }>(
        `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status, started_at)
         VALUES ($1, $2, $3, $4, 'sending', $5) RETURNING id`,
        [tenantId, campaign.id, snapshot.id, `scan-order-${randomUUID()}`, startedAt],
      )).rows[0];
      return execution.id;
    }

    // Filler candidates, all older than any ambient row could plausibly be,
    // so the fresh execution below is guaranteed to be the newest
    // system-wide -- the pre-fix ASC scan is guaranteed to exclude it.
    const fillerCount = CROSS_TENANT_SCAN_LIMIT + 5;
    const epoch = new Date('1971-01-01T00:00:00.000Z').getTime();
    for (let i = 0; i < fillerCount; i += 1) {
      await insertReconcilableExecution(new Date(epoch + i * 1000));
    }

    const freshExecutionId = await insertReconcilableExecution(new Date());

    const scanned = await pool.query<{ id: string }>(
      `SELECT id FROM reconcilable_campaign_executions($1)`,
      [CROSS_TENANT_SCAN_LIMIT],
    );

    expect(scanned.rows.map((r) => r.id)).toContain(freshExecutionId);
  });
});
