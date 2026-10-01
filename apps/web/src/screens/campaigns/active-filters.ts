import type { CampaignHistoryQuery } from '../../api/campaign-list.js';

export type FilterChipKey = 'status' | 'dateFrom' | 'dateTo' | 'senderConfigId' | 'createdBy';
export type FilterChip = { key: FilterChipKey; label: string };

export const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: 'Bản nháp', scheduled: 'Đã lên lịch', blocked: 'Cần xử lý trước khi gửi', missed: 'Quá thời gian dự kiến',
  queued: 'Sẵn sàng gửi', validating: 'Đang kiểm tra trước khi gửi', sending: 'Đang gửi', paused: 'Đã tạm dừng',
  completed: 'Gửi hoàn tất', partial_failed: 'Hoàn tất, có email lỗi', failed: 'Không gửi được', cancelled: 'Đã dừng',
};

/** UTC, to match the filter dialog which writes the boundaries as UTC instants. */
function day(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

/**
 * Chips are *output*: they show what the filter dialog currently holds and let
 * one dimension be dropped. They are deliberately not a second input for
 * `status` -- that would be a duplicate control over the same query field, and
 * campaigns have twelve statuses, so a chip strip could never be the complete
 * control anyway. Adding a filter dimension later only means adding a case here.
 */
export function filterChips(query: CampaignHistoryQuery): FilterChip[] {
  const chips: FilterChip[] = [];
  if (query.status) chips.push({ key: 'status', label: `Trạng thái: ${CAMPAIGN_STATUS_LABEL[query.status] ?? query.status}` });
  if (query.dateFrom) chips.push({ key: 'dateFrom', label: `Từ ${day(query.dateFrom)}` });
  if (query.dateTo) chips.push({ key: 'dateTo', label: `Đến ${day(query.dateTo)}` });
  if (query.senderConfigId) chips.push({ key: 'senderConfigId', label: 'Cấu hình gửi đã chọn' });
  if (query.createdBy) chips.push({ key: 'createdBy', label: 'Người tạo đã chọn' });
  return chips;
}

/** Removing a filter invalidates the cursor: that page was numbered under the old predicate. */
export function removeFilter(query: CampaignHistoryQuery, key: FilterChipKey): CampaignHistoryQuery {
  const next = { ...query };
  delete next[key];
  delete next.cursor;
  return next;
}
