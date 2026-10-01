import type { EntityManager } from 'typeorm';
import { RetentionPolicyEntity } from '../database/entities/retention-policy.entity.js';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';
export class RetentionPolicyRepository extends TenantScopedRepository<RetentionPolicyEntity> {
  constructor(manager: EntityManager, tenantId: string) { super(manager.getRepository(RetentionPolicyEntity), tenantId); }
  get() { return this.repository.findOne({ where: { tenantId: this.tenantId } }); }
}
