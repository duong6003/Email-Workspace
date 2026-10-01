import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { scanDueCampaigns } from './campaign-dispatcher.js';
import { purgeCampaignSendFixtures } from './test-cleanup-helpers.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from './test-urls.js';

const MISFIRE_GRACE_SECONDS = 900;

describe('campaign dispatcher (real PostgreSQL, M5-S2 CP4: BR-SCH-006/007/009)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let templateVersionId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-dispatch-${randomUUID()}`])).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `dispatch-template-${randomUUID()}`],
    )).rows[0];
    templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('d', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
  });

  async function purgeTenantFixtures(id: string): Promise<void> {
    // A campaign-send-scan test running concurrently in this same process can
    // genuinely freeze one of this test's own campaigns the instant it
    // reaches 'queued' (exactly the overlap a real worker/scheduler would
    // also produce) -- purgeCampaignSendFixtures clears campaign_execution/
    // message_attempt first and runs the whole disable/delete/enable
    // sequence as one real transaction on one connection (M5-S3 CP3/CP4).
    await purgeCampaignSendFixtures(pool, id, 'eow_campaign_dispatcher_test_cleanup');
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [id]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
  }

  afterAll(async () => {
    await pool.query('DELETE FROM sender_config WHERE tenant_id = $1', [tenantId]);
    await purgeTenantFixtures(tenantId);
    await pool.end();
  });

  async function insertScheduledCampaign(opts: { dueSecondsAgo: number; senderConfigId?: string | null }) {
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, scheduled_at_utc, scheduled_timezone, template_version_id, sender_json)
       VALUES ($1, $2, 'scheduled', now() - ($3::double precision * interval '1 second'), 'UTC', $4, $5::jsonb) RETURNING id`,
      [tenantId, `dispatch-${randomUUID()}`, opts.dueSecondsAgo, templateVersionId, JSON.stringify({ senderConfigId: opts.senderConfigId ?? null, fromEmail: 'ops@example.test' })],
    )).rows[0];
    await pool.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, 0)`,
      [tenantId, campaign.id, templateVersionId, JSON.stringify({ senderConfigId: opts.senderConfigId ?? null, fromEmail: 'ops@example.test' })],
    );
    return campaign.id as string;
  }

  it('A12: a campaign due within the misfire grace dispatches to queued and records a nonnegative delay', async () => {
    const campaignId = await insertScheduledCampaign({ dueSecondsAgo: 30 });

    const results = await scanDueCampaigns(testAppDatabaseUrl(), MISFIRE_GRACE_SECONDS);

    const mine = results.find((r) => r.campaignId === campaignId);
    expect(mine?.outcome).toBe('dispatched');
    const row = (await pool.query<{ status: string; delay_seconds: number; actual_started_at: Date }>(
      'SELECT status, delay_seconds, actual_started_at FROM campaign WHERE id = $1', [campaignId],
    )).rows[0];
    expect(row.status).toBe('queued');
    expect(row.delay_seconds).toBeGreaterThanOrEqual(29);
    expect(row.actual_started_at).not.toBeNull();
    const audit = await pool.query('SELECT action FROM audit_log WHERE entity_id = $1 AND action = $2', [campaignId, 'schedule.dispatched']);
    expect(audit.rowCount).toBe(1);
    const outbox = await pool.query('SELECT event_type FROM outbox_event WHERE aggregate_id = $1', [campaignId]);
    expect(outbox.rows.map((r) => r.event_type)).toContain('schedule.state_changed');
  });

  it('A13: a campaign past the misfire grace transitions to missed and clears the schedule', async () => {
    const campaignId = await insertScheduledCampaign({ dueSecondsAgo: MISFIRE_GRACE_SECONDS + 60 });

    const results = await scanDueCampaigns(testAppDatabaseUrl(), MISFIRE_GRACE_SECONDS);

    expect(results.find((r) => r.campaignId === campaignId)?.outcome).toBe('missed');
    const row = (await pool.query<{ status: string; scheduled_at_utc: Date | null; scheduled_timezone: string | null }>(
      'SELECT status, scheduled_at_utc, scheduled_timezone FROM campaign WHERE id = $1', [campaignId],
    )).rows[0];
    expect(row.status).toBe('missed');
    expect(row.scheduled_at_utc).toBeNull();
    expect(row.scheduled_timezone).toBeNull();
  });

  it('A15: a campaign whose sender config is disabled transitions to blocked, never substitutes a sender, and leaves sender_json unchanged', async () => {
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, 'Dispatch sender', 'blocked@example.test', 'smtp.example.test', 587, 'user', 'EOW_SENDER_SECRET_DISPATCH_TEST', 'disabled') RETURNING id`,
      [tenantId],
    )).rows[0];
    const campaignId = await insertScheduledCampaign({ dueSecondsAgo: 30, senderConfigId: sender.id });

    const results = await scanDueCampaigns(testAppDatabaseUrl(), MISFIRE_GRACE_SECONDS);

    expect(results.find((r) => r.campaignId === campaignId)?.outcome).toBe('blocked');
    const row = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(row.status).toBe('blocked');
    const snapshotRow = (await pool.query<{ sender_json: { senderConfigId: string } }>(
      'SELECT sender_json FROM campaign_snapshot WHERE campaign_id = $1 AND superseded_at IS NULL', [campaignId],
    )).rows[0];
    expect(snapshotRow.sender_json.senderConfigId).toBe(sender.id);
  });

  it('A10/A11: two genuinely concurrent scans claim a due campaign exactly once, and a third re-run is a no-op', async () => {
    const campaignId = await insertScheduledCampaign({ dueSecondsAgo: 30 });

    const [first, second] = await Promise.all([
      scanDueCampaigns(testAppDatabaseUrl(), MISFIRE_GRACE_SECONDS),
      scanDueCampaigns(testAppDatabaseUrl(), MISFIRE_GRACE_SECONDS),
    ]);
    const claims = [...first, ...second].filter((r) => r.campaignId === campaignId);
    expect(claims).toHaveLength(1);
    expect(claims[0].outcome).toBe('dispatched');

    const rerun = await scanDueCampaigns(testAppDatabaseUrl(), MISFIRE_GRACE_SECONDS);
    expect(rerun.find((r) => r.campaignId === campaignId)).toBeUndefined();

    const audit = await pool.query('SELECT count(*)::int AS count FROM audit_log WHERE entity_id = $1 AND action = $2', [campaignId, 'schedule.dispatched']);
    expect(audit.rows[0].count).toBe(1);
  });

  it('the cross-tenant scan correctly dispatches a second tenant\'s own due campaign in the same sweep (runInTenantTransaction reuse, R3)', async () => {
    const otherTenant = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-dispatch-other-${randomUUID()}`])).rows[0];
    const otherTemplate = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [otherTenant.id, `dispatch-template-other-${randomUUID()}`],
    )).rows[0];
    const otherVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('e', 64), now()) RETURNING id`,
      [otherTenant.id, otherTemplate.id],
    )).rows[0].id;
    const otherCampaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, scheduled_at_utc, scheduled_timezone, template_version_id, sender_json)
       VALUES ($1, $2, 'scheduled', now() - interval '30 seconds', 'UTC', $3, '{"fromEmail":"ops@example.test"}'::jsonb) RETURNING id`,
      [otherTenant.id, `dispatch-other-${randomUUID()}`, otherVersionId],
    )).rows[0];
    await pool.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{"fromEmail":"ops@example.test"}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, 0)`,
      [otherTenant.id, otherCampaign.id, otherVersionId],
    );

    const results = await scanDueCampaigns(testAppDatabaseUrl(), MISFIRE_GRACE_SECONDS);

    expect(results.find((r) => r.campaignId === otherCampaign.id)?.outcome).toBe('dispatched');
    const row = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [otherCampaign.id])).rows[0];
    expect(row.status).toBe('queued');

    await purgeTenantFixtures(otherTenant.id);
  });
});
