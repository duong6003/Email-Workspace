import type { CampaignBulkAction, CampaignBulkResponse } from '../../api/campaign-list.js';

/**
 * Reasons are short fixed strings keyed by code, never the server's own
 * `message`. A full sentence wraps in the name column, widens it and pushes
 * the rest of the table out of alignment -- found while reviewing the mockup.
 */
const REASON: Record<string, string> = {
  CAMPAIGN_NOT_DRAFT: 'Bỏ qua: chỉ xóa được bản nháp.',
  CAMPAIGN_NOT_CANCELLABLE: 'Bỏ qua: chiến dịch không đang chờ hoặc đang gửi.',
  CAMPAIGN_VERSION_CONFLICT: 'Không xong: vừa bị người khác sửa.',
  CAMPAIGN_STATE_CONFLICT: 'Không xong: trạng thái vừa thay đổi.',
  DRAFT_OWNER_REQUIRED: 'Không xong: không phải bản nháp của bạn.',
  CAMPAIGN_NOT_FOUND: 'Không xong: chiến dịch không còn tồn tại.',
};

const VERB: Record<CampaignBulkAction, string> = {
  delete: 'Đã xóa',
  duplicate: 'Đã nhân bản',
  cancel: 'Đã dừng',
};

/** The rows still needing attention -- which is also exactly the selection to keep. */
export function retrySet(response: CampaignBulkResponse): string[] {
  return response.results.filter((row) => row.outcome !== 'succeeded').map((row) => row.campaignId);
}

export function reasonByCampaign(response: CampaignBulkResponse): Record<string, string> {
  const reasons: Record<string, string> = {};
  for (const row of response.results) {
    if (row.outcome === 'succeeded') continue;
    reasons[row.campaignId] = REASON[row.code] ?? 'Không xong: lỗi không xác định.';
  }
  return reasons;
}

/**
 * Deliberately makes no claim about *where* the unfinished rows are. An
 * earlier wording promised they were "still selected below with a reason",
 * which is false whenever the row left the list -- a CAMPAIGN_NOT_FOUND row is
 * gone from the table, so there is nothing to select and nothing to annotate.
 * Found by running a real bulk delete against a campaign deleted underneath
 * the open list.
 */
export function bulkSummary(action: CampaignBulkAction, response: CampaignBulkResponse): string {
  const done = `${VERB[action]} ${response.succeeded} chiến dịch.`;
  const unfinished = response.failed + response.skipped;
  return unfinished === 0 ? done : `${done} ${unfinished} chiến dịch không xử lý được.`;
}

/**
 * Reasons for unfinished campaigns that are no longer in the list, which
 * therefore have no row to carry them inline. Without this the reason is lost
 * entirely and the user is told only that something failed.
 *
 * Takes the already-computed reason map rather than the response, so the
 * caller can derive this while rendering. Deriving it at call time instead was
 * wrong: the list has not reloaded yet at that point, so a row about to
 * disappear still counts as visible and its reason is dropped.
 */
export function orphanReasons(reasons: Record<string, string>, visibleIds: readonly string[]): string[] {
  const visible = new Set(visibleIds);
  return [...new Set(
    Object.entries(reasons)
      .filter(([campaignId]) => !visible.has(campaignId))
      .map(([, reason]) => reason),
  )];
}
