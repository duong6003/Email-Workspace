import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { scanQueuedCampaigns } from './run.js';
import { readProgressFacts } from './progress-snapshot.js';
import type { ProgressEvent, ResyncEvent } from './progress-event.js';
import { purgeCampaignSendFixtures } from '../test-cleanup-helpers.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl, testRedisUrl } from '../test-urls.js';

/**
 * M5-S3 CP3/CP4: the periodic scan orchestrator, same shape as M5-S2's
 * campaign-dispatcher.ts (SS3.4/DEC-102) -- a cross-tenant sweep over the
 * narrow app connection re-entering a tenant transaction per campaign, not a
 * BullMQ job per DAG node. Runs validate, partition, then send in one pass;
 * aggregate (the terminal status transition) is added in CP6.
 */
describe('scanQueuedCampaigns (M5-S3 CP3/CP4: orchestrates validate+partition+send)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let templateVersionId: string;

  beforeAll(async () => {
    // Host-run tests need the loopback SMTP port mapping, not the
    // container-internal 'mailpit' hostname (send.integration.test.ts's
    // own comment explains this in full).
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1025';
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-run-${randomUUID()}`])).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `run-template-${randomUUID()}`],
    )).rows[0];
    templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('1', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
  });

  afterAll(async () => {
    await purgeCampaignSendFixtures(pool, tenantId, 'eow_campaign_send_run_test_cleanup');
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  it('scans a queued campaign end to end: validates, freezes, partitions, sends, and lands it in sending', async () => {
    const toEmail = `run-e2e-${randomUUID()}@example.test`;
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id, sender_json)
       VALUES ($1, $2, 'queued', $3, '{"fromEmail":"ops@example.test"}'::jsonb) RETURNING id`,
      [tenantId, `run-${randomUUID()}`, templateVersionId],
    )).rows[0];
    const recipient = (await pool.query<{ id: string }>(
      `INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`,
      [tenantId, toEmail],
    )).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{"fromEmail":"ops@example.test"}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, 0) RETURNING id`,
      [tenantId, campaign.id, templateVersionId],
    )).rows[0];
    await pool.query(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, email_snapshot, eligibility, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'sendable', 'pending')`,
      [tenantId, campaign.id, snapshot.id, recipient.id, JSON.stringify({ email: toEmail }), JSON.stringify({ subject: 'End to end', html: '<p>Hi</p>', textBody: 'Hi' })],
    );

    const results = await scanQueuedCampaigns(testAppDatabaseUrl(), testRedisUrl(), 100);

    expect(results.find((r) => r.campaignId === campaign.id)).toMatchObject({ campaignId: campaign.id, tenantId, outcome: 'completed' });
    const row = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaign.id])).rows[0];
    expect(row.status).toBe('completed');
    const recipientRow = (await pool.query<{ status: string }>('SELECT status FROM campaign_recipient WHERE campaign_id = $1', [campaign.id])).rows[0];
    expect(recipientRow.status).toBe('submitted');
    const res = await fetch(`http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`to:${toEmail}`)}`);
    const body = (await res.json()) as { messages: Array<{ Subject: string }> };
    expect(body.messages.some((m) => m.Subject === 'End to end')).toBe(true);
  });

  it('re-running the scan over an already-sending campaign is a safe no-op (nothing left to claim)', async () => {
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id, sender_json)
       VALUES ($1, $2, 'queued', $3, '{"fromEmail":"ops2@example.test"}'::jsonb) RETURNING id`,
      [tenantId, `run-rerun-${randomUUID()}`, templateVersionId],
    )).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json)
       VALUES ($1, $2, $3, '{"fromEmail":"ops2@example.test"}'::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [tenantId, campaign.id, templateVersionId],
    )).rows[0];
    void snapshot;

    const first = await scanQueuedCampaigns(testAppDatabaseUrl(), testRedisUrl(), 100);
    expect(first.find((r) => r.campaignId === campaign.id)?.outcome).toBe('completed_empty');

    const second = await scanQueuedCampaigns(testAppDatabaseUrl(), testRedisUrl(), 100);
    expect(second.find((r) => r.campaignId === campaign.id)).toBeUndefined();
  });

  it('M6-S1 CP6 (A7): the mandatory end-of-pass flush publishes even when the batch never crosses the throttle\'s own bounds, and it matches the post-pass facts', async () => {
    // A 2-recipient batch never reaches PROGRESS_THROTTLE_RECIPIENTS (250)
    // and completes in well under PROGRESS_THROTTLE_MS (1s) -- exactly the
    // case the mandatory flush exists for: without it, a batch this small
    // would complete having published nothing at all.
    const toEmailA = `run-flush-a-${randomUUID()}@example.test`;
    const toEmailB = `run-flush-b-${randomUUID()}@example.test`;
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id, sender_json)
       VALUES ($1, $2, 'queued', $3, '{"fromEmail":"ops-flush@example.test"}'::jsonb) RETURNING id`,
      [tenantId, `run-flush-${randomUUID()}`, templateVersionId],
    )).rows[0];
    const recipientA = (await pool.query<{ id: string }>(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [tenantId, toEmailA])).rows[0];
    const recipientB = (await pool.query<{ id: string }>(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [tenantId, toEmailB])).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{"fromEmail":"ops-flush@example.test"}'::jsonb, '{}'::jsonb, '{}'::jsonb, 2, 2, 0) RETURNING id`,
      [tenantId, campaign.id, templateVersionId],
    )).rows[0];
    for (const recipient of [recipientA, recipientB]) {
      await pool.query(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, email_snapshot, eligibility, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'sendable', 'pending')`,
        [tenantId, campaign.id, snapshot.id, recipient.id, JSON.stringify({ email: recipient === recipientA ? toEmailA : toEmailB }), JSON.stringify({ subject: 'Flush test', html: '<p>Hi</p>', textBody: 'Hi' })],
      );
    }

    const published: Array<ProgressEvent | ResyncEvent> = [];
    const capture = async (event: ProgressEvent | ResyncEvent): Promise<void> => { published.push(event); };

    const results = await scanQueuedCampaigns(testAppDatabaseUrl(), testRedisUrl(), 100, capture);

    expect(results.find((r) => r.campaignId === campaign.id)).toMatchObject({ campaignId: campaign.id, outcome: 'completed' });
    const thisCampaignEvents = published.filter((event) => event.aggregate_id === campaign.id) as ProgressEvent[];
    expect(thisCampaignEvents.length).toBeGreaterThanOrEqual(1);

    const [executionRow] = (await pool.query<{ id: string }>(`SELECT id FROM campaign_execution WHERE tenant_id = $1 AND campaign_id = $2`, [tenantId, campaign.id])).rows;
    const facts = await readProgressFacts(pool, tenantId, snapshot.id, executionRow.id);
    const last = thisCampaignEvents[thisCampaignEvents.length - 1];
    expect(last.data.counts).toEqual(facts.counts);
    expect(last.data.status).toBe('completed');
  });
});
