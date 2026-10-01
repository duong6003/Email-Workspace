import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { SYSTEM_TEMPLATE_VARIABLES } from '../templates/template-variables.js';
import { TemplateVersionsRepository } from '../templates/templates.repository.js';
import { CustomFieldsRepository } from '../custom-fields/custom-fields.repository.js';
import { RecipientsRepository } from '../recipients/recipients.repository.js';
import type { CampaignAudience, CampaignAudienceWaiver } from '../database/entities/campaign.entity.js';
import { AudienceCandidatesRepository } from './audience-candidates.repository.js';
import { resolveActionableRecipientIds } from './audience-resolution.js';
import { recipientVariableContext, type LinkContext } from './recipient-variable-context.js';
import { validateVariables, type VariableValidationResult } from './variable-validation.js';
import type { CampaignSettings } from '../database/entities/campaign.entity.js';
import { resolveConfiguredVariableValues } from '../configured-variables/configured-variable-resolution.js';

const VALIDATION_SAMPLE_LIMIT = 50;

export type AudienceWaiverStatus = 'none' | 'valid' | 'stale';

/**
 * BR-CMP-005's staleness check, shared verbatim by validateAudience (M4-S3)
 * and freezeCampaignSnapshot's A15 gate (M4-S4) -- both must agree on
 * exactly which waiver still covers the current missing set, never two
 * slightly different re-derivations of the same compliance decision.
 */
export function computeAudienceWaiverStatus(waiver: CampaignAudienceWaiver | null, missingRecipientIds: readonly string[]): AudienceWaiverStatus {
  if (waiver === null) return 'none';
  return missingRecipientIds.every((id) => waiver.missingVariableRecipientIds.includes(id)) ? 'valid' : 'stale';
}

/**
 * M4-S3 (BR-CMP-004/005/006, BR-TPL-008): orchestrates the real data this
 * node's pure functions need, then delegates the actual matrix computation
 * entirely to validateVariables() -- this function does I/O and shape,
 * never eligibility or rendering decisions, mirroring how M4-S2's
 * previewAudience() delegates to resolveAudience().
 */
export async function computeCampaignVariableValidation(
  manager: EntityManager,
  tenantId: string,
  campaign: { id: string; templateVersionId: string | null; audienceJson: CampaignAudience; settingsJson: CampaignSettings },
  links: LinkContext,
): Promise<VariableValidationResult> {
  if (!campaign.templateVersionId) {
    throw new NotFoundException('Campaign has no template selected yet; nothing to validate variables against.');
  }
  const version = await new TemplateVersionsRepository(manager, tenantId).findById(campaign.templateVersionId);
  if (!version) throw new NotFoundException('Campaign template version was not found.');
  const configuredValues = await resolveConfiguredVariableValues(
    manager,
    tenantId,
    version.templateId,
    version.variableSchemaJson,
    campaign.settingsJson?.variableOverrides ?? {},
  );

  const audience = campaign.audienceJson;
  const candidateRows = await new AudienceCandidatesRepository(manager, tenantId).findCandidates({
    listIds: audience.listIds ?? [],
    tagIds: audience.tagIds ?? [],
    recipientIds: audience.recipientIds ?? [],
    excludeListIds: audience.excludeListIds ?? [],
    excludeTagIds: audience.excludeTagIds ?? [],
    excludeRecipientIds: audience.excludeRecipientIds ?? [],
  });
  const actionableIds = resolveActionableRecipientIds(candidateRows);

  const [recipients, customFields] = await Promise.all([
    new RecipientsRepository(manager, tenantId).findByIds(actionableIds),
    new CustomFieldsRepository(manager, tenantId).list(),
  ]);

  const candidates = recipients.map((recipient) => ({
    recipientId: recipient.id,
    email: recipient.email,
    context: recipientVariableContext(recipient, customFields, links, configuredValues),
  }));

  const variableLabels: Record<string, string> = {};
  for (const system of SYSTEM_TEMPLATE_VARIABLES) variableLabels[system.key] = system.label;
  for (const field of customFields) variableLabels[field.fieldKey] = field.label;
  for (const [key, definition] of Object.entries(version.variableSchemaJson.configured ?? {})) variableLabels[key] = definition.label;

  return validateVariables(
    candidates,
    { subject: version.subject, html: version.html, textBody: version.textBody },
    version.variableSchemaJson,
    variableLabels,
    { sampleLimit: VALIDATION_SAMPLE_LIMIT },
  );
}
