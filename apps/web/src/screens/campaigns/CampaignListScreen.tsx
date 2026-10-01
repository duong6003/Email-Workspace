import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { UiIcon } from '../../app/ui-icons.js';
import { ApiError } from '../../api/problem.js';
import { bulkCampaignAction, fetchCampaignHistory, type CampaignBulkAction, type CampaignHistoryQuery, type CampaignHistoryRow } from '../../api/campaign-list.js';
import { useRealtimeStatus } from '../../api/realtime-status.js';
import { useSession } from '../../auth/use-session.js';
import { hasPermission, PERMISSIONS } from '../../auth/permissions.js';
import { EntityActionMenu } from '../../components/EntityActionMenu.js';
import { CAMPAIGN_STATUS_LABEL, filterChips, removeFilter } from './active-filters.js';
import { availableBulkActions, selectAll, toggleSelection } from './campaign-selection.js';
import { bulkSummary, orphanReasons, reasonByCampaign, retrySet } from './bulk-outcome.js';
import { campaignRowTarget } from './campaign-row-target.js';
import { countdownFrom } from './history-countdown.js';
import { HistoryFilterDialog } from './HistoryFilterDialog.js';
import { ResendConfirmDialog } from './ResendConfirmDialog.js';

function statusClass(status: string): string {
  if (status === 'completed') return 'success';
  if (status === 'sending' || status === 'validating' || status === 'queued') return 'processing';
  if (status === 'scheduled') return 'scheduled';
  // A draft is not a warning state -- it is the neutral starting point, so it
  // gets the bare .status pill rather than an amber one.
  if (status === 'draft') return '';
  return 'warning';
}

function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="search-box">
      <UiIcon name="search" />
      <input placeholder="Tìm theo tên chiến dịch hoặc tiêu đề" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function FilterButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button className="filter-button" onClick={onClick}>
      <span><UiIcon name="filter" size={15} /></span>
      Bộ lọc
      {count > 0 && <em>{count}</em>}
    </button>
  );
}

function HistoryLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="module-card permission-denied-card">
      <i aria-hidden="true"><UiIcon name="warning" size={22} /></i>
      <span className="status danger" role="status">Không thể tải dữ liệu</span>
      <h2>Không thể tải lịch sử gửi</h2>
      <p>Đã xảy ra lỗi khi tải dữ liệu lịch sử. Vui lòng thử lại.</p>
      <button type="button" className="secondary-button" onClick={onRetry}>
        <UiIcon name="refresh" size={16} /> Thử lại
      </button>
    </div>
  );
}

/**
 * UI-HIS-001 (BR-HIS-001/004). Ported structure + class names from the
 * approved handoff's `History` component
 * (design-reference/ui-handoff-v2/source/app/page.tsx:199-230), replacing
 * the ComingSoon placeholder. UI-HIS-002 (the drawer at
 * /history/:campaignId, M6-S1) is reused unchanged -- this screen only
 * links its own rows there. serverTime (BR-HIS-004) drives every
 * countdown; a row with progress: null renders "Chờ gửi", never a
 * percentage (BR-HIS-004's "no progress before start" falling out of the
 * data model, not a UI special case).
 */
