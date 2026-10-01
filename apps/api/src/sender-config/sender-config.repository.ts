import type { EntityManager } from 'typeorm';
import { SenderConfigEntity } from '../database/entities/sender-config.entity.js';
import { SendingPolicyEntity } from '../database/entities/sending-policy.entity.js';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';
export class SenderConfigRepository extends TenantScopedRepository<SenderConfigEntity> {
  constructor(manager: EntityManager, tenantId: string) { super(manager.getRepository(SenderConfigEntity), tenantId); }
  list() { return this.repository.createQueryBuilder('s').where('s.tenant_id = :tenantId AND s.deleted_at IS NULL', { tenantId: this.tenantId }).orderBy('s.created_at', 'DESC').getMany(); }
  findActiveById(id: string) { return this.repository.createQueryBuilder('s').where('s.id = :id AND s.tenant_id = :tenantId AND s.deleted_at IS NULL', { id, tenantId: this.tenantId }).getOne(); }
}
export class SendingPolicyRepository extends TenantScopedRepository<SendingPolicyEntity> {
  constructor(manager: EntityManager, tenantId: string) { super(manager.getRepository(SendingPolicyEntity), tenantId); }
  get() { return this.repository.findOne({ where: { tenantId: this.tenantId } }); }
}
