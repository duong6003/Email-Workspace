/**
 * Sibling to realtime-job-rooms.ts's requestedJobIds. The limit is lower
 * (10 vs the job parser's 50): a viewer watches one campaign's progress
 * drawer, occasionally a small list -- a tighter bound is a smaller surface
 * for a client that asks for a thousand ids (DEC-126).
 */
const MAX_CAMPAIGN_SUBSCRIPTIONS = 10;

export function requestedCampaignIds(auth: unknown): string[] {
  if (!auth || typeof auth !== 'object') return [];
  const value = auth as { campaignId?: unknown; campaignIds?: unknown };
  const candidates = Array.isArray(value.campaignIds)
    ? value.campaignIds
    : typeof value.campaignId === 'string' ? [value.campaignId] : [];
  if (candidates.length > MAX_CAMPAIGN_SUBSCRIPTIONS) return [];
  return [...new Set(candidates.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}
