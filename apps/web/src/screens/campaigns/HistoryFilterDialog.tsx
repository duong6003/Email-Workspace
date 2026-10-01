import { useState } from 'react';
import type { CampaignHistoryQuery } from '../../api/campaign-list.js';
import { CAMPAIGN_STATUS_LABEL } from './active-filters.js';

/**
 * All twelve campaign statuses, plus an explicit "all" option. The dialog
 * previously listed six and offered no way back to no-filter: the options are
 * radios, so once one was picked the only escape was "Đặt lại". Since the
 * Chiến dịch restructure this is the *only* control over status -- there is no
 * chip strip duplicating it -- so an incomplete list would make six statuses
 * unfilterable outright.
 */
const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Tất cả trạng thái' },
  ...Object.entries(CAMPAIGN_STATUS_LABEL).map(([value, label]) => ({ value, label })),
];

/**
 * BR-HIS-001's filter surface. Structure follows the approved handoff's
 * `historyFilter` overlay (action-overlays.tsx:216-217) -- date range,
 * status, sender-config -- wired to the real historyListQuerySchema fields
 * instead of the mock's static options.
 */
export function HistoryFilterDialog({
  query, onApply, onReset, onClose,
}: {
  query: CampaignHistoryQuery;
  onApply: (next: CampaignHistoryQuery) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CampaignHistoryQuery>(query);

  return (
    <div className="overlay-backdrop" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="history-filter-title" className="action-overlay" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><h2 id="history-filter-title">Bộ lọc chiến dịch</h2><p>Lọc theo thời gian, trạng thái và cấu hình người gửi.</p></div>
          <button aria-label="Đóng cửa sổ" onClick={onClose}>×</button>
        </header>
        <div className="overlay-content">
          <div className="filter-panel">
            <section>
              <header><b>Khoảng thời gian</b></header>
              <div className="filter-select-row date-range">
                <label className="modal-field">
                  <span>Từ ngày</span>
                  <input type="date" value={draft.dateFrom?.slice(0, 10) ?? ''} onChange={(event) => setDraft((current) => ({ ...current, dateFrom: event.target.value ? `${event.target.value}T00:00:00Z` : undefined }))} />
                </label>
                <label className="modal-field">
                  <span>Đến ngày</span>
                  <input type="date" value={draft.dateTo?.slice(0, 10) ?? ''} onChange={(event) => setDraft((current) => ({ ...current, dateTo: event.target.value ? `${event.target.value}T23:59:59Z` : undefined }))} />
                </label>
              </div>
            </section>
            <section>
              <header><b>Trạng thái chiến dịch</b></header>
              <div className="filter-option-grid four">
                {STATUS_OPTIONS.map((option) => (
                  <label key={option.value}>
                    <input
                      type="radio"
                      name="history-status"
                      checked={(draft.status ?? '') === option.value}
                      onChange={() => setDraft((current) => ({ ...current, status: option.value || undefined }))}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </section>
          </div>
        </div>
        <footer>
          <button className="text-button" onClick={onReset}>Đặt lại</button>
          <span className="footer-spacer" />
          <button className="secondary-button" onClick={onClose}>Hủy</button>
          <button className="primary-button" onClick={() => onApply(draft)}>Áp dụng bộ lọc</button>
        </footer>
      </section>
    </div>
  );
}
