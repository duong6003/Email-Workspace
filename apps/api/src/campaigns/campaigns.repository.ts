import type { EntityManager } from 'typeorm';
import { CampaignEntity } from '../database/entities/campaign.entity.js';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';

export class CampaignsRepository extends TenantScopedRepository<CampaignEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(CampaignEntity), tenantId);
  }

  findActiveById(id: string, lock = false): Promise<CampaignEntity | null> {
    const query = this.repository.createQueryBuilder('campaign')
      .where('campaign.id = :id AND campaign.tenant_id = :tenantId AND campaign.deleted_at IS NULL', { id, tenantId: this.tenantId });
    if (lock) query.setLock('pessimistic_write');
    return query.getOne();
  }

  listDrafts(status: CampaignEntity['status'] = 'draft', limit = 50, ownerId?: string | null): Promise<CampaignEntity[]> {
    const query = this.repository.createQueryBuilder('campaign')
      .where('campaign.tenant_id = :tenantId AND campaign.deleted_at IS NULL AND campaign.status = :status', { tenantId: this.tenantId, status })
      .orderBy('campaign.updated_at', 'DESC')
      .addOrderBy('campaign.id', 'DESC')
      .take(limit);
    if (ownerId !== undefined) query.andWhere('campaign.created_by = :ownerId', { ownerId });
    return query.getMany();
  }
}
