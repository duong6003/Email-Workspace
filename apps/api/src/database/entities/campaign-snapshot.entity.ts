import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { CampaignAudience, CampaignAudienceWaiver, CampaignSender } from './campaign.entity.js';
import type { TemplateVariableSchema } from './email-template-version.entity.js';
import type { MissingVariableBreakdown } from '../../campaigns/variable-validation.js';

/**
 * The frozen equivalent of M4-S3's VariableValidationResult, minus the
 * per-recipient sample/id list that never needed to survive past the
 * validate-audience response (see variable-validation.ts's own comment on
 * missingRecipientIds) -- a snapshot only needs the durable audit shape.
 */
export type SnapshotPolicyResult = {
  totalActionable: number;
  completeCount: number;
  missingCount: number;
  missingByVariable: MissingVariableBreakdown[];
  waiver: CampaignAudienceWaiver | null;
  webOrigin: string;
};

/**
 * M4-S4 (BR-CMP-007, A5): the frozen send set. campaign_id is UNIQUE only
 * among *live* (supersededAt IS NULL) rows -- see migration 022's partial
 * index -- so a refresh can create a new row without deleting the old one.
 * Immutable once written: a PostgreSQL trigger (022) rejects any UPDATE
 * other than setting supersededAt, and rejects DELETE outright, both with
 * ERRCODE 55000.
 */
@Entity({ name: 'campaign_snapshot' })
@Index(['tenantId', 'campaignId'])
export class CampaignSnapshotEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId!: string;

  @Column({ name: 'template_version_id', type: 'uuid' })
  templateVersionId!: string;

  @Column({ name: 'sender_json', type: 'jsonb' })
  senderJson!: CampaignSender;

  @Column({ name: 'audience_query_json', type: 'jsonb' })
  audienceQueryJson!: CampaignAudience;

  @Column({ name: 'policy_result_json', type: 'jsonb' })
  policyResultJson!: SnapshotPolicyResult;

  @Column({ name: 'variable_schema_json', type: 'jsonb', default: { required: [], optional: [] } })
  variableSchemaJson!: TemplateVariableSchema;

  @Column({ name: 'configured_variable_values_json', type: 'jsonb', default: {} })
  configuredVariableValuesJson!: Record<string, unknown>;

  @Column({ name: 'total_snapshot', type: 'integer', default: 0 })
  totalSnapshot!: number;

  @Column({ name: 'sendable_count', type: 'integer', default: 0 })
  sendableCount!: number;

  @Column({ name: 'skipped_count', type: 'integer', default: 0 })
  skippedCount!: number;

  @Column({ name: 'frozen_by', type: 'uuid', nullable: true })
  frozenBy!: string | null;

  @Column({ name: 'frozen_at', type: 'timestamptz' })
  frozenAt!: Date;

  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  /** M6-S3 (BR-HIS-005, ADR-027, migration 029). Null for every root snapshot; set only on a resend's child. */
  @Column({ name: 'parent_snapshot_id', type: 'uuid', nullable: true })
  parentSnapshotId!: string | null;
}
