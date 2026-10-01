import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { reconcileProgress } from './progress-reconcile.js';
import { purgeCampaignSendFixtures } from './test-cleanup-helpers.js';
import { testOwnerDatabaseUrl } from './test-urls.js';
import type { ProgressEvent, ResyncEvent } from './campaign-send/progress-event.js';

/**
 * M6-S1 CP9 (BR-HIS-008, ADR-026). TC-HIS-010's own fixture: a stored
 * summary (campaign_execution.*_count) that has fallen behind the
 * delivery_event ledger. Two layers of drift on purpose -- 2 of 82
 * recipients whose campaign_recipient.status disagrees with their own
 * newest applied delivery_event (layer 1, repaired via the same
 * decideWebhookOutcome the live webhook path uses), and a stored summary
 * that (accidentally) matches the pre-repair drifted state and therefore
 * disagrees with the post-repair true facts (layer 2).
 */
/**
 * Every test here calls `reconcileProgress`, whose entry point is a CROSS-TENANT
 * scan: `reconcilable_campaign_executions(CROSS_TENANT_SCAN_LIMIT)`. Its cost is
 * therefore set by how many due executions the whole database holds, not by this
 * file's own fixture -- and on a developer machine that means the seeded demo
 * data too. Measured 2026-09-04 on this machine: 55 due executions, 41 of them
 * belonging to the "Acme Demo" seed, one scan taking 2.8-6.1s. A14 needed 28.7s
 * and A15 (which scans twice) 29.6s against a 30s budget, so both crossed the
 * line whenever anything else was running, and all four then reported as
 * timeouts -- which reads as a broken reconcile rather than as a scan given a
 * budget that never had room for what it scans.
 *
 * 120s covers the bound the production code sets itself. The scan stops at
 * CROSS_TENANT_SCAN_LIMIT = 100, roughly twice what was measured, so this is not
 * an open-ended budget: it is the design's own worst case, with margin.
 */
