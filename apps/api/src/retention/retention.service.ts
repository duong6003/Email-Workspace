import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { appendAuditLog } from '../common/audit-writer.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { RetentionPolicyEntity } from '../database/entities/retention-policy.entity.js';
import { RetentionPolicyRepository } from './retention.repository.js';
import type { RetentionPolicyDto, RetentionPolicyView } from './dto/retention.dto.js';

export type RetentionActor = { actorId: string; traceId: string };

/**
 * M6-S4 (BR-HIS-006, DEC-141). "Chinh sach cau hinh duoc": one row per
 * tenant, absent row means the deployment default. `source` is what makes
 * "not configured yet" legible without inventing a null on the wire.
 */
@Injectable()
export class RetentionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private defaultDays(): number {
    const configured = Number(process.env.HISTORY_EVENT_RETENTION_DAYS ?? 365);
    return Number.isInteger(configured) && configured >= 30 && configured <= 3650 ? configured : 365;
  }

  getPolicy(tenantId: string): Promise<RetentionPolicyView> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const row = await new RetentionPolicyRepository(manager, tenantId).get();
      return row
        ? { messageEventRetentionDays: row.messageEventRetentionDays, source: 'policy' as const }
        : { messageEventRetentionDays: this.defaultDays(), source: 'default' as const };
    });
  }

  putPolicy(tenantId: string, body: RetentionPolicyDto, actor: RetentionActor): Promise<RetentionPolicyView> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      let row = await new RetentionPolicyRepository(manager, tenantId).get();
      if (!row) row = manager.getRepository(RetentionPolicyEntity).create({ tenantId });
      row.messageEventRetentionDays = body.messageEventRetentionDays;
      row.updatedBy = actor.actorId;
      const saved = await manager.getRepository(RetentionPolicyEntity).save(row);
      await appendAuditLog(manager, {
        tenantId,
        actorId: actor.actorId,
        action: 'retention_policy.updated',
        entityType: 'retention_policy',
        entityId: saved.id,
        traceId: actor.traceId,
        metadata: { messageEventRetentionDays: saved.messageEventRetentionDays },
      });
      return { messageEventRetentionDays: saved.messageEventRetentionDays, source: 'policy' as const };
    });
  }
}
