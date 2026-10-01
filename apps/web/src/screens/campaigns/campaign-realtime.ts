export type CampaignProgressEvent = { aggregate_id?: unknown; event_type?: unknown; version?: unknown; data?: unknown };

export function isCampaignProgressEvent(event: CampaignProgressEvent, campaignId: string): boolean {
  return event.aggregate_id === campaignId && event.event_type === 'campaign.progress';
}

/**
 * ADR-010 + BR-SEND-003: a duplicate or out-of-order delivery must never
 * move a counter backwards. `version` is the execution's progress_seq
 * (D-116/DEC-122), not campaign.version.
 */
export function applyProgressEvent<T extends { version: number }>(
  current: T | null,
  event: CampaignProgressEvent,
  campaignId: string,
): T | null {
  if (!isCampaignProgressEvent(event, campaignId)) return current;
  if (typeof event.version !== 'number') return current;
  if (current && event.version <= current.version) return current;
  return { ...(event.data as object), version: event.version } as T;
}
