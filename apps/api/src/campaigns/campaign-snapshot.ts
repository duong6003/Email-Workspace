import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { appendAuditLog } from '../common/audit-writer.js';
import { appendOutboxEvent } from '../outbox/outbox-writer.js';
import { CustomFieldsRepository } from '../custom-fields/custom-fields.repository.js';
import { RecipientsRepository } from '../recipients/recipients.repository.js';
import { TemplateVersionsRepository } from '../templates/templates.repository.js';
import { renderTemplateVariables } from '../templates/template-variable-renderer.js';
import { resolveVariableFormatting } from '../templates/variable-formatting.js';
import { CampaignEntity } from '../database/entities/campaign.entity.js';
import type { SnapshotPolicyResult } from '../database/entities/campaign-snapshot.entity.js';
import type { CampaignRecipientEligibility, CampaignRecipientEntity, CampaignRecipientSkipReason, FrozenEmail } from '../database/entities/campaign-recipient.entity.js';
import { AudienceCandidatesRepository } from './audience-candidates.repository.js';
import { resolveActionableRecipientIds, resolveAudience, resolveSkippedRecipients } from './audience-resolution.js';
import { CampaignRecipientRepository } from './campaign-recipient.repository.js';
import { computeAudienceWaiverStatus, computeCampaignVariableValidation } from './campaign-variable-validation.js';
import { CampaignSnapshotRepository } from './campaign-snapshot.repository.js';
import { CampaignsRepository } from './campaigns.repository.js';
import type { CampaignActor } from './campaigns.types.js';
import { recipientVariableContext, type LinkContext } from './recipient-variable-context.js';
import { resolveConfiguredVariableValues } from '../configured-variables/configured-variable-resolution.js';

const AUDIENCE_SAMPLE_LIMIT = 0;

/**
 * M5-S2 DEC-080: sendCampaign and scheduleCampaign share this one freeze
 * path rather than each growing its own copy. `queued` is M4-S4's original,
 * immediate-send target; `scheduled` additionally carries the resolved
 * instant/zone onto the campaign row in the same save.
 */
export type FreezeTarget =
  | { targetStatus: 'queued' }
  | { targetStatus: 'scheduled'; scheduledAtUtc: Date; scheduledTimezone: string };

export type FrozenSnapshot = {
  snapshotId: string;
  campaignId: string;
  status: 'queued' | 'scheduled';
  totalSnapshot: number;
  sendableCount: number;
  skippedCount: number;
  frozenAt: string;
};

/**
 * M4-S4 (BR-CMP-007, BR-CMP-010, BR-TPL-001/012, BR-CF-008). Calls the exact
 * chain M4-S2/M4-S3 already proved -- resolveAudience/resolveActionableRecipientIds/
 * resolveSkippedRecipients, computeCampaignVariableValidation,
 * recipientVariableContext, renderTemplateVariables -- once, and persists its
 * output. Never recomputes or reimplements eligibility or rendering.
 *
 * The caller (CampaignsService) is responsible for loading `campaign` with a
 * pessimistic write lock (CampaignsRepository.findActiveById(id, true)) inside
 * its own runInTenantContext transaction before calling this -- that lock is
 * what makes the status flip and the snapshot insert atomic with a concurrent
 * PATCH. `audienceLimit` is passed explicitly (config/env.ts's
 * CAMPAIGN_AUDIENCE_LIMIT) because this path does not call previewAudience()
 * and so does not inherit its ceiling check for free (M4-S4-SNAPSHOT-PLAN.md
 * §5 R1) -- it must be re-applied here.
 */
