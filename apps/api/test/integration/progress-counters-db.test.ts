import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testAppDatabaseUrl, testDatabaseUrl } from './test-database-url.js';

/**
 * M6-S1 CP2, RED first: migration 028 has not been written yet. Every case
 * here must fail against the current schema before 028 exists, and pass
 * once it lands. Covers the DB-layer half of BR-HIS-008/ADR-016 only -- the
 * worker/API read and write paths are CP3+.
 */
describe('Progress counters DB layer (M6-S1 CP2: BR-HIS-008, migration 028)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let templateVersionId: string;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenantA = await dataSource.getRepository(TenantEntity).save({ name: `progress-counters-db-${randomUUID()}` });

    const [template] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantA.id, `progress-counters-db-template-${randomUUID()}`],
    );
    const [version] = await dataSource.query(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('b', 64), now()) RETURNING id`,
      [tenantA.id, template.id],
    );
    templateVersionId = version.id;
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    // Same FK-ordering discipline as delivery-events-db.test.ts and
    // campaign-execution-db.test.ts: child rows before the tenant row.
    // D-118 (this session): the live docker-compose worker/scheduler polls
    // this same shared database and can pick up a 'sending' campaign mid-test,
    // writing an outbox_event row this cleanup would not otherwise expect --
    // delete outbox_event for this tenant defensively before the tenant row.
    await dataSource.query('DELETE FROM outbox_event WHERE tenant_id = $1', [tenantA.id]).catch(() => undefined);
    await dataSource.query('DELETE FROM message_attempt WHERE tenant_id = $1', [tenantA.id]);
    await dataSource.query('DELETE FROM campaign_execution WHERE tenant_id = $1', [tenantA.id]);
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_progress_counters_db_test_cleanup'))");
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
    await dataSource.getRepository(TenantEntity).delete(tenantA.id);
    await dataSource.destroy();
  });

  // Each execution gets its own campaign/snapshot pair: campaign_execution's
  // own UNIQUE(campaign_id, snapshot_id) means a shared pair can carry only
  // one live execution row, and several tests here need more than one.
  async function insertExecution(): Promise<string> {
    const [campaign] = await dataSource.query(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'sending', $3) RETURNING id`,
      [tenantA.id, `progress-counters-db-campaign-${randomUUID()}`, templateVersionId],
    );
    const [snapshot] = await dataSource.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [tenantA.id, campaign.id, templateVersionId],
    );
    const [execution] = await dataSource.query(
      // status='sending' (not the 'validating' default): reconcilable_campaign_executions()
      // selects on status='sending' OR a recent finished_at, and this helper's
      // default fixture is what "returns a sending execution" exercises.
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status) VALUES ($1, $2, $3, $4, 'sending') RETURNING id`,
      [tenantA.id, campaign.id, snapshot.id, `progress-counters-db-${randomUUID()}`],
    );
    return execution.id;
  }

  it('campaign_execution gains progress_seq and the nine count columns, defaulting to 0', async () => {
    const executionId = await insertExecution();
    const [row] = await dataSource.query(
      `SELECT progress_seq, pending_count, queued_count, submitted_count, delivered_count,
              bounced_count, failed_count, skipped_count, cancelled_count, reconciled_at
       FROM campaign_execution WHERE id = $1`,
      [executionId],
    );
    expect(row.progress_seq).toBe('0');
    expect(row.pending_count).toBe(0);
    expect(row.queued_count).toBe(0);
    expect(row.submitted_count).toBe(0);
    expect(row.delivered_count).toBe(0);
    expect(row.bounced_count).toBe(0);
    expect(row.failed_count).toBe(0);
    expect(row.skipped_count).toBe(0);
    expect(row.cancelled_count).toBe(0);
    expect(row.reconciled_at).toBeNull();
  });

  it('campaign_execution_counts_non_negative rejects a negative count with 23514', async () => {
    const executionId = await insertExecution();
    await expect(
      dataSource.query(`UPDATE campaign_execution SET delivered_count = -1 WHERE id = $1`, [executionId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('campaign_execution_counts_non_negative rejects a negative progress_seq with 23514', async () => {
    const executionId = await insertExecution();
    await expect(
      dataSource.query(`UPDATE campaign_execution SET progress_seq = -1 WHERE id = $1`, [executionId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('progress_seq and counts are independently writable (not frozen columns)', async () => {
    const executionId = await insertExecution();
    await expect(
      dataSource.query(
        `UPDATE campaign_execution SET progress_seq = progress_seq + 1, submitted_count = 5 WHERE id = $1 RETURNING progress_seq, submitted_count`,
        [executionId],
      ),
    ).resolves.toBeDefined();
    const [row] = await dataSource.query(`SELECT progress_seq, submitted_count FROM campaign_execution WHERE id = $1`, [executionId]);
    expect(row.progress_seq).toBe('1');
    expect(row.submitted_count).toBe(5);
  });

  it('reconcilable_campaign_executions() is executable by eow_app and refuses PUBLIC', async () => {
    const appDataSource = createDataSource(testAppDatabaseUrl());
    await appDataSource.initialize();
    try {
      await expect(appDataSource.query('SELECT * FROM reconcilable_campaign_executions(10)')).resolves.toBeDefined();
    } finally {
      await appDataSource.destroy();
    }
    const [row] = await dataSource.query(
      `SELECT has_function_privilege('public', 'reconcilable_campaign_executions(integer)', 'execute') AS public_can_execute`,
    );
    expect(row.public_can_execute).toBe(false);
  });

  it('reconcilable_campaign_executions() returns a sending execution', async () => {
    const executionId = await insertExecution();
    const rows = await dataSource.query('SELECT id::text FROM reconcilable_campaign_executions(200)');
    expect(rows.some((row: { id: string }) => row.id === executionId)).toBe(true);
  });

  it('reconcilable_campaign_executions() returns an execution finished within 7 days, excludes one finished 8 days ago', async () => {
    const recentId = await insertExecution();
    await dataSource.query(
      `UPDATE campaign_execution SET status = 'completed', finished_at = now() - interval '1 day' WHERE id = $1`,
      [recentId],
    );
    const staleId = await insertExecution();
    await dataSource.query(
      `UPDATE campaign_execution SET status = 'completed', finished_at = now() - interval '8 days' WHERE id = $1`,
      [staleId],
    );

    const rows = await dataSource.query('SELECT id::text FROM reconcilable_campaign_executions(200)');
    const ids = rows.map((row: { id: string }) => row.id);
    expect(ids).toContain(recentId);
    expect(ids).not.toContain(staleId);
  });
});
