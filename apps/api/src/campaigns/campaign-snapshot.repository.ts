import { IsNull, type EntityManager } from 'typeorm';
import { CampaignSnapshotEntity } from '../database/entities/campaign-snapshot.entity.js';
import type { CampaignRecipientSkipReason } from '../database/entities/campaign-recipient.entity.js';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';

export type CampaignRecipientSkipCount = { reason: CampaignRecipientSkipReason; count: number };

/**
 * M4-S4 (BR-CMP-007): reads and the one legal write over the frozen snapshot
 * -- the live (not yet superseded) row per campaign, and the skipped-reason
 * breakdown cancelCampaign and getCampaignSnapshot both need. Extends
 * TenantScopedRepository (ARCH-TENANT) rather than reaching for
 * manager.getRepository() directly, matching every other repository in this
 * codebase. Never widens into a full save() of the entity for the one legal
 * mutation (superseding); that stays its own narrow method.
 */
export class CampaignSnapshotRepository extends TenantScopedRepository<CampaignSnapshotEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(CampaignSnapshotEntity), tenantId);
  }

  findLive(campaignId: string): Promise<CampaignSnapshotEntity | null> {
    return this.findOne({ campaignId, supersededAt: IsNull() } as never);
  }

  async supersede(id: string, supersededAt: Date): Promise<void> {
    await this.repository.update({ id, tenantId: this.tenantId }, { supersededAt });
  }

  async skippedByReason(snapshotId: string): Promise<CampaignRecipientSkipCount[]> {
    return this.repository.manager.query(
      `SELECT skipped_reason AS reason, count(*)::int AS count
       FROM campaign_recipient
       WHERE tenant_id = $1 AND snapshot_id = $2 AND eligibility = 'skipped'
       GROUP BY skipped_reason
       ORDER BY count DESC`,
      [this.tenantId, snapshotId],
    ) as Promise<CampaignRecipientSkipCount[]>;
  }
}