export async function freezeCampaignSnapshot(
  manager: EntityManager,
  tenantId: string,
  campaign: CampaignEntity,
  actor: CampaignActor,
  links: LinkContext,
  audienceLimit: number,
  target: FreezeTarget = { targetStatus: 'queued' },
): Promise<FrozenSnapshot> {
  if (campaign.status !== 'draft') {
    throw new ConflictException('Campaign cannot be frozen for sending unless it is a draft.');
  }
  if (!campaign.name.trim()) {
    throw new UnprocessableEntityException({
      code: 'CAMPAIGN_NAME_REQUIRED',
      message: 'Campaign name is required before sending.',
      nextAction: 'FOCUS_CAMPAIGN_NAME',
      fieldErrors: [{ field: 'name', code: 'REQUIRED' }],
    });
  }
  if (!campaign.subject.trim()) {
    throw new UnprocessableEntityException({
      code: 'CAMPAIGN_SUBJECT_REQUIRED',
      message: 'Campaign subject is required before sending.',
      nextAction: 'FOCUS_CAMPAIGN_SUBJECT',
      fieldErrors: [{ field: 'subject', code: 'REQUIRED' }],
    });
  }
  if (!campaign.templateVersionId) {
    throw new UnprocessableEntityException('Campaign has no template selected yet; nothing to freeze.');
  }

  const audience = campaign.audienceJson;
  const candidates = await new AudienceCandidatesRepository(manager, tenantId).findCandidates({
    listIds: audience.listIds ?? [],
    tagIds: audience.tagIds ?? [],
    recipientIds: audience.recipientIds ?? [],
    excludeListIds: audience.excludeListIds ?? [],
    excludeTagIds: audience.excludeTagIds ?? [],
    excludeRecipientIds: audience.excludeRecipientIds ?? [],
  });

  const resolution = resolveAudience(candidates, { sampleLimit: AUDIENCE_SAMPLE_LIMIT });
  if (resolution.totalUnique === 0) {
    throw new UnprocessableEntityException({
      code: 'AUDIENCE_EMPTY',
      message: 'At least one eligible recipient is required before sending.',
      nextAction: 'OPEN_RECIPIENT_PICKER',
      fieldErrors: [{ field: 'audience', code: 'REQUIRED' }],
    });
  }
  if (resolution.totalUnique > audienceLimit) {
    throw new UnprocessableEntityException({
      message: `Audience of ${resolution.totalUnique} exceeds the configured limit of ${audienceLimit}.`,
      limit: audienceLimit,
      current: 0,
      requested: resolution.totalUnique,
    });
  }

  const actionableIds = resolveActionableRecipientIds(candidates);
  const audienceSkipped = resolveSkippedRecipients(candidates);

  const version = await new TemplateVersionsRepository(manager, tenantId).findById(campaign.templateVersionId);
  if (!version) throw new UnprocessableEntityException('Campaign template version was not found.');

  const policy = await computeCampaignVariableValidation(manager, tenantId, campaign, links);
  const waiver = campaign.settingsJson.audienceWaiver ?? null;
  const waiverStatus = computeAudienceWaiverStatus(waiver, policy.missingRecipientIds);
  if (policy.missingCount > 0 && waiverStatus !== 'valid') {
    throw new UnprocessableEntityException({
      message: 'Required template variables are missing for one or more recipients and no valid waiver covers them.',
      missingCount: policy.missingCount,
      waiverStatus,
    });
  }
  const missingVariableRecipientIds = new Set(policy.missingCount > 0 ? policy.missingRecipientIds : []);

  const frozenRecipientIds = Array.from(new Set([...actionableIds, ...audienceSkipped.map((entry) => entry.recipientId)]));
  const [recipients, customFields] = await Promise.all([
    new RecipientsRepository(manager, tenantId).findByIds(frozenRecipientIds),
    new CustomFieldsRepository(manager, tenantId).list(),
  ]);
  const recipientsById = new Map(recipients.map((recipient) => [recipient.id, recipient]));
  const configuredValues = await resolveConfiguredVariableValues(
    manager,
    tenantId,
    version.templateId,
    version.variableSchemaJson,
    campaign.settingsJson.variableOverrides ?? {},
  );
  // ADR-036: presentation is resolved from the current definitions, deliberately
  // not from version.variableSchemaJson. The rendered bodies are frozen into
  // email_snapshot here, so this is the send's one and only formatting pass --
  // and it is the same call POST /template-versions/:id/preview makes.
  const formatting = await resolveVariableFormatting(manager, tenantId, version.templateId);

  const now = new Date();
  const rows: Array<Pick<CampaignRecipientEntity, 'recipientId' | 'recipientEmail' | 'mergeDataJson' | 'emailSnapshot' | 'eligibility' | 'skippedReason'>> = [];

  for (const recipientId of actionableIds) {
    const recipient = recipientsById.get(recipientId)!;
    const context = recipientVariableContext(recipient, customFields, links, configuredValues);
    if (missingVariableRecipientIds.has(recipientId)) {
      rows.push({ recipientId, recipientEmail: recipient.email, mergeDataJson: context, emailSnapshot: emptyEmail(), eligibility: 'skipped', skippedReason: 'missing_required_variable' });
      continue;
    }
    const rendered = renderTemplateVariables({ subject: version.subject, html: version.html, textBody: version.textBody }, version.variableSchemaJson, context, { formatting });
    if ('code' in rendered) {
      rows.push({ recipientId, recipientEmail: recipient.email, mergeDataJson: context, emailSnapshot: emptyEmail(), eligibility: 'skipped', skippedReason: 'missing_required_variable' });
      continue;
    }
    rows.push({ recipientId, recipientEmail: recipient.email, mergeDataJson: context, emailSnapshot: rendered, eligibility: 'sendable', skippedReason: null });
  }
  for (const skipped of audienceSkipped) {
    const recipient = recipientsById.get(skipped.recipientId)!;
    rows.push({ recipientId: skipped.recipientId, recipientEmail: recipient.email, mergeDataJson: {}, emailSnapshot: emptyEmail(), eligibility: 'skipped', skippedReason: skipped.reason });
  }

  const sendableCount = rows.filter((row) => row.eligibility === 'sendable').length;
  const skippedCount = rows.length - sendableCount;

  const policyResultJson: SnapshotPolicyResult = {
    totalActionable: policy.totalActionable,
    completeCount: policy.completeCount,
    missingCount: policy.missingCount,
    missingByVariable: policy.missingByVariable,
    waiver,
    webOrigin: links.webOrigin,
  };

  const snapshot = await new CampaignSnapshotRepository(manager, tenantId).save({
    campaignId: campaign.id,
    templateVersionId: version.id,
    senderJson: campaign.senderJson,
    audienceQueryJson: campaign.audienceJson,
    policyResultJson,
    variableSchemaJson: version.variableSchemaJson,
    configuredVariableValuesJson: configuredValues,
    totalSnapshot: rows.length,
    sendableCount,
    skippedCount,
    frozenBy: actor.actorId,
    frozenAt: now,
    supersededAt: null,
  });

  if (rows.length > 0) {
    await new CampaignRecipientRepository(manager, tenantId).insertMany(
      rows.map((row) => ({
        campaignId: campaign.id,
        snapshotId: snapshot.id,
        recipientId: row.recipientId,
        recipientEmail: row.recipientEmail,
        mergeDataJson: row.mergeDataJson,
        emailSnapshot: row.emailSnapshot,
        eligibility: row.eligibility,
        skippedReason: row.skippedReason,
        // M5-S3 CP1 (D-88): 'queued' means claimed by the send pipeline, which a
        // just-frozen recipient has not been yet. A skipped row must agree with
        // its own eligibility per campaign_recipient_skipped_status_agrees (026).
        status: row.eligibility === 'skipped' ? 'skipped' : 'pending',
        providerMessageId: null,
        lastErrorCode: null,
        updatedAt: now,
      })),
    );
  }

  const newVersion = campaign.version + 1;
  await new CampaignsRepository(manager, tenantId).save({
    ...campaign,
    status: target.targetStatus,
    scheduledAtUtc: target.targetStatus === 'scheduled' ? target.scheduledAtUtc : null,
    scheduledTimezone: target.targetStatus === 'scheduled' ? target.scheduledTimezone : null,
    version: newVersion,
    updatedBy: actor.actorId,
  });

  await appendAuditLog(manager, {
    tenantId,
    actorId: actor.actorId,
    action: 'campaign.snapshot_frozen',
    entityType: 'campaign',
    entityId: campaign.id,
    traceId: actor.traceId,
    metadata: { snapshotId: snapshot.id, totalSnapshot: rows.length, sendableCount, skippedCount },
  });
  await appendOutboxEvent(manager, {
    tenantId,
    eventType: 'campaign.snapshot_frozen',
    aggregateType: 'campaign',
    aggregateId: campaign.id,
    aggregateVersion: BigInt(newVersion),
    payload: { snapshotId: snapshot.id, totalSnapshot: rows.length, sendableCount, skippedCount },
  });

  return {
    snapshotId: snapshot.id,
    campaignId: campaign.id,
    status: target.targetStatus,
    totalSnapshot: rows.length,
    sendableCount,
    skippedCount,
    frozenAt: now.toISOString(),
  };
}

function emptyEmail(): FrozenEmail {
  return { subject: '', html: '', textBody: '' };
}

// Re-exported so callers building campaign_recipient shapes elsewhere share one source of truth.
export type { CampaignRecipientEligibility, CampaignRecipientSkipReason };
