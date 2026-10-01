import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { runInTenantContext } from '../../src/database/tenant-transaction.js';
import { publishProgressSnapshot, writeProgressSnapshot } from '../../src/campaigns/progress-snapshot.js';
import type { ProgressEvent, ResyncEvent } from '../../src/campaigns/progress-event.js';
import { testAppDatabaseUrl, testDatabaseUrl } from './test-database-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/**
 * M6-S3 CP7 (D-125, found while implementing export creation, not
 * pre-registered). No test file for apps/api's own progress-snapshot.ts
 * existed before this one -- every prior test re-read progress_seq from a
 * fresh SELECT rather than trusting writeProgressSnapshot's own return
 * value, which is exactly how a real bug stayed invisible.
 */
describe('writeProgressSnapshot / publishProgressSnapshot (M6-S3 CP7, D-125)', () => {
  let dataSource: DataSource;
  let tenantId: string;
  let executionId: string;
  let campaignId: string;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();

    const appDataSource = createDataSource(testAppDatabaseUrl());
    await appDataSource.initialize();
    tenantId = (await appDataSource.query(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [`progress-snapshot-db-${randomUUID()}`]))[0].id;
    await appDataSource.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    const template = (await appDataSource.query(`INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`, [tenantId, `psdb-template-${randomUUID()}`]))[0];
    const version = (await appDataSource.query(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, $3, now()) RETURNING id`,
      [tenantId, template.id, createHash('sha256').update(randomUUID()).digest('hex')],
    ))[0];
    campaignId = (await appDataSource.query(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'sending', $3) RETURNING id`,
      [tenantId, `psdb-campaign-${randomUUID()}`, version.id],
    ))[0].id;
    const snapshot = (await appDataSource.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, 0) RETURNING id`,
      [tenantId, campaignId, version.id],
    ))[0];
    executionId = (await appDataSource.query(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status) VALUES ($1, $2, $3, $4, 'sending') RETURNING id`,
      [tenantId, campaignId, snapshot.id, `psdb-${randomUUID()}`],
    ))[0].id;
    await appDataSource.destroy();
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) return;
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_progress_snapshot_db_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        await manager.query('DELETE FROM campaign_execution WHERE tenant_id = $1', [tenantId]);
        await manager.query('DELETE FROM campaign_snapshot WHERE tenant_id = $1', [tenantId]);
      } finally {
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
      }
    });
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = $1', [tenantId]);
    await deleteTemplateVersionFixtures(dataSource, [tenantId]);
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await dataSource.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await dataSource.destroy();
  }, 30_000);

  it('writeProgressSnapshot returns the real, incrementing progress_seq as a number, not NaN', async () => {
    const counts = { pending: 0, queued: 0, submitted: 1, delivered: 0, bounced: 0, failed: 0, skipped: 0, cancelled: 0 };
    const first = await runInTenantContext(dataSource, tenantId, (manager) => writeProgressSnapshot(manager, tenantId, executionId, counts));
    expect(first).toBe(1);
    expect(Number.isNaN(first)).toBe(false);

    const second = await runInTenantContext(dataSource, tenantId, (manager) => writeProgressSnapshot(manager, tenantId, executionId, counts));
    expect(second).toBe(2);
  });

  it('publishProgressSnapshot publishes an envelope whose version is a real number, not null', async () => {
    const captured: Array<ProgressEvent | ResyncEvent> = [];
    await publishProgressSnapshot(dataSource, tenantId, campaignId, executionId, async (event) => { captured.push(event); });

    expect(captured).toHaveLength(1);
    const event = captured[0]!;
    expect(typeof event.version).toBe('number');
    expect(Number.isNaN(event.version)).toBe(false);
    expect(event.version).toBeGreaterThan(0);
    // The JSON-serialised wire payload is what a real subscriber receives --
    // NaN survives in-process but silently becomes null across JSON.stringify,
    // which is the form D-125 would actually have shipped as.
    expect(JSON.parse(JSON.stringify(event)).version).not.toBeNull();
  });
});
