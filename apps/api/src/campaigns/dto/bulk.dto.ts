import { z } from 'zod';

/**
 * Synchronous bulk actions for the campaign list. Bounded at 100 because the
 * caller can only select rows it has already loaded, and because each row runs
 * its own transaction -- an unbounded list would hold one request open for an
 * unbounded time.
 *
 * Deliberately carries no If-Match: N version numbers cannot travel in one
 * request, so each row's version is read inside its own transaction and a
 * moved version comes back as CAMPAIGN_VERSION_CONFLICT for that row alone.
 */
export const campaignBulkSchema = z.object({
  action: z.enum(['delete', 'duplicate', 'cancel']),
  campaignIds: z.array(z.string().uuid()).min(1).max(100),
}).strict();
export type CampaignBulkDto = z.infer<typeof campaignBulkSchema>;

export type CampaignBulkOutcome = 'succeeded' | 'failed' | 'skipped';
export type CampaignBulkResult = { campaignId: string; outcome: CampaignBulkOutcome; code: string; message: string };
export type CampaignBulkResponse = {
  results: CampaignBulkResult[];
  succeeded: number;
  failed: number;
  skipped: number;
};
