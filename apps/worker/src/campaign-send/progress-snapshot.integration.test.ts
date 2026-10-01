import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readProgressFacts, writeProgressSnapshot } from './progress-snapshot.js';
import { purgeCampaignSendFixtures } from '../test-cleanup-helpers.js';
import { testOwnerDatabaseUrl } from '../test-urls.js';

/**
 * M6-S1 CP5 (BR-SEND-003, BR-HIS-008): readProgressFacts() recomputes the
 * per-status partition and the ETA sample window straight from
 * campaign_recipient/message_attempt; writeProgressSnapshot() persists that
 * partition to campaign_execution and bumps progress_seq by exactly one per
 * call, inside the same UPDATE (D-116) -- never a client-supplied value.
 */
describe('progress-snapshot (M6-S1 CP5: readProgressFacts/writeProgressSnapshot)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let templateVersionId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-progress-snapshot-${randomUUID()}`])).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `progress-snapshot-template-${randomUUID()}`],
    )).rows[0];
    templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('4', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
  });

  afterAll(async () => {
    await purgeCampaignSendFixtures(pool, tenantId, 'eow_progress_snapshot_test_cleanup');
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  async function fixture(recipientStatuses: Array<{ eligibility: 'sendable' | 'skipped'; status: string }>): Promise<{ campaignId: string; executionId: string; snapshotId: string }> {
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'sending', $3) RETURNING id`,
      [tenantId, `progress-snapshot-${randomUUID()}`, templateVersionId],
    )).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, $5, $6) RETURNING id`,
      [tenantId, campaign.id, templateVersionId, recipientStatuses.length,
        recipientStatuses.filter((r) => r.eligibility === 'sendable').length,
        recipientStatuses.filter((r) => r.eligibility === 'skipped').length],
    )).rows[0];
    const execution = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status) VALUES ($1, $2, $3, $4, 'sending') RETURNING id`,
      [tenantId, campaign.id, snapshot.id, `progress-snapshot-${randomUUID()}`],
    )).rows[0];
    for (const row of recipientStatuses) {
      const recipient = (await pool.query<{ id: string }>(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [tenantId, `progress-snapshot-${randomUUID()}@example.test`])).rows[0];
      await pool.query(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, eligibility, skipped_reason, status, execution_id)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7, $8)`,
        [tenantId, campaign.id, snapshot.id, recipient.id, row.eligibility, row.eligibility === 'skipped' ? 'status_bounced' : null, row.status, execution.id],
      );
    }
    return { campaignId: campaign.id, executionId: execution.id, snapshotId: snapshot.id };
  }

  it('readProgressFacts: per-status counts sum to total_snapshot and actionable excludes skipped', async () => {
    const { executionId, snapshotId } = await fixture([
      { eligibility: 'sendable', status: 'submitted' },
      { eligibility: 'sendable', status: 'delivered' },
      { eligibility: 'sendable', status: 'pending' },
      { eligibility: 'skipped', status: 'skipped' },
    ]);
    const facts = await readProgressFacts(pool, tenantId, snapshotId, executionId);
    const sum = Object.values(facts.counts).reduce((total, count) => total + count, 0);
    expect(sum).toBe(4);
    expect(facts.actionable).toBe(3);
    expect(facts.counts.submitted).toBe(1);
    expect(facts.counts.delivered).toBe(1);
    expect(facts.counts.pending).toBe(1);
    expect(facts.counts.skipped).toBe(1);
  });

  it('readProgressFacts: sample window only counts submitted attempts', async () => {
    const { executionId, snapshotId, campaignId } = await fixture([{ eligibility: 'sendable', status: 'submitted' }]);
    const [recipientRow] = (await pool.query<{ id: string }>(
      `SELECT id FROM campaign_recipient WHERE tenant_id = $1 AND campaign_id = $2 LIMIT 1`,
      [tenantId, campaignId],
    )).rows;
    await pool.query(
      `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, content_hash)
       VALUES ($1, $2, $3, 1, 'submitted', repeat('a', 64)), ($1, $2, $3, 2, 'transient_error', repeat('a', 64))`,
      [tenantId, executionId, recipientRow.id],
    );
    const facts = await readProgressFacts(pool, tenantId, snapshotId, executionId);
    expect(facts.etaSampleCount).toBe(1);
  });

  it('writeProgressSnapshot: bumps progress_seq by exactly one per call and stores the given counts', async () => {
    const { executionId, snapshotId } = await fixture([
      { eligibility: 'sendable', status: 'submitted' },
      { eligibility: 'sendable', status: 'delivered' },
    ]);
    const facts = await readProgressFacts(pool, tenantId, snapshotId, executionId);

    const firstSeq = await writeProgressSnapshot(pool, tenantId, executionId, facts.counts);
    expect(firstSeq).toBe(1);
    const secondSeq = await writeProgressSnapshot(pool, tenantId, executionId, facts.counts);
    expect(secondSeq).toBe(2);

    const [row] = (await pool.query<{ submitted_count: number; delivered_count: number }>(
      `SELECT submitted_count, delivered_count FROM campaign_execution WHERE id = $1`,
      [executionId],
    )).rows;
    expect(row.submitted_count).toBe(1);
    expect(row.delivered_count).toBe(1);
  });
});
