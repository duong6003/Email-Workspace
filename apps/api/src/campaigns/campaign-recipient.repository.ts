import type { EntityManager } from 'typeorm';
import { CampaignRecipientEntity } from '../database/entities/campaign-recipient.entity.js';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';

/**
 * M4-S4 (BR-CMP-007): the bulk-insert boundary for frozen campaign_recipient
 * rows. Extends TenantScopedRepository (ARCH-TENANT) so the freeze's bulk
 * write goes through the same tenant-stamping primitive every other write in
 * this codebase does, rather than a bare manager.getRepository().insert().
 */
export class CampaignRecipientRepository extends TenantScopedRepository<CampaignRecipientEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(CampaignRecipientEntity), tenantId);
  }
}
