import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Full BR-SEND-001 state domain; kept in lockstep with migration 024 and OpenAPI. */
export type CampaignStatus = 'draft' | 'scheduled' | 'blocked' | 'missed' | 'queued' | 'validating' | 'sending' | 'paused' | 'completed' | 'partial_failed' | 'failed' | 'cancelled';

export type CampaignSender = {
  senderConfigId?: string | null;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string | null;
};

export type CampaignAudience = {
  listIds?: string[];
  tagIds?: string[];
  recipientIds?: string[];
  excludeListIds?: string[];
  excludeTagIds?: string[];
  excludeRecipientIds?: string[];
};

/**
 * M4-S3 (BR-CMP-005): "the decision is audited" without inventing snapshot
 * infrastructure (M4-S4 owns that) -- the accepted resolution is persisted
 * additively on the draft itself, server-computed only (never
 * client-supplied, see campaigns.controller.ts's acceptAudienceWaiver).
 */
export type CampaignAudienceWaiver = {
  acceptedAt: string;
  acceptedBy: string | null;
  missingVariableRecipientIds: string[];
};

export type CampaignSettings = {
  cc?: string[];
  bcc?: string[];
  variableOverrides?: Record<string, unknown>;
  audienceWaiver?: CampaignAudienceWaiver;
};

@Entity({ name: 'campaign' })
@Index(['tenantId', 'status', 'updatedAt'])
export class CampaignEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', default: 'draft' })
  status!: CampaignStatus;

  @Column({ type: 'text', default: '' })
  subject!: string;

  @Column({ name: 'template_id', type: 'uuid', nullable: true })
  templateId!: string | null;

  @Column({ name: 'template_version_id', type: 'uuid', nullable: true })
  templateVersionId!: string | null;

  @Column({ name: 'sender_json', type: 'jsonb', default: {} })
  senderJson!: CampaignSender;

  @Column({ name: 'audience_json', type: 'jsonb', default: {} })
  audienceJson!: CampaignAudience;

  @Column({ name: 'settings_json', type: 'jsonb', default: {} })
  settingsJson!: CampaignSettings;

  @Column({ name: 'scheduled_at_utc', type: 'timestamptz', nullable: true })
  scheduledAtUtc!: Date | null;

  @Column({ name: 'scheduled_timezone', type: 'text', nullable: true })
  scheduledTimezone!: string | null;

  @Column({
    type: 'bigint',
    default: 0,
    transformer: {
      to: (value: number) => value,
      from: (value: string | number) => Number(value),
    },
  })
  version!: number;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
