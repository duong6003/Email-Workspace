import type { EntityManager } from 'typeorm';
import { AuditLogEntity } from '../database/entities/audit-log.entity.js';

export type AuditLogInput = {
  tenantId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  traceId: string;
  metadata?: Record<string, unknown>;
};

/**
 * Appends an audit_log row within the caller's transaction. Every auth and
 * config action must carry trace_id + tenant_id (EXECPLAN §14 / M1-S3), and
 * M1-S1 is the first slice that writes rows, so the helper lands here.
 */
export async function appendAuditLog(manager: EntityManager, entry: AuditLogInput): Promise<void> {
  await manager.getRepository(AuditLogEntity).save({
    tenantId: entry.tenantId,
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    traceId: entry.traceId,
    metadata: entry.metadata ?? {},
    occurredAt: new Date(),
  });
}
