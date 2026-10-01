import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { OutboxEventEntity } from '../../src/database/entities/outbox-event.entity.js';
import { appendOutboxEvent, findUnpublishedOutboxEvents } from '../../src/outbox/outbox-writer.js';
import { testDatabaseUrl } from './test-database-url.js';

describe('outbox writer', () => {
  let dataSource: DataSource;
  let tenant: TenantEntity;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `outbox-test-${randomUUID()}` });
  });

  afterAll(async () => {
    await dataSource.getRepository(OutboxEventEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(TenantEntity).delete(tenant.id);
    await dataSource.destroy();
  });

  it('appends a new event with published_at null and attempts 0', async () => {
    const aggregateId = randomUUID();

    await appendOutboxEvent(dataSource.manager, {
      tenantId: tenant.id,
      eventType: 'campaign.state_changed',
      aggregateType: 'campaign',
      aggregateId,
      aggregateVersion: 1n,
      payload: { status: 'scheduled' },
    });

    const rows = await dataSource.getRepository(OutboxEventEntity).find({ where: { aggregateId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].publishedAt).toBeNull();
    expect(rows[0].attempts).toBe(0);
  });

  it('is idempotent: appending the same aggregate+version+type twice creates only one row', async () => {
    const aggregateId = randomUUID();
    const event = {
      tenantId: tenant.id,
      eventType: 'campaign.state_changed',
      aggregateType: 'campaign',
      aggregateId,
      aggregateVersion: 1n,
      payload: { status: 'scheduled' },
    };

    await appendOutboxEvent(dataSource.manager, event);
    await appendOutboxEvent(dataSource.manager, { ...event, payload: { status: 'scheduled-retry' } });

    const rows = await dataSource.getRepository(OutboxEventEntity).find({ where: { aggregateId } });
    expect(rows).toHaveLength(1);
  });

  it('findUnpublishedOutboxEvents only returns rows with published_at IS NULL', async () => {
    const aggregateId = randomUUID();
    await appendOutboxEvent(dataSource.manager, {
      tenantId: tenant.id,
      eventType: 'campaign.progress',
      aggregateType: 'campaign',
      aggregateId,
      aggregateVersion: 1n,
      payload: {},
    });
    await dataSource.getRepository(OutboxEventEntity).update({ aggregateId }, { publishedAt: new Date() });

    const unpublished = await findUnpublishedOutboxEvents(dataSource.manager, 100);

    expect(unpublished.some((row) => row.aggregateId === aggregateId)).toBe(false);
  });
});
