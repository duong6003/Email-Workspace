import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { partitionBatch } from './partition.js';
import { purgeCampaignSendFixtures } from '../test-cleanup-helpers.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../test-urls.js';

/**
 * M5-S3 CP3 (BR-SEND-002, A6/A16): the 'partition' DAG node. Claims sendable
 * pending recipients into 'queued' for one execution; re-running it must
 * claim zero additional rows (A6), proven by running it twice and comparing
 * row counts, not by trusting the first result.
 */
describe('partitionBatch (M5-S3 CP3: BR-SEND-002 partition, A6/A16)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let templateVersionId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-partition-${randomUUID()}`])).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `partition-template-${randomUUID()}`],
    )).rows[0];
    templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('f', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
  });

  async function purgeTenantFixtures(id: string): Promise<void> {
    await purgeCampaignSendFixtures(pool, id, 'eow_campaign_send_partition_test_cleanup');
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [id]);
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [id]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
  }

  afterAll(async () => {
    await purgeTenantFixtures(tenantId);
    await pool.end();
  });

  async function fixture(recipientRows: Array<{ eligibility: 'sendable' | 'skipped'; status?: string }>): Promise<{ campaignId: string; executionId: string }> {
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'validating', $3) RETURNING id`,
      [tenantId, `partition-${randomUUID()}`, templateVersionId],
    )).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [tenantId, campaign.id, templateVersionId],
    )).rows[0];
    const execution = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, campaign.id, snapshot.id, `partition-${randomUUID()}`],
    )).rows[0];
    for (const row of recipientRows) {
      const recipient = (await pool.query<{ id: string }>(
        `INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`,
        [tenantId, `partition-${randomUUID()}@example.test`],
      )).rows[0];
      await pool.query(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, eligibility, skipped_reason, status)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7)`,
        [tenantId, campaign.id, snapshot.id, recipient.id, row.eligibility, row.eligibility === 'skipped' ? 'status_bounced' : null, row.status ?? (row.eligibility === 'skipped' ? 'skipped' : 'pending')],
      );
    }
    return { campaignId: campaign.id as string, executionId: execution.id as string };
  }

  it('A6: claims every sendable pending recipient into queued, and campaign moves validating->sending', async () => {
    const { campaignId, executionId } = await fixture([{ eligibility: 'sendable' }, { eligibility: 'sendable' }, { eligibility: 'skipped' }]);

    const outcome = await partitionBatch(testAppDatabaseUrl(), tenantId, campaignId, executionId, 100);

    expect(outcome).toEqual({ result: 'partitioned', claimedCount: 2 });
    const rows = await pool.query<{ status: string; eligibility: string; execution_id: string | null }>(
      'SELECT status, eligibility, execution_id FROM campaign_recipient WHERE campaign_id = $1 ORDER BY eligibility', [campaignId],
    );
    const sendableRows = rows.rows.filter((r) => r.eligibility === 'sendable');
    const skippedRows = rows.rows.filter((r) => r.eligibility === 'skipped');
    expect(sendableRows.every((r) => r.status === 'queued' && r.execution_id === executionId)).toBe(true);
    expect(skippedRows.every((r) => r.status === 'skipped')).toBe(true);
    const campaign = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(campaign.status).toBe('sending');
  });

  it('A6: re-running the claim once every sendable row is already claimed reports drained, claiming zero additional rows', async () => {
    const { campaignId, executionId } = await fixture([{ eligibility: 'sendable' }, { eligibility: 'sendable' }]);
    const first = await partitionBatch(testAppDatabaseUrl(), tenantId, campaignId, executionId, 100);
    expect(first).toEqual({ result: 'partitioned', claimedCount: 2 });

    const second = await partitionBatch(testAppDatabaseUrl(), tenantId, campaignId, executionId, 100);

    expect(second).toEqual({ result: 'drained' });
  });

  it('a campaign not in validating or sending is not claimable (e.g. already completed)', async () => {
    const { campaignId, executionId } = await fixture([{ eligibility: 'sendable' }]);
    await pool.query(`UPDATE campaign SET status = 'completed' WHERE id = $1`, [campaignId]);

    const outcome = await partitionBatch(testAppDatabaseUrl(), tenantId, campaignId, executionId, 100);

    expect(outcome).toEqual({ result: 'not_claimable' });
    const row = await pool.query('SELECT status FROM campaign_recipient WHERE campaign_id = $1', [campaignId]);
    expect(row.rows[0].status).toBe('pending');
  });

  it('a second batch after the first is exhausted (batchSize smaller than total sendable) claims the remainder while already sending', async () => {
    const { campaignId, executionId } = await fixture([{ eligibility: 'sendable' }, { eligibility: 'sendable' }, { eligibility: 'sendable' }]);
    const first = await partitionBatch(testAppDatabaseUrl(), tenantId, campaignId, executionId, 2);
    expect(first).toEqual({ result: 'partitioned', claimedCount: 2 });
    const campaignAfterFirst = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(campaignAfterFirst.status).toBe('sending');

    const second = await partitionBatch(testAppDatabaseUrl(), tenantId, campaignId, executionId, 2);

    expect(second).toEqual({ result: 'partitioned', claimedCount: 1 });
  });

  it('zero sendable recipients (all skipped) completes the campaign directly instead of entering sending', async () => {
    const { campaignId, executionId } = await fixture([{ eligibility: 'skipped' }, { eligibility: 'skipped' }]);

    const outcome = await partitionBatch(testAppDatabaseUrl(), tenantId, campaignId, executionId, 100);

    expect(outcome).toEqual({ result: 'completed_empty' });
    const campaign = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(campaign.status).toBe('completed');
  });

  it('A16: two genuinely concurrent partition calls on the same execution claim disjoint rows, never the same one twice', async () => {
    const { campaignId, executionId } = await fixture(
      Array.from({ length: 20 }, () => ({ eligibility: 'sendable' as const })),
    );

    const [a, b] = await Promise.all([
      partitionBatch(testAppDatabaseUrl(), tenantId, campaignId, executionId, 10),
      partitionBatch(testAppDatabaseUrl(), tenantId, campaignId, executionId, 10),
    ]);

    const claimedTotal = (a.result === 'partitioned' ? a.claimedCount : 0) + (b.result === 'partitioned' ? b.claimedCount : 0);
    expect(claimedTotal).toBe(20);
    const stillPending = await pool.query('SELECT count(*) FROM campaign_recipient WHERE campaign_id = $1 AND status = $2', [campaignId, 'pending']);
    expect(Number(stillPending.rows[0].count)).toBe(0);
  });
});
