import type { EntityManager } from 'typeorm';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';
import { RecipientListEntity } from '../database/entities/recipient-list.entity.js';
import { TagEntity } from '../database/entities/tag.entity.js';

export class RecipientListsRepository extends TenantScopedRepository<RecipientListEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(RecipientListEntity), tenantId);
  }

  findActiveById(id: string): Promise<RecipientListEntity | null> {
    return this.repository
      .createQueryBuilder('segment')
      .where('segment.id = :id AND segment.tenant_id = :tenantId AND segment.deleted_at IS NULL', {
        id,
        tenantId: this.tenantId,
      })
      .getOne();
  }
}

export class TagsRepository extends TenantScopedRepository<TagEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(TagEntity), tenantId);
  }

  findActiveById(id: string): Promise<TagEntity | null> {
    return this.repository
      .createQueryBuilder('segment')
      .where('segment.id = :id AND segment.tenant_id = :tenantId AND segment.deleted_at IS NULL', {
        id,
        tenantId: this.tenantId,
      })
      .getOne();
  }
}
