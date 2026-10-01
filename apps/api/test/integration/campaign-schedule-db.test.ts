import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testDatabaseUrl } from './test-database-url.js';

/**
 * M5-S2 CP1b, RED first: migration 024 has not been written yet. Every case
 * here must fail against the current schema before 024 exists, and pass once
 * it lands. Covers the DB-layer half of BR-SCH-005/007/009 only -- the
 * service layer (CampaignsService.scheduleCampaign) is CP3.
 */
describe('Campaign schedule DB layer (M5-S2 CP1b: BR-SCH-005/007/009, migration 024)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;

  const insertDraft = async () => {
    const [row] = await dataSource.query('INSERT INTO campaign (tenant_id, name) VALUES ($1, $2) RETURNING id', [
      tenantA.id,
      `sched-${randomUUID()}`,
    ]);
    return row.id as string;
  };

  const insertScheduled = async () => {
    const [row] = await dataSource.query(
      "INSERT INTO campaign (tenant_id, name, status, scheduled_at_utc, scheduled_timezone) VALUES ($1, $2, 'scheduled', now() + interval '1 hour', 'Asia/Ho_Chi_Minh') RETURNING id",
      [tenantA.id, `sched-${randomUUID()}`],
    );
    return row.id as string;
  };

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenantA = await dataSource.getRepository(TenantEntity).save({ name: `campaign-schedule-db-${randomUUID()}` });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = $1', [tenantA.id]);
    await dataSource.getRepository(TenantEntity).delete(tenantA.id);
    await dataSource.destroy();
  });

  it('BR-SCH-007/009: campaign_status_known admits missed and blocked', async () => {
    await expect(
      dataSource.query("INSERT INTO campaign (tenant_id, name, status) VALUES ($1, $2, 'missed')", [tenantA.id, `sched-${randomUUID()}`]),
    ).resolves.toBeDefined();
    await expect(
      dataSource.query("INSERT INTO campaign (tenant_id, name, status) VALUES ($1, $2, 'blocked')", [tenantA.id, `sched-${randomUUID()}`]),
    ).resolves.toBeDefined();
  });

  it('BR-SCH-002: campaign_schedule_complete rejects a half-set schedule', async () => {
    await expect(
      dataSource.query(
        "INSERT INTO campaign (tenant_id, name, scheduled_at_utc) VALUES ($1, $2, now() + interval '1 hour')",
        [tenantA.id, `sched-${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      dataSource.query(
        "INSERT INTO campaign (tenant_id, name, scheduled_timezone) VALUES ($1, $2, 'Asia/Ho_Chi_Minh')",
        [tenantA.id, `sched-${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(insertScheduled()).resolves.toBeDefined();
  });

  it('BR-SCH-007: campaign_delay_seconds_nonnegative rejects a negative delay', async () => {
    const id = await insertDraft();
    await expect(
      dataSource.query('UPDATE campaign SET delay_seconds = -1 WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      dataSource.query('UPDATE campaign SET delay_seconds = 0 WHERE id = $1', [id]),
    ).resolves.toBeDefined();
  });

  it('R1 canary: schedule columns are writable on the draft->scheduled transition itself', async () => {
    const id = await insertDraft();
    await expect(
      dataSource.query(
        "UPDATE campaign SET status = 'scheduled', scheduled_at_utc = now() + interval '1 hour', scheduled_timezone = 'Asia/Ho_Chi_Minh' WHERE id = $1",
        [id],
      ),
    ).resolves.toBeDefined();
  });

  it('BR-SCH-005: an in-place schedule-time change while status remains scheduled raises 55000', async () => {
    const id = await insertScheduled();
    await expect(
      dataSource.query("UPDATE campaign SET scheduled_at_utc = now() + interval '2 hour' WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('R1 canary: schedule columns may be cleared on scheduled->cancelled and scheduled->missed', async () => {
    const cancelled = await insertScheduled();
    await expect(
      dataSource.query("UPDATE campaign SET status = 'cancelled', scheduled_at_utc = NULL, scheduled_timezone = NULL WHERE id = $1", [cancelled]),
    ).resolves.toBeDefined();

    const missed = await insertScheduled();
    await expect(
      dataSource.query("UPDATE campaign SET status = 'missed', scheduled_at_utc = NULL, scheduled_timezone = NULL WHERE id = $1", [missed]),
    ).resolves.toBeDefined();
  });

  it('existing content-freeze guard still applies while sending (022 behaviour preserved)', async () => {
    const id = await insertDraft();
    await dataSource.query("UPDATE campaign SET status = 'sending' WHERE id = $1", [id]);
    await expect(
      dataSource.query("UPDATE campaign SET subject = 'blocked' WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: '55000' });
  });
});