export function CampaignListScreen() {
  const navigate = useNavigate();
  const realtimeStatus = useRealtimeStatus();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [query, setQuery] = useState<CampaignHistoryQuery>({});
  const [items, setItems] = useState<CampaignHistoryRow[] | null>(null);
  const [serverTime, setServerTime] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [resendTarget, setResendTarget] = useState<CampaignHistoryRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const session = useSession();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Presentation only: the server re-checks the real permission per action
  // inside POST /campaigns/bulk. A viewer holds neither, so the checkbox
  // column never renders for them.
  const canSelect = hasPermission(session.data?.permissions, PERMISSIONS.CONTENT_MANAGE)
    || hasPermission(session.data?.permissions, PERMISSIONS.CAMPAIGN_MANAGE);

  const chips = filterChips(query);
  const activeFilterCount = chips.length;
  const rows = useMemo(() => (items ?? []).map((row) => ({ id: row.id, status: row.status })), [items]);
  const actions = availableBulkActions(rows, selectedIds);
  // Derived while rendering, against the list as it stands *now*: a row that
  // vanished in the reload has no place to show its reason inline.
  const orphaned = useMemo(() => orphanReasons(reasons, rows.map((row) => row.id)), [reasons, rows]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    // ADR-034: includeDrafts turns this from a send-history feed into the
    // campaign list. The server still decides which drafts the caller may see.
    fetchCampaignHistory({ ...query, includeDrafts: true, search: debouncedSearch || undefined })
      .then((page) => { setItems(page.items); setServerTime(page.serverTime); })
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : 'Không thể tải danh sách chiến dịch.'))
      .finally(() => setLoading(false));
  }, [debouncedSearch, query]);

  const clearSelection = () => { setSelectedIds([]); setReasons({}); setSummary(null); };

  /**
   * The list is its own result screen. Succeeded rows simply leave the table on
   * reload; rows that did not succeed stay selected -- so the selection is
   * already the retry set -- and carry their reason inline.
   */
  /**
   * `ids` is explicit because the row menu acts on one campaign without the
   * user having ticked it first. Calling setSelectedIds and then reading
   * selectedIds in the same tick returned the *previous* selection -- an empty
   * array when nothing was ticked, so the row action silently did nothing, and
   * somebody else's row when one was, so it acted on the wrong campaign.
   */
  const runBulk = async (action: CampaignBulkAction, ids: string[] = selectedIds) => {
    setRunning(true);
    try {
      const response = await bulkCampaignAction(action, ids);
      setSummary(bulkSummary(action, response));
      setReasons(reasonByCampaign(response));
      setSelectedIds(retrySet(response));
      load();
    } catch (cause) {
      setSummary(cause instanceof ApiError ? cause.message : 'Không chạy được thao tác hàng loạt.');
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (toast === null) return;
    const id = window.setTimeout(() => setToast(null), 3_000);
    return () => window.clearTimeout(id);
  }, [toast]);

  return (
    <section className="workspace-module-frame standard-module-frame history-module">
      <header className="module-frame-toolbar standard-filter-bar">
        <SearchBox value={search} onChange={setSearch} />
        <FilterButton count={activeFilterCount} onClick={() => setFilterOpen(true)} />
        {canSelect && (
          <button className="primary-button" onClick={() => navigate('/campaigns/new')}>
            <UiIcon name="plus" size={16} /> Soạn chiến dịch
          </button>
        )}
      </header>
      <div className="module-frame-body">
        {realtimeStatus === 'reconnecting' && <p className="login-error" role="status">Đang kết nối lại…</p>}
        {toast && <p role="status" aria-live="polite">{toast}</p>}

        {/* Output, not input: the filter dialog owns every dimension, these
            only show what is set and let one be dropped. */}
        {chips.length > 0 && (
          <div className="active-filters" aria-label="Bộ lọc đang áp dụng">
            <span>Đang lọc</span>
            {chips.map((chip) => (
              <button key={chip.key} className="active-filter-chip" onClick={() => setQuery(removeFilter(query, chip.key))}>
                {chip.label}<i aria-hidden="true">×</i>
              </button>
            ))}
            <button className="active-filter-clear" onClick={() => setQuery({})}>Xóa bộ lọc</button>
          </div>
        )}

        {canSelect && (selectedIds.length > 0 || summary) && (
          <div className="bulk-bar" role="status">
            <span>
              {summary ?? <><b>{selectedIds.length}</b> chiến dịch đã chọn</>}
              {orphaned.map((reason) => <small key={reason} className="bulk-orphan-reason">{reason}</small>)}
            </span>
            <div>
              <button disabled={running || !actions.duplicate} onClick={() => void runBulk('duplicate')}>Nhân bản</button>
              <button disabled={running || !actions.cancel} onClick={() => void runBulk('cancel')}>Dừng gửi</button>
              <button className="danger-text" disabled={running || !actions.delete} onClick={() => void runBulk('delete')}>Xóa</button>
            </div>
            <button aria-label="Bỏ chọn tất cả" onClick={clearSelection}>×</button>
          </div>
        )}

        {error && !loading && <HistoryLoadError onRetry={load} />}

        {!error && loading && items === null && (
          <div className="module-card" role="status" aria-live="polite" style={{ padding: 24 }}>
            <p>Đang tải danh sách chiến dịch…</p>
          </div>
        )}

        {!error && items !== null && items.length === 0 && (
          <div className="module-card" style={{ padding: 24 }}>
            <p>Chưa có chiến dịch nào.</p>
          </div>
        )}

        {!error && items !== null && items.length > 0 && (
          <div className="table-wrap">
            <table className="history-table">
              <thead>
                <tr>
                  {canSelect && (
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        aria-label="Chọn tất cả chiến dịch"
                        checked={selectedIds.length === rows.length && rows.length > 0}
                        onChange={() => setSelectedIds(selectAll(rows, selectedIds))}
                      />
                    </th>
                  )}
                  <th>TÊN CHIẾN DỊCH</th><th>NGƯỜI NHẬN</th><th>THỜI GIAN</th><th>TIẾN ĐỘ</th><th>TRẠNG THÁI</th><th>THAO TÁC</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const canResend = row.status === 'partial_failed' || row.status === 'failed';
                  const timeLabel = row.startedAt
                    ? new Date(row.startedAt).toLocaleString('vi-VN')
                    : row.scheduledAtUtc
                      ? new Date(row.scheduledAtUtc).toLocaleString('vi-VN')
                      : new Date(row.createdAt).toLocaleString('vi-VN');
                  const countdown = row.status === 'scheduled' && row.scheduledAtUtc && serverTime
                    ? countdownFrom(serverTime, row.scheduledAtUtc)
                    : null;
                  return (
                    <tr key={row.id} className={selectedIds.includes(row.id) ? 'is-selected' : ''} onClick={() => navigate(campaignRowTarget(row.status, row.id))}>
                      {canSelect && (
                        <td onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Chọn ${row.name || 'chiến dịch chưa đặt tên'}`}
                            checked={selectedIds.includes(row.id)}
                            onChange={() => setSelectedIds(toggleSelection(selectedIds, row.id))}
                          />
                        </td>
                      )}
                      <td>
                        <b>{row.name || 'Chiến dịch chưa đặt tên'}</b>
                        {reasons[row.id]
                          ? <small className="row-reason">{reasons[row.id]}</small>
                          : <small className="cell-subtitle">{row.subject}</small>}
                      </td>
                      <td>{row.progress ? `${row.progress.totalSnapshot} địa chỉ` : '—'}</td>
                      <td>{timeLabel}{countdown && <small className="cell-subtitle">{countdown}</small>}</td>
                      <td>
                        {/* A draft has no send progress. The .send-progress.scheduled
                            style forces a full-width dashed bar meaning "waiting to
                            send", which would be a lie for something never scheduled. */}
                        {row.status === 'draft' ? (
                          <span className="cell-subtitle">Bản nháp chưa gửi</span>
                        ) : row.progress ? (
                          <div className="send-progress">
                            <div><i style={{ width: `${row.progress.percent}%` }} /></div>
                            <span>{row.progress.percent}%</span>
                            <small>{row.progress.sent} gửi · {row.progress.pending} chờ · {row.progress.failed} lỗi</small>
                          </div>
                        ) : (
                          <div className="send-progress scheduled">
                            <div><i style={{ width: '0%' }} /></div>
                            <span>Chờ gửi</span>
                          </div>
                        )}
                      </td>
                      <td><span className={`status ${statusClass(row.status)}`}>{CAMPAIGN_STATUS_LABEL[row.status] ?? row.status}</span></td>
                      <td onClick={(event) => event.stopPropagation()}>
                        {canResend ? (
                          <button className="row-resend" onClick={() => setResendTarget(row)}>
                            <UiIcon name="refresh" size={15} /> Gửi lại
                          </button>
                        ) : canSelect ? (
                          <EntityActionMenu
                            label={`Tùy chọn chiến dịch ${row.name || 'chưa đặt tên'}`}
                            items={[
                              { label: row.status === 'draft' ? 'Tiếp tục soạn' : 'Xem chi tiết', icon: 'arrowRight', onSelect: () => navigate(campaignRowTarget(row.status, row.id)) },
                              { label: 'Nhân bản chiến dịch', icon: 'copy', onSelect: () => { setSelectedIds([row.id]); void runBulk('duplicate', [row.id]); } },
                            ]}
                          />
                        ) : (
                          <Link to={campaignRowTarget(row.status, row.id)} className="row-menu" aria-label={`Xem chi tiết ${row.name || 'chiến dịch chưa đặt tên'}`}>
                            <UiIcon name="more" size={17} />
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {filterOpen && (
        <HistoryFilterDialog
          query={query}
          onApply={(next) => { setQuery(next); setFilterOpen(false); }}
          onReset={() => { setQuery({}); setFilterOpen(false); }}
          onClose={() => setFilterOpen(false)}
        />
      )}

      {resendTarget && (
        <ResendConfirmDialog
          row={resendTarget}
          onClose={() => setResendTarget(null)}
          onResent={(recipientCount) => { setResendTarget(null); setToast(`Đã gửi lại ${recipientCount} email`); void load(); }}
        />
      )}
    </section>
  );
}
