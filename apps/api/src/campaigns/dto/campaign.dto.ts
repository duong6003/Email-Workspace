import { z } from 'zod';

const campaignName = z.string().trim().max(200);
const nonBlankCampaignName = campaignName.min(1);
const subject = z.string().trim().max(998);
const id = z.string().uuid();
const campaignStatuses = ['draft', 'scheduled', 'queued', 'validating', 'sending', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled'] as const;

export const campaignSenderSchema = z.object({
  senderConfigId: id.nullable().optional(),
  fromName: z.string().trim().max(160).optional(),
  fromEmail: z.string().trim().email().max(320).optional(),
  replyTo: z.string().trim().email().max(320).nullable().optional(),
}).strict();

export const campaignAudienceSchema = z.object({
  listIds: z.array(id).max(200).optional(),
  tagIds: z.array(id).max(200).optional(),
  recipientIds: z.array(id).max(5000).optional(),
  excludeListIds: z.array(id).max(200).optional(),
  excludeTagIds: z.array(id).max(200).optional(),
  // BR-SEG-009: "Audience builder hỗ trợ exclude list/tag/recipient" -- the
  // third exclusion source was missing from M4-S1's original schema (which
  // never resolved audiences, only stored the definition); added here in
  // M4-S2 where it is actually consumed.
  excludeRecipientIds: z.array(id).max(5000).optional(),
}).strict();
export type CampaignAudienceDto = z.infer<typeof campaignAudienceSchema>;

/** The audience being previewed may not yet be saved to the draft, so this is its own body, not a lookup by campaign id alone. */
export const previewCampaignAudienceSchema = z.object({
  audience: campaignAudienceSchema,
}).strict();
export type PreviewCampaignAudienceDto = z.infer<typeof previewCampaignAudienceSchema>;

export const campaignSettingsSchema = z.object({
  cc: z.array(z.string().email()).max(50).optional(),
  bcc: z.array(z.string().email()).max(50).optional(),
  variableOverrides: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.unknown()).optional(),
}).strict();

export const createCampaignDraftSchema = z.object({
  name: campaignName,
  subject: subject.optional().default(''),
  templateId: id.nullable().optional().default(null),
  templateVersionId: id.nullable().optional().default(null),
  sender: campaignSenderSchema.optional().default({}),
  audience: campaignAudienceSchema.optional().default({}),
  settings: campaignSettingsSchema.optional().default({}),
}).strict();
export type CreateCampaignDraftDto = z.infer<typeof createCampaignDraftSchema>;

export const updateCampaignDraftSchema = z.object({
  name: nonBlankCampaignName.optional(),
  subject: subject.optional(),
  templateId: id.nullable().optional(),
  templateVersionId: id.nullable().optional(),
  sender: campaignSenderSchema.optional(),
  audience: campaignAudienceSchema.optional(),
  settings: campaignSettingsSchema.optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'At least one campaign field is required.');
export type UpdateCampaignDraftDto = z.infer<typeof updateCampaignDraftSchema>;

// DEC-093: localDateTime is deliberately zone-less. Accepting an offset would
// let the client pre-resolve the DST ambiguity BR-SCH-003 exists to force
// into the open.
export const campaignScheduleRequestSchema = z.object({
  localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  timeZone: z.string().min(1),
  offsetMinutes: z.number().int().optional(),
}).strict();
export type CampaignScheduleRequestDto = z.infer<typeof campaignScheduleRequestSchema>;

/** The drafts view is intentionally a bounded, draft-only list by default. */
export const campaignListQuerySchema = z.object({
  status: z.enum(campaignStatuses).optional().default('draft'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  scope: z.enum(['mine', 'all']).optional().default('mine'),
}).strict();
export type CampaignListQueryDto = z.infer<typeof campaignListQuerySchema>;
