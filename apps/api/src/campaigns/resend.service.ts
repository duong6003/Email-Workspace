import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { appendAuditLog } from '../common/audit-writer.js';
import type { CampaignEntity } from '../database/entities/campaign.entity.js';
import { CampaignSnapshotRepository } from './campaign-snapshot.repository.js';
import { CampaignsRepository } from './campaigns.repository.js';
import type { CampaignActor } from './campaigns.types.js';

export type ResendResult = {
  /** IdempotencyService.run<T extends {id:string}>'s own bookkeeping key -- stripped by the caller before returning to the controller, the same convention cancelCampaignSend already uses. */
  id: string;
  campaignId: string;
  executionId: string;
  snapshotId: string;
  parentExecutionId: string;
  resendGeneration: number;
  recipientCount: number;
};

/**
 * BR-HIS-005 (ADR-027, DEC-133). Creates a *new* snapshot generation over
 * the parent execution's failed sendable recipients only, superseding the
 * parent snapshot and linking `parent_execution_id` -- never reuses the
 * parent snapshot (see ADR-027's own four-constraint rationale: the DAG
 * idempotency key, snapshot-scoped progress counting, per-snapshot
 * recipient uniqueness, and the worker's own live-snapshot join all
 * depend on this).
 *
 * The child execution's row is inserted here at `status='validating'`,
 * the exact shape `runValidation`'s own `INSERT ... ON CONFLICT
 * (campaign_id, snapshot_id) DO NOTHING` expects to find already claimed --
 * the worker's scan picks this campaign up once `campaign.status='queued'`
 * (set last, below) with zero changes to `apps/worker`.
 *
 * The caller is responsible for loading `campaign` with a pessimistic
 * write lock inside its own `runInTenantContext` transaction, the same
 * contract `freezeCampaignSnapshot` documents.
 */
export async function resendFailedRecipients(
  manager: EntityManager,
  tenantId: string,
  campaign: CampaignEntity,
  actor: CampaignActor,
): Promise<ResendResult> {
  if (campaign.status !== 'partial_failed' && campaign.status !== 'failed') {
    throw new ConflictException('Campaign cannot be resent unless it is partial_failed or failed.');
  }

  const snapshotRepository = new CampaignSnapshotRepository(manager, tenantId);
  const parentSnapshot = await snapshotRepository.findLive(campaign.id);
  if (!parentSnapshot) throw new NotFoundException('No live snapshot found for this campaign.');

  const [parentExecution] = (await manager.query(
    `SELECT id, resend_generation FROM campaign_execution WHERE tenant_id = $1 AND snapshot_id = $2`,
    [tenantId, parentSnapshot.id],
  )) as Array<{ id: string; resend_generation: number }>;
  if (!parentExecution) throw new NotFoundException("No execution found for this campaign's live snapshot.");

  // BR-HIS-005's own resend scope: failed, sendable recipients of the parent.
  const failedRecipients = (await manager.query(
    `SELECT recipient_id, recipient_email, merge_data_json, email_snapshot
     FROM campaign_recipient
     WHERE tenant_id = $1 AND snapshot_id = $2 AND eligibility = 'sendable' AND status = 'failed'`,
    [tenantId, parentSnapshot.id],
  )) as Array<{ recipient_id: string; recipient_email: string; merge_data_json: unknown; email_snapshot: unknown }>;
  if (failedRecipients.length === 0) {
    throw new ConflictException('Campaign has no failed recipients to resend.');
  }

  // The parent must be fully terminal: partition.ts claims by campaign_id
  // without an execution scope, so a resend started while the parent still
  // had claimable rows could let one partition pass straddle both
  // executions.
  const [stillClaimable] = (await manager.query(
    `SELECT count(*)::int AS count FROM campaign_recipient
     WHERE tenant_id = $1 AND snapshot_id = $2 AND eligibility = 'sendable' AND status IN ('pending', 'queued')`,
    [tenantId, parentSnapshot.id],
  )) as Array<{ count: number }>;
  if (stillClaimable.count > 0) {
    throw new ConflictException('Campaign still has pending or queued recipients; resend is only for a fully terminal execution.');
  }

  const supersededAt = new Date();
  await snapshotRepository.supersede(parentSnapshot.id, supersededAt);

  const childSnapshot = await snapshotRepository.save({
    campaignId: campaign.id,
    templateVersionId: parentSnapshot.templateVersionId,
    senderJson: parentSnapshot.senderJson,
    audienceQueryJson: parentSnapshot.audienceQueryJson,
    policyResultJson: parentSnapshot.policyResultJson,
    variableSchemaJson: parentSnapshot.variableSchemaJson,
    configuredVariableValuesJson: parentSnapshot.configuredVariableValuesJson,
    totalSnapshot: failedRecipients.length,
    sendableCount: failedRecipients.length,
    skippedCount: 0,
    frozenBy: actor.actorId,
    frozenAt: supersededAt,
    supersededAt: null,
    parentSnapshotId: parentSnapshot.id,
  });

  for (const row of failedRecipients) {
    await manager.query(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, recipient_email, merge_data_json, email_snapshot, eligibility, skipped_reason, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'sendable', NULL, 'pending')`,
      [tenantId, campaign.id, childSnapshot.id, row.recipient_id, row.recipient_email, JSON.stringify(row.merge_data_json), JSON.stringify(row.email_snapshot)],
    );
  }

  const [childExecution] = (await manager.query(
    `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, status, correlation_id, parent_execution_id, resend_generation, batch_size, max_attempts, sender_config_id)
     SELECT $1, $2, $3, 'validating', $4, $5, $6, ce.batch_size, ce.max_attempts, ce.sender_config_id
     FROM campaign_execution ce WHERE ce.id = $5
     RETURNING id`,
    [tenantId, campaign.id, childSnapshot.id, `resend-${randomUUID()}`, parentExecution.id, parentExecution.resend_generation + 1],
  )) as Array<{ id: string }>;

  await new CampaignsRepository(manager, tenantId).save({
    ...campaign,
    status: 'queued',
    version: campaign.version + 1,
    updatedBy: actor.actorId,
  });

  await appendAuditLog(manager, {
    tenantId,
    actorId: actor.actorId,
    action: 'campaign.resend.created',
    entityType: 'campaign',
    entityId: campaign.id,
    traceId: actor.traceId,
    metadata: { parentExecutionId: parentExecution.id, childExecutionId: childExecution.id, recipientCount: failedRecipients.length },
  });

  return {
    id: childExecution.id,
    campaignId: campaign.id,
    executionId: childExecution.id,
    snapshotId: childSnapshot.id,
    parentExecutionId: parentExecution.id,
    resendGeneration: parentExecution.resend_generation + 1,
    recipientCount: failedRecipients.length,
  };
}
