import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { IdempotencyKeyEntity } from '../database/entities/idempotency-key.entity.js';
import { metrics } from '../observability/metrics-registry.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function canonicalizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizePayload(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined && typeof item !== 'function' && typeof item !== 'symbol')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizePayload(item)]),
    );
  }
  return value;
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalizePayload(payload) ?? null)).digest('hex');
}

export type IdempotentResult<T> = { replayed: boolean; value: T };

/**
 * BR-GEN-005: "Gửi lại cùng key và payload không tạo bản ghi/job thứ hai;
 * khác payload với cùng key trả 409." Backed by the pre-existing
 * idempotency_key table (002_identity_and_audit.sql), keyed
 * (tenant_id, key). M2-S4 is the first node with a real qualifying
 * endpoint (import/bulk-update job creation), closing the rule for real.
 *
 * Concurrency note: the INSERT ... ON CONFLICT DO NOTHING below is the
 * mutex -- only one concurrent request for a given (tenantId, key) wins the
 * insert and proceeds to call `create`; a second request arriving after the
 * first has inserted its placeholder but before `create` has written
 * response_json will see an existing row with response_json IS NULL and is
 * told to retry shortly rather than double-creating the job. This is a
 * best-effort guard for the literal-race case; the primary correctness
 * guarantee (no second job row) comes from the same-payload replay path.
 */
@Injectable()
export class IdempotencyService {
  async replay<T extends { id: string }>(manager: EntityManager, tenantId: string, key: string | undefined, payload: unknown): Promise<T | null> {
    if (!key) return null;
    const existing = await manager.getRepository(IdempotencyKeyEntity).findOne({ where: { tenantId, key } });
    if (existing && existing.requestHash !== hashPayload(payload)) {
      throw new ConflictException('Idempotency-Key reused with a different request payload.');
    }
    return existing?.responseJson ? existing.responseJson as unknown as T : null;
  }

  async run<T extends { id: string }>(
    manager: EntityManager,
    tenantId: string,
    key: string | undefined,
    resourceType: string,
    payload: unknown,
    create: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    if (!key) {
      const value = await create();
      return { replayed: false, value };
    }

    const requestHash = hashPayload(payload);
    const repo = manager.getRepository(IdempotencyKeyEntity);

    const existing = await repo.findOne({ where: { tenantId, key } });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException('Idempotency-Key reused with a different request payload.');
      }
      if (existing.responseJson) {
        metrics.idempotentReplay(resourceType);
        return { replayed: true, value: existing.responseJson as unknown as T };
      }
      throw new ConflictException('A request with this Idempotency-Key is already being processed.');
    }

    const insertResult = await repo
      .createQueryBuilder()
      .insert()
      .into(IdempotencyKeyEntity)
      .values({
        tenantId,
        key,
        requestHash,
        resourceType,
        expiresAt: new Date(Date.now() + DEFAULT_TTL_MS),
      } as never)
      .orIgnore()
      .execute();

    // Re-read: only the request that inserted the placeholder may create
    // the resource. A concurrent request that lost INSERT ... DO NOTHING
    // must wait/retry; proceeding whenever response_json is null would let
    // both requests create a job during the narrow write window.
    const afterInsert = await repo.findOne({ where: { tenantId, key } });
    if (afterInsert && afterInsert.requestHash !== requestHash) {
      throw new ConflictException('Idempotency-Key reused with a different request payload.');
    }
    if (afterInsert?.responseJson) {
      metrics.idempotentReplay(resourceType);
      return { replayed: true, value: afterInsert.responseJson as unknown as T };
    }
    if (insertResult.identifiers.length === 0) {
      throw new ConflictException('A request with this Idempotency-Key is already being processed.');
    }

    const value = await create();
    await repo.update({ tenantId, key }, { resourceId: value.id, responseJson: value as unknown as Record<string, unknown> } as never);
    return { replayed: false, value };
  }
}
