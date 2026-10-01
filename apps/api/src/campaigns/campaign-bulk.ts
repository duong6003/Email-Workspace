import type { CampaignStatus } from '../database/entities/campaign.entity.js';

export type CampaignBulkAction = 'delete' | 'duplicate' | 'cancel';
export type BulkPrecondition = { allowed: true } | { allowed: false; code: string; message: string };

const CANCELLABLE = new Set<CampaignStatus>(['scheduled', 'queued', 'sending']);

/**
 * The state rules the single-row routes already enforce, restated as data so a
 * bulk row can be reported as `skipped` with a reason instead of aborting the
 * whole request. Kept pure and separate from the service so the behaviour is
 * testable without a database.
 *
 * `cancel` covers three statuses because three different service methods sit
 * behind it -- cancelCampaignSchedule (scheduled), cancelCampaign (queued) and
 * cancelCampaignSend (sending). The dispatch lives in the service; only the
 * legality question lives here.
 */
export function bulkPrecondition(action: CampaignBulkAction, status: CampaignStatus): BulkPrecondition {
  if (action === 'duplicate') return { allowed: true };
  if (action === 'delete') {
    return status === 'draft'
      ? { allowed: true }
      : { allowed: false, code: 'CAMPAIGN_NOT_DRAFT', message: 'Only a draft campaign can be deleted.' };
  }
  return CANCELLABLE.has(status)
    ? { allowed: true }
    : { allowed: false, code: 'CAMPAIGN_NOT_CANCELLABLE', message: 'Campaign is not scheduled, queued or sending.' };
}

/**
 * Permissions differ per action, so the route cannot carry a single
 * @RequirePermission decorator -- the check has to run per request in the
 * service, against the action the body names.
 */
export function requiredBulkPermission(action: CampaignBulkAction): string {
  return action === 'cancel' ? 'campaign:manage' : 'content:manage';
}
