import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testAppDatabaseUrl, testDatabaseUrl } from './test-database-url.js';

/**
 * M5-S3 CP1, RED first: migration 026 has not been written yet. Every case
 * here must fail against the current schema before 026 exists, and pass once
 * it lands. Covers the DB-layer half of BR-SEND-002/006/007 only -- the
 * worker DAG (validate/freeze/partition/send/aggregate) is CP3+.
 */
describe('Campaign execution DB layer (M5-S3 CP1: BR-SEND-002/006/007, migration 026)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let templateVersionId: string;
  let campaignId: string;
  let snapshotId: string;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenantA = await dataSource.getRepository(TenantEntity).save({ name: `campaign-execution-db-${randomUUID()}` });

    const [template] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantA.id, `exec-db-template-${randomUUID()}`],
    );
    const [version] = await dataSource.query(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('a', 64), now()) RETURNING id`,
      [tenantA.id, template.id],
    );
    templateVersionId = version.id;

    const [campaign] = await dataSource.query(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'queued', $3) RETURNING id`,
      [tenantA.id, `exec-db-campaign-${randomUUID()}`, templateVersionId],
    );
    campaignId = campaign.id;

    const [snapshot] = await dataSource.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [tenantA.id, campaignId, templateVersionId],
    );
    snapshotId = snapshot.id;
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    // M5-S4 CP1 (R7): delivery_event.campaign_recipient_id is NOT NULL
    // REFERENCES campaign_recipient(id) -- delete it before that table, the
    // same FK-ordering class D-93 already produced once.
    await dataSource.query('DELETE FROM delivery_event WHERE tenant_id = $1', [tenantA.id]);
    await dataSource.query('DELETE FROM message_attempt WHERE tenant_id = $1', [tenantA.id]);
    await dataSource.query('DELETE FROM campaign_execution WHERE tenant_id = $1', [tenantA.id]);
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_execution_db_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE email_template_version DISABLE TRIGGER email_template_version_immutable_trigger');
      try {
        await manager.query('DELETE FROM campaign_recipient WHERE tenant_id = $1', [tenantA.id]);
        await manager.query('DELETE FROM campaign_snapshot WHERE tenant_id = $1', [tenantA.id]);
        await manager.query('DELETE FROM campaign WHERE tenant_id = $1', [tenantA.id]);
        await manager.query('DELETE FROM email_template_version WHERE tenant_id = $1', [tenantA.id]);
      } finally {
        await manager.query('ALTER TABLE email_template_version ENABLE TRIGGER email_template_version_immutable_trigger');
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
        await manager.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      }
    });
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantA.id]);
    await dataSource.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantA.id]);
    await dataSource.query('DELETE FROM sender_config WHERE tenant_id = $1', [tenantA.id]);
    await dataSource.getRepository(TenantEntity).delete(tenantA.id);
    await dataSource.destroy();
  });

  async function insertRecipient(overrides: { eligibility: 'sendable' | 'skipped'; status: string; skippedReason?: string | null }) {
    const [recipient] = await dataSource.query(
      `INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`,
      [tenantA.id, `exec-db-${randomUUID()}@example.test`],
    );
    return dataSource.query(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, eligibility, skipped_reason, status)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7) RETURNING id`,
      [tenantA.id, campaignId, snapshotId, recipient.id, overrides.eligibility, overrides.skippedReason ?? null, overrides.status],
    );
  }

  it('BR-SEND-002: campaign_recipient_status_known admits the eight message states', async () => {
    const values = ['pending', 'queued', 'submitted', 'delivered', 'bounced', 'failed', 'cancelled'];
    for (const status of values) {
      await expect(insertRecipient({ eligibility: 'sendable', status })).resolves.toBeDefined();
    }
    await expect(insertRecipient({ eligibility: 'skipped', status: 'skipped', skippedReason: 'status_bounced' })).resolves.toBeDefined();
  });

  it('BR-SEND-002: campaign_recipient_status_known rejects a ninth value', async () => {
    await expect(insertRecipient({ eligibility: 'sendable', status: 'bogus_status' })).rejects.toMatchObject({ code: '23514' });
  });

  it('D-88: campaign_recipient_skipped_status_agrees rejects a skipped row whose status is not skipped', async () => {
    await expect(
      insertRecipient({ eligibility: 'skipped', status: 'pending', skippedReason: 'status_bounced' }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('D-88: campaign_recipient_skipped_status_agrees rejects a sendable row whose status is skipped', async () => {
    await expect(
      insertRecipient({ eligibility: 'sendable', status: 'skipped' }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('campaign_execution UNIQUE(campaign_id, snapshot_id) rejects a second row for the same pair', async () => {
    const correlationId = `exec-db-${randomUUID()}`;
    await expect(
      dataSource.query(
        `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id) VALUES ($1, $2, $3, $4)`,
        [tenantA.id, campaignId, snapshotId, correlationId],
      ),
    ).resolves.toBeDefined();
    await expect(
      dataSource.query(
        `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id) VALUES ($1, $2, $3, $4)`,
        [tenantA.id, campaignId, snapshotId, `${correlationId}-dup`],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('message_attempt UNIQUE(campaign_recipient_id, attempt_no) rejects a duplicate attempt', async () => {
    // Its own campaign/snapshot, not the shared fixture: campaign_execution's
    // own UNIQUE(campaign_id, snapshot_id) (proved above) means the shared
    // pair already has a live execution row.
    const [campaign] = await dataSource.query(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'queued', $3) RETURNING id`,
      [tenantA.id, `exec-db-attempt-campaign-${randomUUID()}`, templateVersionId],
    );
    const [snapshot] = await dataSource.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [tenantA.id, campaign.id, templateVersionId],
    );
    const [recipient] = await dataSource.query(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [
      tenantA.id,
      `exec-db-attempt-${randomUUID()}@example.test`,
    ]);
    const [recipientRow] = await dataSource.query(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, eligibility, status)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, 'sendable', 'queued') RETURNING id`,
      [tenantA.id, campaign.id, snapshot.id, recipient.id],
    );
    const [execution] = await dataSource.query(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantA.id, campaign.id, snapshot.id, `exec-db-attempt-${randomUUID()}`],
    );
    await expect(
      dataSource.query(
        `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, content_hash)
         VALUES ($1, $2, $3, 1, 'submitted', repeat('a', 64))`,
        [tenantA.id, execution.id, recipientRow.id],
      ),
    ).resolves.toBeDefined();
    await expect(
      dataSource.query(
        `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, content_hash)
         VALUES ($1, $2, $3, 1, 'transient_error', repeat('a', 64))`,
        [tenantA.id, execution.id, recipientRow.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('D-90: sender_config gains a positive-default rate_limit_per_minute and rejects a non-positive override', async () => {
    const [sender] = await dataSource.query(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref)
       VALUES ($1, 'Exec DB sender', 'exec-db@example.test', 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_EXEC_DB_TEST')
       RETURNING rate_limit_per_minute, daily_send_limit`,
      [tenantA.id],
    );
    expect(sender.rate_limit_per_minute).toBe(60);
    expect(sender.daily_send_limit).toBeNull();
    await expect(
      dataSource.query(
        `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, rate_limit_per_minute)
         VALUES ($1, 'Exec DB sender 2', 'exec-db-2@example.test', 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_EXEC_DB_TEST_2', 0)`,
        [tenantA.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('D-90: sending_policy gains bounded batch_size/max_attempts/tenant_rate_limit_per_minute defaults', async () => {
    const [policy] = await dataSource.query(
      `INSERT INTO sending_policy (tenant_id) VALUES ($1) RETURNING batch_size, max_attempts, tenant_rate_limit_per_minute`,
      [tenantA.id],
    );
    expect(policy.batch_size).toBe(100);
    expect(policy.max_attempts).toBe(5);
    expect(policy.tenant_rate_limit_per_minute).toBe(600);
    await dataSource.query('DELETE FROM sending_policy WHERE tenant_id = $1', [tenantA.id]);
    await expect(
      dataSource.query(`INSERT INTO sending_policy (tenant_id, max_attempts) VALUES ($1, 0)`, [tenantA.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('D-91: recipient gains a complete-or-null suppression pair', async () => {
    const [recipient] = await dataSource.query(
      `INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`,
      [tenantA.id, `exec-db-suppress-${randomUUID()}@example.test`],
    );
    await expect(
      dataSource.query(`UPDATE recipient SET suppressed_at = now() WHERE id = $1`, [recipient.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      dataSource.query(`UPDATE recipient SET suppressed_at = now(), suppression_reason = 'hard_bounce' WHERE id = $1`, [recipient.id]),
    ).resolves.toBeDefined();
    await dataSource.query('DELETE FROM recipient WHERE id = $1', [recipient.id]);
  });

  it('the dispatch scan function queued_campaign_executions() is callable via the narrow app role', async () => {
    const appDataSource = createDataSource(testAppDatabaseUrl());
    await appDataSource.initialize();
    try {
      await expect(appDataSource.query('SELECT * FROM queued_campaign_executions(10)')).resolves.toBeDefined();
    } finally {
      await appDataSource.destroy();
    }
  });
});
