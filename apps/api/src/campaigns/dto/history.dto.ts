import { z } from 'zod';

/**
 * BR-HIS-001 + ADR-034. Deliberately NOT campaignListQuerySchema (DEC-138):
 * that one defaults to status='draft' and is guarded by CONTENT_MANAGE, while
 * this route is viewer-readable (CAMPAIGN_READ) and defaults to every
 * non-draft status, newest first.
 *
 * Since ADR-034 the vocabulary covers the whole campaign lifecycle, 'draft'
 * included. Whether draft rows are actually returned is decided by
 * includeDrafts plus the caller's permissions in buildHistoryListSql, never
 * by this enum.
 */
const campaignStatuses = [
  'draft', 'scheduled', 'blocked', 'missed', 'queued', 'validating', 'sending', 'paused',
  'completed', 'partial_failed', 'failed', 'cancelled',
] as const;

/**
 * NOT z.coerce.boolean(): that is `Boolean(input)`, and query parameters
 * arrive as strings, so the string 'false' would coerce to TRUE -- turning an
 * explicit opt-out into an opt-in on a permission-bearing flag. The string
 * forms are parsed literally instead, and anything else is rejected.
 */
const queryBoolean = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
]);

export const historyListQuerySchema = z.object({
  status: z.enum(campaignStatuses).optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  senderConfigId: z.string().uuid().optional(),
  createdBy: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  cursor: z.string().min(1).optional(),
  /** ADR-034. Default false keeps every pre-restructure caller's results identical. */
  includeDrafts: queryBoolean.optional().default(false),
  scope: z.enum(['mine', 'all']).optional(),
}).strict();
export type HistoryListQueryDto = z.infer<typeof historyListQuerySchema>;

export const historyRecipientStatuses = [
  'pending', 'queued', 'submitted', 'delivered', 'bounced', 'failed', 'skipped', 'cancelled',
] as const;

export const historyRecipientsQuerySchema = z.object({
  status: z.enum(historyRecipientStatuses).optional(),
  search: z.string().trim().min(1).max(320).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).optional(),
}).strict();
export type HistoryRecipientsQueryDto = z.infer<typeof historyRecipientsQuerySchema>;
