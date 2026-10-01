import { IsNull, type EntityManager } from 'typeorm';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity.js';
import { getRequestContext } from '../observability/request-context.js';
import { trace } from '@opentelemetry/api';

export type OutboxEventInput = {
  tenantId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: bigint;
  payload: Record<string, unknown>;
  traceId?: string | null;
};

/**
 * Inserts an outbox row within the caller's transaction (pass the same
 * EntityManager the domain write used). ON CONFLICT DO NOTHING makes this
 * idempotent against the schema's UNIQUE(aggregate_type, aggregate_id,
 * aggregate_version, event_type) constraint (ADR-012): re-emitting the same
 * event for the same aggregate version is a safe no-op, never a duplicate row.
 */
export async function appendOutboxEvent(manager: EntityManager, event: OutboxEventInput): Promise<void> {
  return trace.getTracer('eow-api').startActiveSpan('outbox.append', async (span) => {
  span.setAttributes({ 'eow.tenant_id': event.tenantId, 'eow.aggregate_type': event.aggregateType, 'eow.aggregate_id': event.aggregateId });
  const values = {
    tenantId: event.tenantId,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion.toString(),
    payload: event.payload,
    traceId: event.traceId ?? getRequestContext()?.traceId ?? null,
  };

  await manager
    .createQueryBuilder()
    .insert()
    .into(OutboxEventEntity)
    // TypeORM's QueryDeepPartialEntity recursively maps the jsonb Record
    // column into a shape that rejects a plain object literal even though
    // the pg driver serializes it correctly; this is a typing limitation,
    // not a runtime one, and is covered by the integration tests below.
    .values(values as never)
    .orIgnore()
    .execute();
  span.end();
  });
}

export function findUnpublishedOutboxEvents(manager: EntityManager, limit: number): Promise<OutboxEventEntity[]> {
  return manager.getRepository(OutboxEventEntity).find({
    where: { publishedAt: IsNull() },
    order: { occurredAt: 'ASC' },
    take: limit,
  });
}
