import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { purgeHistoryEvents } from './history-purge.js';
import { purgeCampaignSendFixtures } from './test-cleanup-helpers.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from './test-urls.js';

/**
 * M6-S4 CP5 (BR-HIS-006). The purge orchestrator: an unlocked scan over
 * purgeable_retention_tenants() decides which tenants to visit, then one
 * tenant transaction per tenant deletes past-cutoff message_attempt/
 * delivery_event rows through purge_message_events() and audits it.
 *
 * Three tenants, chosen so every assertion is decided by policy rather than
 * by row age (plan CP5): a 30-day policy and a 3650-day policy both get
 * 5-year-old rows (opposite outcomes, policy the only difference), and a
 * tenant with no policy row gets 400-day-old rows (purged under the
 * 365-day deployment default). The 5-year age also sorts these fixtures to
 * the head of purgeable_retention_tenants()'s oldest-first scan on this
 * shared, many-sessions-accumulated dev database (D-127's own root cause),
 * so the test cannot be starved by unrelated data.
 */
describe('purgeHistoryEvents (M6-S4 CP5)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  const now = new Date();
  const FIVE_YEARS = new Date(now.getTime() - 5 * 365 * DAY_MS);
  const PAST_DEFAULT = new Date(now.getTime() - 400 * DAY_MS);

  async function seedTenant(label: string, retentionDays: number | null, eventAt: Date): Promise<{ tenantId: string; executionId: string }> {
    const tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`${label}-${randomUUID()}`])).rows[0].id;
    if (retentionDays !== null) {
      await pool.query('INSERT INTO retention_policy (tenant_id, message_event_retention_days) VALUES ($1, $2)', [tenantId, retentionDays]);
    }
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `retention-template-${randomUUID()}`],
    )).rows[0];
    const templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('4', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'completed', $3) RETURNING id`,
      [tenantId, `retention-${randomUUID()}`, templateVersionId],
    )).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 3, 3, 0) RETURNING id`,
      [tenantId, campaign.id, templateVersionId],
    )).rows[0];
    const execution = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status, submitted_count, delivered_count, finished_at)
       VALUES ($1, $2, $3, $4, 'completed', 1, 2, $5) RETURNING id`,
      [tenantId, campaign.id, snapshot.id, `retention-${randomUUID()}`, eventAt],
    )).rows[0];

    for (let index = 0; index < 3; index += 1) {
      const recipient = (await pool.query<{ id: string }>(
        'INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id',
        [tenantId, `retention-${index}-${randomUUID()}@example.test`],
      )).rows[0];
      const campaignRecipient = (await pool.query<{ id: string }>(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, execution_id, merge_data_json, email_snapshot, eligibility, status)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '{}'::jsonb, 'sendable', 'delivered') RETURNING id`,
        [tenantId, campaign.id, snapshot.id, recipient.id, execution.id],
      )).rows[0];
      await pool.query(
        `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, provider_message_id, content_hash, attempted_at)
         VALUES ($1, $2, $3, 1, 'submitted', $4, repeat('7', 64), $5)`,
        [tenantId, execution.id, campaignRecipient.id, `retention-${randomUUID()}@mail.test`, eventAt],
      );
      if (index < 2) {
        await pool.query(
          `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, received_at, outcome, payload)
           VALUES ($1, 'smtp', $2, 'delivered', $3, $4, $5, $6, $6, 'applied', '{}'::jsonb)`,
          [tenantId, `retention-event-${randomUUID()}`, `retention-${randomUUID()}@mail.test`, campaignRecipient.id, execution.id, eventAt],
        );
      }
    }
    return { tenantId, executionId: execution.id };
  }

  let shortPolicyTenantId: string;
  let shortPolicyExecutionId: string;
  let longPolicyTenantId: string;
  let noPolicyTenantId: string;

  beforeEach(async () => {
    const short = await seedTenant('retention-short', 30, FIVE_YEARS);
    shortPolicyTenantId = short.tenantId;
    shortPolicyExecutionId = short.executionId;
    longPolicyTenantId = (await seedTenant('retention-long', 3650, FIVE_YEARS)).tenantId;
    noPolicyTenantId = (await seedTenant('retention-default', null, PAST_DEFAULT)).tenantId;
  });

  afterEach(async () => {
    for (const tenantId of [shortPolicyTenantId, longPolicyTenantId, noPolicyTenantId]) {
      await purgeCampaignSendFixtures(pool, tenantId, 'eow_history_purge_test_cleanup');
      await pool.query('DELETE FROM retention_policy WHERE tenant_id = $1', [tenantId]);
      await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantId]);
      await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
      await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    }
  });

  afterAll(async () => { await pool.end(); });

  async function readAggregate(executionId: string) {
    const result = await pool.query(
      `SELECT ce.status, ce.progress_seq, ce.pending_count, ce.queued_count, ce.submitted_count,
              ce.delivered_count, ce.bounced_count, ce.failed_count, ce.skipped_count, ce.cancelled_count,
              cs.total_snapshot, cs.sendable_count
       FROM campaign_execution ce JOIN campaign_snapshot cs ON cs.id = ce.snapshot_id
       WHERE ce.id = $1`,
      [executionId],
    );
    return result.rows[0];
  }

  it('A1/A4: the tenant policy decides, not the row age', async () => {
    const results = await purgeHistoryEvents(testAppDatabaseUrl(), 365, now);

    const short = results.find((row) => row.tenantId === shortPolicyTenantId);
    expect(short?.messageAttemptsDeleted).toBe(3);
    expect(short?.deliveryEventsDeleted).toBe(2);
    expect(short?.retentionDays).toBe(30);
    expect(short?.source).toBe('policy');

    const shortRemaining = await pool.query('SELECT count(*)::int AS count FROM message_attempt WHERE tenant_id = $1', [shortPolicyTenantId]);
    expect(shortRemaining.rows[0].count).toBe(0);

    // Same 5-year-old rows, a 3650-day policy: untouched. The only difference is the policy.
    const longRemaining = await pool.query('SELECT count(*)::int AS count FROM message_attempt WHERE tenant_id = $1', [longPolicyTenantId]);
    expect(longRemaining.rows[0].count).toBe(3);
    expect(results.find((row) => row.tenantId === longPolicyTenantId)).toBeUndefined();

    // No policy row at all: the 365-day deployment default applies, and says purge.
    const fallback = results.find((row) => row.tenantId === noPolicyTenantId);
    expect(fallback?.retentionDays).toBe(365);
    expect(fallback?.source).toBe('default');
    const fallbackRemaining = await pool.query('SELECT count(*)::int AS count FROM message_attempt WHERE tenant_id = $1', [noPolicyTenantId]);
    expect(fallbackRemaining.rows[0].count).toBe(0);
  });

  it('A2: leaves the aggregate report identical', async () => {
    const before = await readAggregate(shortPolicyExecutionId);
    await purgeHistoryEvents(testAppDatabaseUrl(), 365, now);
    const after = await readAggregate(shortPolicyExecutionId);
    expect(after).toEqual(before);
  });

  it('A5: writes exactly one audit row per purging tenant', async () => {
    await purgeHistoryEvents(testAppDatabaseUrl(), 365, now);
    const audit = await pool.query(
      `SELECT actor_id, action, entity_type, metadata FROM audit_log WHERE tenant_id = $1 AND action = 'history.purged'`,
      [shortPolicyTenantId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).toBeNull();
    expect(audit.rows[0].entity_type).toBe('tenant');
    expect(audit.rows[0].metadata).toMatchObject({
      retentionDays: 30,
      source: 'policy',
      messageAttemptsDeleted: 3,
      deliveryEventsDeleted: 2,
    });
    expect(typeof audit.rows[0].metadata.cutoff).toBe('string');
    expect(audit.rows[0].metadata.executionsAffected).toBe(1);
  });

  it('A6: a second run deletes nothing and writes no further audit row', async () => {
    await purgeHistoryEvents(testAppDatabaseUrl(), 365, now);
    const second = await purgeHistoryEvents(testAppDatabaseUrl(), 365, now);
    expect(second.find((row) => row.tenantId === shortPolicyTenantId)).toBeUndefined();
    const audit = await pool.query(
      `SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND action = 'history.purged'`,
      [shortPolicyTenantId],
    );
    expect(audit.rows[0].count).toBe(1);
  });
});
