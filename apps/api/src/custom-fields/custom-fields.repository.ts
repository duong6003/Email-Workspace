import type { EntityManager } from 'typeorm';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';
import { CustomFieldDefinitionEntity } from '../database/entities/custom-field-definition.entity.js';

/**
 * Plain class (not a NestJS DI provider), same pattern
 * apps/api/src/recipients/recipients.repository.ts established: a
 * REQUEST-scoped TenantContext injected into another REQUEST-scoped
 * provider caused a real, reproduced false 401 in M2-S1 (see that file's
 * "KNOWN HAZARD" comment). CustomFieldsService constructs this per call
 * with tenantId read from the controller's already-guarded
 * request.auth.tenantId. The supplied EntityManager is the transaction
 * manager whose transaction-local RLS context has already been set.
 */
export class CustomFieldsRepository extends TenantScopedRepository<CustomFieldDefinitionEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(CustomFieldDefinitionEntity), tenantId);
  }

  async list(): Promise<CustomFieldDefinitionEntity[]> {
    return this.repository
      .createQueryBuilder('field')
      .where('field.tenant_id = :tenantId', { tenantId: this.tenantId })
      .orderBy('field.created_at', 'ASC')
      .getMany();
  }

  async findById(id: string): Promise<CustomFieldDefinitionEntity | null> {
    return this.repository
      .createQueryBuilder('field')
      .where('field.tenant_id = :tenantId', { tenantId: this.tenantId })
      .andWhere('field.id = :id', { id })
      .getOne();
  }

  async findByKey(fieldKey: string): Promise<CustomFieldDefinitionEntity | null> {
    return this.repository
      .createQueryBuilder('field')
      .where('field.tenant_id = :tenantId', { tenantId: this.tenantId })
      .andWhere('field.field_key = :fieldKey', { fieldKey })
      .getOne();
  }

  async remove(id: string): Promise<void> {
    await this.repository
      .createQueryBuilder()
      .delete()
      .from(CustomFieldDefinitionEntity)
      .where('tenant_id = :tenantId', { tenantId: this.tenantId })
      .andWhere('id = :id', { id })
      .execute();
  }
}
