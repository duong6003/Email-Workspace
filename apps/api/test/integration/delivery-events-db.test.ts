import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testAppDatabaseUrl, testDatabaseUrl } from './test-database-url.js';

/**
 * M5-S4 CP1, RED first: migration 027 has not been written yet. Every case
 * here must fail against the current schema before 027 exists, and pass once
 * it lands. Covers the DB-layer half of BR-SEND-008 only -- the webhook
 * route (verify/parse/apply) is CP3+.
 */
describe('Delivery events DB layer (M5-S4 CP1: BR-SEND-008, migration 027)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let templateVersionId: string;
  let campaignId: string;
  let snapshotId: string;
  let executionId: string;

  async function insertRecipientAndAttempt(overrides: { providerMessageId: string | null; outcome?: string }) {
    const [recipient] = await dataSource.query(
      `INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`,
      [tenantA.id, `delivery-events-db-${randomUUID()}@example.test`],
    );
    const [campaignRecipient] = await dataSource.query(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, eligibility, status, execution_id)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, 'sendable', 'submitted', $5) RETURNING id`,
      [tenantA.id, campaignId, snapshotId, recipient.id, executionId],
    );
    await dataSource.query(
      `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, provider_message_id, content_hash)
       VALUES ($1, $2, $3, 1, $4, $5, repeat('a', 64))`,
      [tenantA.id, executionId, campaignRecipient.id, overrides.outcome ?? 'submitted', overrides.providerMessageId],
    );
    return { recipientId: recipient.id, campaignRecipientId: campaignRecipient.id };
  }

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenantA = await dataSource.getRepository(TenantEntity).save({ name: `delivery-events-db-${randomUUID()}` });

    const [template] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantA.id, `delivery-events-db-template-${randomUUID()}`],
    );
    const [version] = await dataSource.query(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('a', 64), now()) RETURNING id`,
      [tenantA.id, template.id],
    );
    templateVersionId = version.id;

    const [campaign] = await dataSource.query(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'sending', $3) RETURNING id`,
      [tenantA.id, `delivery-events-db-campaign-${randomUUID()}`, templateVersionId],
    );
    campaignId = campaign.id;

    const [snapshot] = await dataSource.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [tenantA.id, campaignId, templateVersionId],
    );
    snapshotId = snapshot.id;

    const [execution] = await dataSource.query(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantA.id, campaignId, snapshotId, `delivery-events-db-${randomUUID()}`],
    );
    executionId = execution.id;
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.query('DELETE FROM delivery_event WHERE tenant_id = $1', [tenantA.id]).catch(() => undefined);
    await dataSource.query('DELETE FROM message_attempt WHERE tenant_id = $1', [tenantA.id]);
    await dataSource.query('DELETE FROM campaign_execution WHERE tenant_id = $1', [tenantA.id]);
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_delivery_events_db_test_cleanup'))");
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
    await dataSource.getRepository(TenantEntity).delete(tenantA.id);
    await dataSource.destroy();
  });

  it('A1: delivery_event UNIQUE(provider, provider_event_id) rejects a second row for the same pair', async () => {
    const { campaignRecipientId } = await insertRecipientAndAttempt({ providerMessageId: `mid-${randomUUID()}` });
    const eventId = `evt-${randomUUID()}`;
    await expect(
      dataSource.query(
        `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, outcome, payload)
         VALUES ($1, 'smtp', $2, 'delivered', 'mid-x', $3, $4, now(), 'applied', '{}'::jsonb)`,
        [tenantA.id, eventId, campaignRecipientId, executionId],
      ),
    ).resolves.toBeDefined();
    await expect(
      dataSource.query(
        `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, outcome, payload)
         VALUES ($1, 'smtp', $2, 'bounced', 'mid-x', $3, $4, now(), 'applied', '{}'::jsonb)`,
        [tenantA.id, eventId, campaignRecipientId, executionId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('A1: delivery_event rejects an unknown event_type with 23514', async () => {
    const { campaignRecipientId } = await insertRecipientAndAttempt({ providerMessageId: `mid-${randomUUID()}` });
    await expect(
      dataSource.query(
        `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, outcome, payload)
         VALUES ($1, 'smtp', $2, 'bogus_type', 'mid-x', $3, $4, now(), 'applied', '{}'::jsonb)`,
        [tenantA.id, `evt-${randomUUID()}`, campaignRecipientId, executionId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('A1: delivery_event rejects an unknown outcome with 23514', async () => {
    const { campaignRecipientId } = await insertRecipientAndAttempt({ providerMessageId: `mid-${randomUUID()}` });
    await expect(
      dataSource.query(
        `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, outcome, payload)
         VALUES ($1, 'smtp', $2, 'delivered', 'mid-x', $3, $4, now(), 'bogus_outcome', '{}'::jsonb)`,
        [tenantA.id, `evt-${randomUUID()}`, campaignRecipientId, executionId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('A1: eow_app can INSERT/SELECT delivery_event but cannot UPDATE or DELETE it', async () => {
    const { campaignRecipientId } = await insertRecipientAndAttempt({ providerMessageId: `mid-${randomUUID()}` });
    const eventId = `evt-${randomUUID()}`;
    const [row] = await dataSource.query(
      `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, outcome, payload)
       VALUES ($1, 'smtp', $2, 'delivered', 'mid-x', $3, $4, now(), 'applied', '{}'::jsonb) RETURNING id`,
      [tenantA.id, eventId, campaignRecipientId, executionId],
    );

    const appDataSource = createDataSource(testAppDatabaseUrl());
    await appDataSource.initialize();
    try {
      await appDataSource.query("SELECT set_config('app.tenant_id', $1, false)", [tenantA.id]);
      await expect(appDataSource.query('SELECT id FROM delivery_event WHERE id = $1', [row.id])).resolves.toHaveLength(1);
      await expect(
        appDataSource.query(`UPDATE delivery_event SET outcome = 'duplicate' WHERE id = $1`, [row.id]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        appDataSource.query(`DELETE FROM delivery_event WHERE id = $1`, [row.id]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await appDataSource.destroy();
    }
  });

  it('A1: delivery_event RLS refuses a row belonging to another tenant', async () => {
    const tenantB = await dataSource.getRepository(TenantEntity).save({ name: `delivery-events-db-b-${randomUUID()}` });
    try {
      const { campaignRecipientId } = await insertRecipientAndAttempt({ providerMessageId: `mid-${randomUUID()}` });
      const [row] = await dataSource.query(
        `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, outcome, payload)
         VALUES ($1, 'smtp', $2, 'delivered', 'mid-x', $3, $4, now(), 'applied', '{}'::jsonb) RETURNING id`,
        [tenantA.id, `evt-${randomUUID()}`, campaignRecipientId, executionId],
      );

      const appDataSource = createDataSource(testAppDatabaseUrl());
      await appDataSource.initialize();
      try {
        await appDataSource.query("SELECT set_config('app.tenant_id', $1, false)", [tenantB.id]);
        await expect(appDataSource.query('SELECT id FROM delivery_event WHERE id = $1', [row.id])).resolves.toHaveLength(0);
      } finally {
        await appDataSource.destroy();
      }
    } finally {
      await dataSource.getRepository(TenantEntity).delete(tenantB.id);
    }
  });

  it('campaign_recipient gains delivery_state_at, defaulting to NULL', async () => {
    const { campaignRecipientId } = await insertRecipientAndAttempt({ providerMessageId: `mid-${randomUUID()}` });
    const [row] = await dataSource.query(
      `SELECT delivery_state_at FROM campaign_recipient WHERE id = $1`,
      [campaignRecipientId],
    );
    expect(row.delivery_state_at).toBeNull();
  });

  it('D-107: idx_message_attempt_provider_message_id exists', async () => {
    const [row] = await dataSource.query(
      `SELECT 1 FROM pg_indexes WHERE tablename = 'message_attempt' AND indexname = 'idx_message_attempt_provider_message_id'`,
    );
    expect(row).toBeDefined();
  });

  it('D-107: resolve_provider_message returns exactly one row for a submitted attempt with a matching provider_message_id', async () => {
    const providerMessageId = `mid-resolve-one-${randomUUID()}`;
    const { campaignRecipientId } = await insertRecipientAndAttempt({ providerMessageId });
    const rows = await dataSource.query('SELECT * FROM resolve_provider_message($1)', [providerMessageId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenantA.id);
    expect(rows[0].campaign_recipient_id).toBe(campaignRecipientId);
    expect(rows[0].execution_id).toBe(executionId);
  });

  it('D-107: resolve_provider_message returns zero rows for an unknown provider_message_id', async () => {
    const rows = await dataSource.query('SELECT * FROM resolve_provider_message($1)', [`mid-unknown-${randomUUID()}`]);
    expect(rows).toHaveLength(0);
  });

  it('D-107: resolve_provider_message returns two rows when the same provider_message_id was submitted for two different recipients', async () => {
    const providerMessageId = `mid-ambiguous-${randomUUID()}`;
    await insertRecipientAndAttempt({ providerMessageId });
    await insertRecipientAndAttempt({ providerMessageId });
    const rows = await dataSource.query('SELECT * FROM resolve_provider_message($1)', [providerMessageId]);
    expect(rows).toHaveLength(2);
  });

  it('D-107: resolve_provider_message ignores an attempt whose outcome is not submitted', async () => {
    const providerMessageId = `mid-not-submitted-${randomUUID()}`;
    await insertRecipientAndAttempt({ providerMessageId, outcome: 'transient_error' });
    const rows = await dataSource.query('SELECT * FROM resolve_provider_message($1)', [providerMessageId]);
    expect(rows).toHaveLength(0);
  });

  it('resolve_provider_message is callable via the narrow app role and refuses PUBLIC', async () => {
    const providerMessageId = `mid-app-role-${randomUUID()}`;
    await insertRecipientAndAttempt({ providerMessageId });

    const appDataSource = createDataSource(testAppDatabaseUrl());
    await appDataSource.initialize();
    try {
      await expect(
        appDataSource.query('SELECT * FROM resolve_provider_message($1)', [providerMessageId]),
      ).resolves.toHaveLength(1);
    } finally {
      await appDataSource.destroy();
    }

    const [row] = await dataSource.query(
      `SELECT has_function_privilege('public', 'resolve_provider_message(text)', 'execute') AS public_can_execute`,
    );
    expect(row.public_can_execute).toBe(false);
  });
});
