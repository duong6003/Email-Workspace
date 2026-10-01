import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { OutboxEventEntity } from '../../src/database/entities/outbox-event.entity.js';
import { appendOutboxEvent } from '../../src/outbox/outbox-writer.js';
import { runWithRequestContext } from '../../src/observability/request-context.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testDatabaseUrl } from './test-database-url.js';

describe('BR-SEND-013 outbox trace propagation', () => {
  let dataSource: DataSource;
  let tenantId: string;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url: testDatabaseUrl(), entities: [TenantEntity, OutboxEventEntity] });
    await dataSource.initialize();
    const tenant = await dataSource.getRepository(TenantEntity).save({ name: `trace-propagation-${randomUUID()}` });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM outbox_event WHERE tenant_id = $1', [tenantId]);
    await dataSource.getRepository(TenantEntity).delete({ id: tenantId });
    await dataSource.destroy();
  });

  it('writes the ambient request trace_id into the committed outbox row', async () => {
    const traceId = randomUUID();
    const aggregateId = randomUUID();
    await dataSource.transaction((manager) => runWithRequestContext({ traceId, tenantId }, () => appendOutboxEvent(manager, {
      tenantId,
      eventType: 'observability.trace_probe',
      aggregateType: 'campaign',
      aggregateId,
      aggregateVersion: 1n,
      payload: { aggregateId },
    })));

    const [row] = await dataSource.query(`SELECT trace_id FROM outbox_event WHERE tenant_id = $1 AND aggregate_id = $2`, [tenantId, aggregateId]);
    expect(row.trace_id).toBe(traceId);
  });
});
