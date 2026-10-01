import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { aggregateExecution } from './aggregate.js';
import { purgeCampaignSendFixtures } from '../test-cleanup-helpers.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../test-urls.js';

/**
 * M5-S3 CP6 (BR-SEND-001/002, A2/A18/A19): the 'aggregate' DAG node. Recomputes
 * counts by status, asserts they sum to total_snapshot, and applies the
 * terminal sending->{completed,partial_failed,failed} transition (SS3.3)
 * once every actionable recipient is terminal -- not before.
 */
describe('aggregateExecution (M5-S3 CP6: BR-SEND-001/002 aggregate)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let templateVersionId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-aggregate-${randomUUID()}`])).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `aggregate-template-${randomUUID()}`],
    )).rows[0];
    templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('3', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
  });

  afterAll(async () => {
    await purgeCampaignSendFixtures(pool, tenantId, 'eow_campaign_send_aggregate_test_cleanup');
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  async function fixture(recipientStatuses: Array<{ eligibility: 'sendable' | 'skipped'; status: string }>): Promise<{ campaignId: string; executionId: string }> {
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'sending', $3) RETURNING id`,
      [tenantId, `aggregate-${randomUUID()}`, templateVersionId],
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
      [tenantId, campaign.id, snapshot.id, `aggregate-${randomUUID()}`],
    )).rows[0];
    for (const row of recipientStatuses) {
      const recipient = (await pool.query<{ id: string }>(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [tenantId, `aggregate-${randomUUID()}@example.test`])).rows[0];
      await pool.query(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, eligibility, skipped_reason, status, execution_id)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7, $8)`,
        [tenantId, campaign.id, snapshot.id, recipient.id, row.eligibility, row.eligibility === 'skipped' ? 'status_bounced' : null, row.status, execution.id],
      );
    }
    return { campaignId: campaign.id, executionId: execution.id };
  }

  it('A2/A19: all submitted -> completed, and counts sum to total_snapshot', async () => {
    const { campaignId, executionId } = await fixture([
      { eligibility: 'sendable', status: 'submitted' },
      { eligibility: 'sendable', status: 'submitted' },
      { eligibility: 'skipped', status: 'skipped' },
    ]);

    const outcome = await aggregateExecution(testAppDatabaseUrl(), tenantId, campaignId, executionId);

    expect(outcome).toEqual({ result: 'completed' });
    const campaign = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(campaign.status).toBe('completed');
    const execution = (await pool.query<{ status: string; finished_at: Date | null }>('SELECT status, finished_at FROM campaign_execution WHERE id = $1', [executionId])).rows[0];
    expect(execution.status).toBe('completed');
    expect(execution.finished_at).not.toBeNull();
  });

  it('some failed, some submitted -> partial_failed', async () => {
    const { campaignId, executionId } = await fixture([
      { eligibility: 'sendable', status: 'submitted' },
      { eligibility: 'sendable', status: 'failed' },
    ]);

    const outcome = await aggregateExecution(testAppDatabaseUrl(), tenantId, campaignId, executionId);

    expect(outcome).toEqual({ result: 'partial_failed' });
    const campaign = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(campaign.status).toBe('partial_failed');
  });

  it('every actionable recipient failed -> failed', async () => {
    const { campaignId, executionId } = await fixture([
      { eligibility: 'sendable', status: 'failed' },
      { eligibility: 'sendable', status: 'failed' },
    ]);

    const outcome = await aggregateExecution(testAppDatabaseUrl(), tenantId, campaignId, executionId);

    expect(outcome).toEqual({ result: 'failed' });
    const campaign = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(campaign.status).toBe('failed');
  });

  it('A18: recipients still pending/queued -> not_done, campaign stays sending', async () => {
    const { campaignId, executionId } = await fixture([
      { eligibility: 'sendable', status: 'submitted' },
      { eligibility: 'sendable', status: 'queued' },
    ]);

    const outcome = await aggregateExecution(testAppDatabaseUrl(), tenantId, campaignId, executionId);

    expect(outcome).toEqual({ result: 'not_done' });
    const campaign = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(campaign.status).toBe('sending');
  });

  it('re-running aggregate on an already-terminal campaign is a safe no-op', async () => {
    const { campaignId, executionId } = await fixture([{ eligibility: 'sendable', status: 'submitted' }]);
    const first = await aggregateExecution(testAppDatabaseUrl(), tenantId, campaignId, executionId);
    expect(first).toEqual({ result: 'completed' });

    const second = await aggregateExecution(testAppDatabaseUrl(), tenantId, campaignId, executionId);

    expect(second).toEqual({ result: 'not_claimable' });
  });

  it('writes an audit_log row and a campaign.execution_state_changed outbox row on the terminal transition', async () => {
    const { campaignId, executionId } = await fixture([{ eligibility: 'sendable', status: 'submitted' }]);

    await aggregateExecution(testAppDatabaseUrl(), tenantId, campaignId, executionId);

    const audit = await pool.query('SELECT action FROM audit_log WHERE entity_id = $1 AND action = $2', [campaignId, 'campaign_send.completed']);
    expect(audit.rowCount).toBe(1);
    const outbox = await pool.query('SELECT event_type FROM outbox_event WHERE aggregate_id = $1', [campaignId]);
    expect(outbox.rows.map((r) => r.event_type)).toContain('campaign.execution_state_changed');
  });
});
