/**
 * A draft has never been sent, so the detail screen would have nothing to
 * show: rows route by status instead of all landing on one destination.
 */
export function campaignRowTarget(status: string, campaignId: string): string {
  return status === 'draft' ? `/campaigns/${campaignId}/edit` : `/campaigns/${campaignId}`;
}
