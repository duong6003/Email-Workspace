import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { AudienceSkipReason } from '../../campaigns/audience-resolution.js';

export type CampaignRecipientEligibility = 'sendable' | 'skipped';

/**
 * Reuses M4-S2's AudienceSkipReason union rather than restating its values,
 * plus the one new value this node introduces: the durable form of M4-S3's
 * waiver decision (a recipient frozen into the send set despite a missing
 * required variable, because the campaign's audience waiver covered them).
 */
export type CampaignRecipientSkipReason = AudienceSkipReason | 'missing_required_variable';

export type FrozenEmail = {
  subject: string;
  html: string;
  textBody: string;
};

/**
 * M4-S4 (BR-CMP-007, A5): one row per person frozen into a campaign_snapshot.
 * The frozen half (snapshotId, campaignId, recipientId, recipientEmail, mergeDataJson,
 * emailSnapshot, eligibility, skippedReason) is immutable by trigger (022);
 * the send-progress half (status, providerMessageId, lastErrorCode,
 * updatedAt) stays writable for M5-S3's delivery pipeline.
 */
@Entity({ name: 'campaign_recipient' })
@Index(['tenantId', 'snapshotId', 'eligibility'])
export class CampaignRecipientEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId!: string;

  @Column({ name: 'snapshot_id', type: 'uuid' })
  snapshotId!: string;

  @Column({ name: 'recipient_id', type: 'uuid' })
  recipientId!: string;

  @Column({ name: 'recipient_email', type: 'text' })
  recipientEmail!: string;

  @Column({ name: 'merge_data_json', type: 'jsonb' })
  mergeDataJson!: Record<string, unknown>;

  @Column({ name: 'email_snapshot', type: 'jsonb', default: { subject: '', html: '', textBody: '' } })
  emailSnapshot!: FrozenEmail;

  @Column({ type: 'text', default: 'sendable' })
  eligibility!: CampaignRecipientEligibility;

  @Column({ name: 'skipped_reason', type: 'text', nullable: true })
  skippedReason!: CampaignRecipientSkipReason | null;

  @Column({ type: 'text', default: 'queued' })
  status!: string;

  @Column({ name: 'provider_message_id', type: 'text', nullable: true })
  providerMessageId!: string | null;

  @Column({ name: 'last_error_code', type: 'text', nullable: true })
  lastErrorCode!: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
