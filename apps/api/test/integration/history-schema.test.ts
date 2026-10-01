import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { testDatabaseUrl } from './test-database-url.js';

/**
 * M6-S3 CP2, RED first: migration 029 has not been written yet. Every case
 * here must fail against the current schema before 029 exists, and pass once
 * it lands. Covers the DB-layer half of BR-HIS-005/003/007 only.
 */
describe('History and recovery DB layer (M6-S3 CP2: migration 029)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
  });
  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('adds resend lineage to campaign_execution', async () => {
    const rows = await dataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'campaign_execution'
         AND column_name IN ('parent_execution_id', 'resend_generation')
       ORDER BY column_name`,
    );
    expect(rows.map((r: { column_name: string }) => r.column_name)).toEqual([
      'parent_execution_id',
      'resend_generation',
    ]);
  });

  it('adds snapshot lineage to campaign_snapshot', async () => {
    const rows = await dataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'campaign_snapshot' AND column_name = 'parent_snapshot_id'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('creates export_job with row level security forced', async () => {
    const [row] = await dataSource.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'export_job'`,
    );
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('grants history:export to admin and operator but not viewer', async () => {
    const rows = await dataSource.query(
      `SELECT r.key FROM role r
       JOIN role_permission rp ON rp.role_id = r.id
       JOIN permission p ON p.id = rp.permission_id
       WHERE p.key = 'history:export' ORDER BY r.key`,
    );
    expect(rows.map((r: { key: string }) => r.key)).toEqual(['admin', 'operator']);
  });
});
