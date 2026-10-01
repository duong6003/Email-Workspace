import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sendClaimedBatch, type SmtpSendFn } from './send.js';
import { publishProgressSnapshot } from './progress-snapshot.js';
import type { ProgressEvent, ResyncEvent } from './progress-event.js';
import { purgeCampaignSendFixtures } from '../test-cleanup-helpers.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl, testRedisUrl } from '../test-urls.js';

/**
 * M6-S3 CP5 (BR-SEND-009, D-123, ADR-027). The scheduler's own tick
 * (60s default) cannot meet the 10-second bound, so pause is enforced
 * inside sendClaimedBatch's own per-row loop via a bounded status
 * re-check. Asserted on submission COUNT, never on elapsed wall-clock time
 * (R5) -- a fake `now()` clock (the same parameter sendClaimedBatch already
 * accepts for its own throttle gate) is jumped forward by the stubbed
 * sendFn itself, so the test is deterministic under real host contention.
 */
describe('sendClaimedBatch pause enforcement (M6-S3 CP5)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let templateVersionId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-pause-${randomUUID()}`])).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `pause-template-${randomUUID()}`],
    )).rows[0];
    templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('3', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
  });

  afterAll(async () => {
    await purgeCampaignSendFixtures(pool, tenantId, 'eow_campaign_send_pause_test_cleanup');
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  async function fixture(recipientCount: number): Promise<{ campaignId: string; executionId: string; recipientIds: string[] }> {
    const senderJson = { fromEmail: 'ops@example.test', fromName: 'Ops' };
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id, sender_json) VALUES ($1, $2, 'completed', $3, $4::jsonb) RETURNING id`,
      [tenantId, `pause-${randomUUID()}`, templateVersionId, JSON.stringify(senderJson)],
    )).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json)
       VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [tenantId, campaign.id, templateVersionId, JSON.stringify(senderJson)],
    )).rows[0];
    const execution = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status)
       VALUES ($1, $2, $3, $4, 'sending') RETURNING id`,
      [tenantId, campaign.id, snapshot.id, `pause-${randomUUID()}`],
    )).rows[0];

    const recipientIds: string[] = [];
    for (let i = 0; i < recipientCount; i += 1) {
      const toEmail = `pause-${i}-${randomUUID()}@example.test`;
      const recipient = (await pool.query<{ id: string }>(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [tenantId, toEmail])).rows[0];
      const campaignRecipient = (await pool.query<{ id: string }>(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, email_snapshot, eligibility, status, execution_id, batch_no)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'sendable', 'queued', $7, 1) RETURNING id`,
        [tenantId, campaign.id, snapshot.id, recipient.id, JSON.stringify({ email: toEmail }), JSON.stringify({ subject: 'Pause test', html: '<p>Hi</p>', textBody: 'Hi' }), execution.id],
      )).rows[0];
      recipientIds.push(campaignRecipient.id);
    }
    return { campaignId: campaign.id, executionId: execution.id, recipientIds };
  }

  it('stops submitting within the bounded re-check window once campaign.status becomes paused, and releases unsent claims', async () => {
    const { campaignId, executionId, recipientIds } = await fixture(40);
    let sendCalls = 0;
    let clockMs = Date.now();
    const now = () => clockMs;
    const sendFn: SmtpSendFn = async () => {
      sendCalls += 1;
      if (sendCalls === 5) {
        await pool.query(`UPDATE campaign SET status = 'paused' WHERE id = $1`, [campaignId]);
        clockMs += 3_000;
      }
      return { providerMessageId: `pause-test-${randomUUID()}` };
    };

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 40, sendFn, null, now);

    expect(outcome.submitted).toBeLessThanOrEqual(6);
    expect(outcome.submitted).toBeGreaterThan(0);

    const attempts = (await pool.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM message_attempt WHERE tenant_id = $1 AND execution_id = $2`,
      [tenantId, executionId],
    )).rows[0];
    expect(Number(attempts.count)).toBeLessThanOrEqual(6);

    const unsent = (await pool.query<{ id: string; claimed_at: Date | null; status: string }>(
      `SELECT id, claimed_at, status FROM campaign_recipient WHERE id = ANY($1::uuid[]) AND status = 'queued'`,
      [recipientIds],
    )).rows;
    expect(unsent.length).toBeGreaterThan(0);
    for (const row of unsent) expect(row.claimed_at).toBeNull();

    const submittedRows = (await pool.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM campaign_recipient WHERE id = ANY($1::uuid[]) AND status = 'submitted'`,
      [recipientIds],
    )).rows[0];
    expect(Number(submittedRows.count)).toBe(outcome.submitted);
  });

  it('PAUSE_CHECK_INTERVAL_MS is 2000ms -- one in-flight message plus this bound stays comfortably inside BR-SEND-009s 10 seconds', async () => {
    const { PAUSE_CHECK_INTERVAL_MS } = await import('./send.js');
    expect(PAUSE_CHECK_INTERVAL_MS).toBe(2_000);
  });

  it('a flush after pause commits publishes an envelope whose status is paused, not a stale sending', async () => {
    const { campaignId, executionId } = await fixture(3);
    await pool.query(`UPDATE campaign SET status = 'paused' WHERE id = $1`, [campaignId]);
    await pool.query(`UPDATE campaign_execution SET status = 'paused' WHERE id = $1`, [executionId]);

    const captured: Array<ProgressEvent | ResyncEvent> = [];
    await publishProgressSnapshot(pool, tenantId, campaignId, executionId, async (event) => { captured.push(event); });

    expect(captured).toHaveLength(1);
    const event = captured[0]!;
    expect(event.event_type).toBe('campaign.progress');
    expect((event as ProgressEvent).data.status).toBe('paused');
  });
});