describe('reconcileProgress (M6-S1 CP9: BR-HIS-008)', { timeout: 120_000 }, () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let templateVersionId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-reconcile-${randomUUID()}`])).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `reconcile-template-${randomUUID()}`],
    )).rows[0];
    templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('5', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
  });

  afterAll(async () => {
    await purgeCampaignSendFixtures(pool, tenantId, 'eow_progress_reconcile_test_cleanup');
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    // A17's fixture user: audit_log is immutable (BR-SEC-002), and this
    // worker-side pool has no login flow to trigger one against this user,
    // so (unlike the API-side realtime-campaign.test.ts) the tenant row
    // itself is still deletable once app_user/user_role are cleared.
    await pool.query('DELETE FROM user_role WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM app_user WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  async function driftedFixture(): Promise<{ campaignId: string; executionId: string; snapshotId: string; driftedRecipientIds: string[] }> {
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'completed', $3) RETURNING id`,
      [tenantId, `reconcile-${randomUUID()}`, templateVersionId],
    )).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 82, 82, 0) RETURNING id`,
      [tenantId, campaign.id, templateVersionId],
    )).rows[0];
    const execution = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status, finished_at,
                                        submitted_count, delivered_count)
       VALUES ($1, $2, $3, $4, 'completed', now() - interval '1 day', 2, 80) RETURNING id`,
      [tenantId, campaign.id, snapshot.id, `reconcile-${randomUUID()}`],
    )).rows[0];

    const driftedRecipientIds: string[] = [];
    for (let i = 0; i < 82; i += 1) {
      const recipient = (await pool.query<{ id: string }>(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [tenantId, `reconcile-${i}-${randomUUID()}@example.test`])).rows[0];
      const drifted = i < 2;
      const [campaignRecipient] = (await pool.query<{ id: string }>(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, eligibility, status, execution_id, delivery_state_at)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 'sendable', $5, $6, $7) RETURNING id`,
        [tenantId, campaign.id, snapshot.id, recipient.id, drifted ? 'submitted' : 'delivered', execution.id, drifted ? null : new Date('2026-08-10T00:00:00.000Z')],
      )).rows;
      const attemptResult = await pool.query<{ id: string }>(
        `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, provider_message_id, content_hash)
         VALUES ($1, $2, $3, 1, 'submitted', $4, repeat('a', 64)) RETURNING id`,
        [tenantId, execution.id, campaignRecipient.id, `mid-reconcile-${i}-${randomUUID()}`],
      );
      await pool.query(
        `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, outcome, payload)
         VALUES ($1, 'smtp', $2, 'delivered', $3, $4, $5, $6, 'applied', '{}'::jsonb)`,
        [tenantId, `evt-reconcile-${i}-${randomUUID()}`, `mid-reconcile-${i}`, campaignRecipient.id, execution.id, new Date('2026-08-10T00:00:00.000Z')],
      );
      void attemptResult;
      if (drifted) driftedRecipientIds.push(campaignRecipient.id);
    }
    return { campaignId: campaign.id, executionId: execution.id, snapshotId: snapshot.id, driftedRecipientIds };
  }

  it('A14: repairs the 2 drifted recipients, corrects the stored summary, writes one audit row with the delta, and publishes', async () => {
    const { executionId, driftedRecipientIds } = await driftedFixture();
    const published: Array<ProgressEvent | ResyncEvent> = [];
    const publish = async (event: ProgressEvent | ResyncEvent): Promise<void> => { published.push(event); };

    const results = await reconcileProgress(testOwnerDatabaseUrl(), publish);

    const mine = results.find((r) => r.executionId === executionId);
    expect(mine).toBeDefined();
    expect(mine!.repairedRecipients).toBe(2);
    expect(mine!.drift).toBeGreaterThan(0);

    const drifted = await pool.query<{ status: string; delivery_state_at: Date }>(
      `SELECT status, delivery_state_at FROM campaign_recipient WHERE id = ANY($1)`, [driftedRecipientIds],
    );
    expect(drifted.rows.every((r) => r.status === 'delivered')).toBe(true);
    expect(drifted.rows.every((r) => r.delivery_state_at !== null)).toBe(true);

    const [counts] = (await pool.query<{ delivered_count: number; submitted_count: number; progress_seq: string }>(
      `SELECT delivered_count, submitted_count, progress_seq FROM campaign_execution WHERE id = $1`, [executionId],
    )).rows;
    expect(counts.delivered_count).toBe(82);
    expect(counts.submitted_count).toBe(0);
    expect(Number(counts.progress_seq)).toBeGreaterThan(0);

    const audit = await pool.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'progress.reconciled' AND entity_id = $2`,
      [tenantId, executionId],
    );
    expect(audit.rows).toHaveLength(1);

    const campaignEvents = published.filter((e): e is ProgressEvent => e.event_type === 'campaign.progress' && e.aggregate_id === mine!.campaignId);
    expect(campaignEvents.length).toBeGreaterThanOrEqual(1);
    expect(campaignEvents[campaignEvents.length - 1].data.counts.delivered).toBe(82);
  });

  it('A15: a second run over the same (now-repaired) data changes nothing and reports drift 0', async () => {
    const { executionId } = await driftedFixture();
    await reconcileProgress(testOwnerDatabaseUrl(), async () => undefined);

    const auditBefore = await pool.query(`SELECT id FROM audit_log WHERE tenant_id = $1 AND action = 'progress.reconciled' AND entity_id = $2`, [tenantId, executionId]);

    const secondResults = await reconcileProgress(testOwnerDatabaseUrl(), async () => undefined);

    const mine = secondResults.find((r) => r.executionId === executionId);
    expect(mine!.drift).toBe(0);
    expect(mine!.repairedRecipients).toBe(0);
    const auditAfter = await pool.query(`SELECT id FROM audit_log WHERE tenant_id = $1 AND action = 'progress.reconciled' AND entity_id = $2`, [tenantId, executionId]);
    expect(auditAfter.rowCount).toBe(auditBefore.rowCount);
  });

  it('A16: a recipient already delivered with a later delivery_state_at than the ledger event is left untouched', async () => {
    const { executionId, snapshotId } = await driftedFixture();
    const recipient = (await pool.query<{ id: string }>(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [tenantId, `reconcile-noregress-${randomUUID()}@example.test`])).rows[0];
    const laterTimestamp = new Date('2026-08-15T00:00:00.000Z');
    const [campaignRecipient] = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, eligibility, status, execution_id, delivery_state_at)
       VALUES ($1, (SELECT campaign_id FROM campaign_execution WHERE id = $5), $2, $3, '{}'::jsonb, 'sendable', 'delivered', $5, $4) RETURNING id`,
      [tenantId, snapshotId, recipient.id, laterTimestamp, executionId],
    )).rows;
    // An OLDER ledger event for the same recipient (already superseded by
    // the later applied one above) must not regress the row.
    await pool.query(
      `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, outcome, payload)
       VALUES ($1, 'smtp', $2, 'bounced', $3, $4, $5, $6, 'applied', '{}'::jsonb)`,
      [tenantId, `evt-noregress-${randomUUID()}`, `mid-noregress-${randomUUID()}`, campaignRecipient.id, executionId, new Date('2026-08-05T00:00:00.000Z')],
    );

    await reconcileProgress(testOwnerDatabaseUrl(), async () => undefined);

    const [row] = (await pool.query<{ status: string; delivery_state_at: Date }>(
      `SELECT status, delivery_state_at FROM campaign_recipient WHERE id = $1`, [campaignRecipient.id],
    )).rows;
    expect(row.status).toBe('delivered');
    expect(row.delivery_state_at.toISOString()).toBe(laterTimestamp.toISOString());
  });

  it('A17: emits rt.resync_required to every tenant user holding campaign:read only when a repair happened', async () => {
    const viewer = (await pool.query<{ id: string }>(
      `INSERT INTO app_user (tenant_id, email, display_name, role) VALUES ($1, $2, 'A17 Viewer', 'viewer') RETURNING id`,
      [tenantId, `reconcile-a17-${randomUUID()}@example.test`],
    )).rows[0];
    // An explicit user_role row (not just app_user.role text): PermissionsService
    // treats explicit user_role rows as authoritative and only falls back to
    // the legacy role-text column when none exist. progress-reconcile.ts's own
    // affected-user query only reads user_role directly (matching
    // notification-writer.ts's own precedent), so this fixture must set one up
    // the way a real role assignment would, not rely on the legacy fallback.
    const [viewerRole] = (await pool.query<{ id: string }>(`SELECT id FROM role WHERE key = 'viewer'`)).rows;
    await pool.query(`INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [tenantId, viewer.id, viewerRole.id]);

    const { campaignId } = await driftedFixture();
    const published: Array<ProgressEvent | ResyncEvent> = [];
    const publish = async (event: ProgressEvent | ResyncEvent): Promise<void> => { published.push(event); };

    await reconcileProgress(testOwnerDatabaseUrl(), publish);

    const resyncForViewer = published.filter((e): e is ResyncEvent => e.event_type === 'rt.resync_required' && e.aggregate_id === viewer.id);
    expect(resyncForViewer.length).toBeGreaterThanOrEqual(1);
    expect(resyncForViewer[0].data.campaign_id).toBe(campaignId);

    // Second run: no drift left, so no resync at all for this execution.
    const publishedAfterClean: Array<ProgressEvent | ResyncEvent> = [];
    await reconcileProgress(testOwnerDatabaseUrl(), async (event) => { publishedAfterClean.push(event); });
    const secondResync = publishedAfterClean.filter((e): e is ResyncEvent => e.event_type === 'rt.resync_required' && e.aggregate_id === viewer.id && e.data.campaign_id === campaignId);
    expect(secondResync).toHaveLength(0);
  });
});
