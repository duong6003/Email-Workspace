import { z } from 'zod';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === '' ? undefined : value));

// BR-REC-003: only these four statuses are valid.
export const recipientStatusSchema = z.enum(['active', 'paused', 'unsubscribed', 'bounced']);

// BR-REC-002: basic profile fields, all optional except email.
export const recipientCreateRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  firstName: optionalText(120),
  lastName: optionalText(120),
  phone: optionalText(40),
  department: optionalText(120),
  title: optionalText(120),
  location: optionalText(120),
  subscriptionStatus: recipientStatusSchema.default('active'),
  customData: z.record(z.string(), z.unknown()).optional(),
});
export type RecipientCreateRequestDto = z.infer<typeof recipientCreateRequestSchema>;

export const recipientUpdateRequestSchema = z.object({
  email: z.string().trim().email().max(320).optional(),
  firstName: optionalText(120),
  lastName: optionalText(120),
  phone: optionalText(40),
  department: optionalText(120),
  title: optionalText(120),
  location: optionalText(120),
  // BR-REC-004: reactivating an unsubscribed recipient through this generic
  // update path is refused by the service layer -- it is not a schema-level
  // restriction because active/paused/bounced transitions between
  // themselves are fine here.
  subscriptionStatus: recipientStatusSchema.optional(),
  customData: z.record(z.string(), z.unknown()).optional(),
  // BR-REC-004: set true to move a recipient from unsubscribed back to
  // active. Only honoured when the caller also holds settings:manage
  // (Admin) -- this is the "re-consent" confirmation the rule requires,
  // not a silent reactivation.
  confirmReconsent: z.boolean().optional(),
});
export type RecipientUpdateRequestDto = z.infer<typeof recipientUpdateRequestSchema>;

// BR-REC-007/008: search + status/list/tag filters, server-side cursor pagination.
export const recipientListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z
    .union([recipientStatusSchema, z.array(recipientStatusSchema)])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value])),
  listIds: z
    .union([z.string().uuid(), z.array(z.string().uuid())])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value])),
  tagIds: z
    .union([z.string().uuid(), z.array(z.string().uuid())])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value])),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type RecipientListQueryDto = z.infer<typeof recipientListQuerySchema>;
