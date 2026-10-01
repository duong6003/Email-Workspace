import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { UiIcon } from '../../app/ui-icons.js';
import { EntityActionMenu } from '../../components/EntityActionMenu.js';
import { ApiError } from '../../api/problem.js';
import { importJobErrorFileUrl, listImportJobs, type ImportJob } from '../../api/import-jobs.js';
import { getImportJob } from '../../api/import-jobs.js';
import { bulkJobErrorFileUrl, bulkJobResultFileUrl, createBulkJob, getBulkJob, listBulkJobs, type BulkJob } from '../../api/bulk-jobs.js';
import { deleteRecipient, listRecipients, type Recipient, type RecipientStatus } from '../../api/recipients.js';
import { getRecipientSegments, listRecipientLists, listTags, type RecipientList, type Tag } from '../../api/segments.js';
import { AddRecipientOverlay } from '../../overlays/AddRecipientOverlay.js';
import { ImportRecipientsOverlay } from '../../overlays/ImportRecipientsOverlay.js';
import { BulkCustomDataOverlay } from '../../overlays/BulkCustomDataOverlay.js';
import { BulkSegmentOverlay } from '../../overlays/BulkSegmentOverlay.js';
import { ManageSegmentOverlay } from '../../overlays/ManageSegmentOverlay.js';
import { RecipientActionsOverlay } from '../../overlays/RecipientActionsOverlay.js';
import { RecipientFilterOverlay, type RecipientFilterState } from '../../overlays/RecipientFilterOverlay.js';
import { socket, subscribeToJobs } from '../../api/realtime.js';
import { activeJobIds, isImportJobEvent } from './import-realtime.js';
import { isBulkJobEvent } from './bulk-realtime.js';
import { jobOutcomeBreakdown } from './job-outcomes.js';

/**
 * Ported verbatim (DOM + class names) from the handoff's `Recipients` "all"
 * view (design-reference/ui-handoff-v2/source/app/page.tsx, function
 * Recipients, recipientView === "all" branch) per EXECPLAN §12. The
 * lists/tags/imports tabs render the same tablist chrome (matching the
 * handoff's header/tablist markup) but their bodies are out of this node's
 * scope (M2-S2/M2-S4) and show an honest placeholder instead of mock data,
 * same pattern as apps/web/src/screens/placeholder/ComingSoon.tsx.
 */
function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="search-box">
      <UiIcon name="search" />
      <input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

/**
 * Inline `error` state for the recipient table (design-reference/
 * ui-source-contract.yaml -> required_states). Reuses the same
 * module-card/.status-danger/warning-icon vocabulary as
 * SystemErrorScreen/PermissionDeniedScreen, but as a <section> nested
 * inside RecipientsScreen's own module-frame -- unlike SystemErrorScreen
 * (which fully replaces the page and owns the page's only <main>/<h1> when
 * RequireAuth renders it), this error is scoped to the recipient list
 * widget only, so it must not introduce a second <main>/<h1> landmark.
 */
function RecipientLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="module-card permission-denied-card">
      <i aria-hidden="true">
        <UiIcon name="warning" size={22} />
      </i>
      <span className="status danger" role="status">
        Không thể tải dữ liệu
      </span>
      <h2>Không thể tải danh sách người nhận</h2>
      <p>Đã xảy ra lỗi khi tải dữ liệu người nhận. Vui lòng thử lại.</p>
      <button type="button" className="secondary-button" onClick={onRetry}>
        <UiIcon name="refresh" size={16} /> Thử lại
      </button>
    </div>
  );
}

function FilterButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button className="filter-button" onClick={onClick}>
      <span>
        <UiIcon name="filter" size={15} />
      </span>
      Bộ lọc
      {count > 0 && <em>{count}</em>}
    </button>
  );
}

function initials(person: Pick<Recipient, 'firstName' | 'lastName' | 'email'>): string {
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
  if (!name) return person.email.slice(0, 2).toUpperCase();
  return name
    .split(' ')
    .slice(-2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function displayName(person: Pick<Recipient, 'firstName' | 'lastName' | 'email'>): string {
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
  return name || person.email;
}

const statusLabel: Record<RecipientStatus, string> = {
  active: 'Hợp lệ',
  paused: 'Tạm dừng',
  unsubscribed: 'Đã hủy đăng ký',
  bounced: 'Không gửi được',
};

const statusClass: Record<RecipientStatus, string> = {
  active: 'success',
  paused: 'warning',
  unsubscribed: 'warning',
  bounced: 'warning',
};

export function RecipientsScreen() {
  const [searchParams] = useSearchParams();
  const requestedView = searchParams.get('view');
  const [recipientView, setRecipientView] = useState<'all' | 'lists' | 'tags' | 'imports'>(requestedView === 'lists' || requestedView === 'tags' || requestedView === 'imports' ? requestedView : 'all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<RecipientFilterState>({ status: [], listIds: [], tagIds: [] });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [items, setItems] = useState<Recipient[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [overlay, setOverlay] = useState<'add' | 'filter' | 'bulk-custom-data' | 'bulk-tag' | 'bulk-list' | { kind: 'actions'; recipient: Recipient } | { kind: 'segment'; segment: { kind: 'list'; item?: RecipientList } | { kind: 'tag'; item?: Tag } } | null>(null);
  const [importOverlayOpen, setImportOverlayOpen] = useState(false);
  const [importJobs, setImportJobs] = useState<ImportJob[] | null>(null);
  const [importError, setImportError] = useState(false);
  const [bulkJobs, setBulkJobs] = useState<BulkJob[] | null>(null);
  const [bulkError, setBulkError] = useState(false);
  const [recipientLists, setRecipientLists] = useState<RecipientList[] | null>(null);
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [segmentsError, setSegmentsError] = useState(false);
  const [recipientTags, setRecipientTags] = useState<Record<string, Tag[]>>({});
  const [tagPopoverFor, setTagPopoverFor] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const response = await listRecipients({
          search: search || undefined,
          status: filters.status.length ? filters.status : undefined,
          listIds: filters.listIds.length ? filters.listIds : undefined,
          tagIds: filters.tagIds.length ? filters.tagIds : undefined,
          cursor: cursor ?? undefined,
          limit: 25,
        });
        setItems(response.items);
        setTotal(response.total);
        setNextCursor(response.nextCursor);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [search, filters],
  );

  useEffect(() => {
    setCursorStack([null]);
    setPageIndex(0);
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setSearch(searchInput), 300);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  const goNext = () => {
    if (!nextCursor) return;
    const nextStack = [...cursorStack.slice(0, pageIndex + 1), nextCursor];
    setCursorStack(nextStack);
    setPageIndex(pageIndex + 1);
    void load(nextCursor);
  };

  const goPrev = () => {
    if (pageIndex === 0) return;
    setPageIndex(pageIndex - 1);
    void load(cursorStack[pageIndex - 1] ?? null);
  };

  const refresh = () => void load(cursorStack[pageIndex] ?? null);

  const handleDelete = async (recipient: Recipient) => {
    try {
      await deleteRecipient(recipient.id);
      showToast(`Đã xóa ${displayName(recipient)}`);
      setOverlay(null);
      refresh();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Không thể xóa người nhận.');
    }
  };

  const loadImportJobs = useCallback(async () => {
    setImportError(false);
    try {
      setImportJobs(await listImportJobs());
    } catch {
      setImportError(true);
    }
  }, []);

  const loadBulkJobs = useCallback(async () => {
    setBulkError(false);
    try {
      setBulkJobs(await listBulkJobs());
    } catch {
      setBulkError(true);
    }
  }, []);

  const createRecipientBulkJob = async (action: 'export' | 'delete') => {
    if (selectedIds.length === 0) return;
    try {
      const job = await createBulkJob({ action, actionPayload: {}, recipientIds: selectedIds });
      setSelectedIds([]);
      showToast(action === 'export'
        ? `Đã tạo job xuất ${job.resolvedCount.toLocaleString('vi-VN')} người nhận.`
        : `Đã tạo job xóa ${job.resolvedCount.toLocaleString('vi-VN')} người nhận.`);
      refresh();
      await loadBulkJobs();
    } catch (cause) {
      showToast(cause instanceof ApiError ? cause.message : 'Không thể tạo job hàng loạt.');
    }
  };

  useEffect(() => {
    if (recipientView === 'imports') void loadImportJobs();
  }, [recipientView, loadImportJobs]);

  useEffect(() => {
    if (recipientView === 'all' && bulkJobs === null) void loadBulkJobs();
  }, [recipientView, bulkJobs, loadBulkJobs]);

  const loadSegments = useCallback(async () => {
    setSegmentsError(false);
    try {
      const [listsPage, tagsPage] = await Promise.all([listRecipientLists({ search: search || undefined, limit: 100 }), listTags({ search: search || undefined, limit: 100 })]);
      setRecipientLists(listsPage.items);
      setTags(tagsPage.items);
    } catch {
      setSegmentsError(true);
    }
  }, [search]);

  useEffect(() => {
    if (recipientView === 'lists' || recipientView === 'tags') void loadSegments();
  }, [recipientView, loadSegments]);

  useEffect(() => {
    if (!items?.length) { setRecipientTags({}); return; }
    let cancelled = false;
    void Promise.all(items.map(async (item) => [item.id, (await getRecipientSegments(item.id)).tags] as const))
      .then((entries) => { if (!cancelled) setRecipientTags(Object.fromEntries(entries)); })
      .catch(() => { if (!cancelled) setRecipientTags({}); });
    return () => { cancelled = true; };
  }, [items]);

  useEffect(() => {
    const activeIds = recipientView === 'imports' && importJobs ? activeJobIds(importJobs) : [];
    if (activeIds.length === 0) return;
    const reconcile = (event: { aggregate_id?: unknown; event_type?: unknown }) => {
      const jobId = typeof event.aggregate_id === 'string' ? event.aggregate_id : null;
      if (!jobId || !activeIds.includes(jobId) || !isImportJobEvent(event, jobId)) return;
      void getImportJob(jobId).then((updated) => setImportJobs((current) => current?.map((job) => job.id === updated.id ? updated : job) ?? current)).catch(() => void loadImportJobs());
    };
    subscribeToJobs(activeIds);
    socket.on('import.progress', reconcile);
    socket.on('import.completed', reconcile);
    return () => { socket.off('import.progress', reconcile); socket.off('import.completed', reconcile); };
  }, [recipientView, importJobs, loadImportJobs]);

  useEffect(() => {
    const activeIds = recipientView === 'all' && bulkJobs
      ? activeJobIds(bulkJobs.map((job) => ({ id: job.jobId, status: job.status })))
      : [];
    if (activeIds.length === 0) return;
    const reconcile = (event: { aggregate_id?: unknown; event_type?: unknown }) => {
      const jobId = typeof event.aggregate_id === 'string' ? event.aggregate_id : null;
      if (!jobId || !activeIds.includes(jobId) || !isBulkJobEvent(event, jobId)) return;
      void getBulkJob(jobId).then((updated) => setBulkJobs((current) => current?.map((job) => job.jobId === updated.jobId ? updated : job) ?? current)).catch(() => void loadBulkJobs());
    };
    subscribeToJobs(activeIds);
    socket.on('bulk_update.progress', reconcile);
    socket.on('bulk_update.completed', reconcile);
    return () => { socket.off('bulk_update.progress', reconcile); socket.off('bulk_update.completed', reconcile); };
  }, [recipientView, bulkJobs, loadBulkJobs]);

  const viewLabels = { all: 'Tất cả người nhận', lists: 'Danh sách', tags: 'Tag', imports: 'Import' } as const;
  const searchPlaceholders = {
    all: 'Tìm theo tên, email, phòng ban',
    lists: 'Tìm danh sách người nhận',
    tags: 'Tìm tag',
    imports: 'Tìm theo tên file import',
  } as const;

  const activeFilterCount = filters.status.length + filters.listIds.length + filters.tagIds.length;
  const filterLists = recipientLists ?? [];
  const filterTags = tags ?? [];

  return (
    <section className="workspace-module-frame standard-module-frame recipients-module">
      <header className="recipient-section-nav">
        <div role="tablist" aria-label="Quản lý người nhận">
          {(Object.keys(viewLabels) as (keyof typeof viewLabels)[]).map((key) => (
            <button
              role="tab"
              aria-selected={recipientView === key}
              className={recipientView === key ? 'active' : ''}
              key={key}
              onClick={() => {
                setRecipientView(key);
                setSelectedIds([]);
              }}
            >
              {viewLabels[key]}
            </button>
          ))}
        </div>
        <small>
          {recipientView === 'lists'
            ? 'Nhóm người nhận được lưu để tái sử dụng khi gửi email.'
            : recipientView === 'tags'
              ? 'Nhãn linh động có thể gắn cho nhiều người nhận.'
              : recipientView === 'imports'
                ? 'Theo dõi file, mapping và chất lượng dữ liệu đã nhập.'
                : 'Nguồn dữ liệu người nhận dùng chung của hệ thống.'}
        </small>
      </header>

      <header className="module-frame-toolbar standard-filter-bar">
        <SearchBox value={searchInput} onChange={setSearchInput} placeholder={searchPlaceholders[recipientView]} />
        {recipientView === 'all' && (
          <>
            <FilterButton count={activeFilterCount} onClick={() => { void loadSegments(); setOverlay('filter'); }} />
            <button className="secondary-button" onClick={() => setImportOverlayOpen(true)}>
              <UiIcon name="upload" size={16} /> Import Excel
            </button>
            <button className="primary-button" onClick={() => setOverlay('add')}>
              <UiIcon name="plus" size={16} /> Thêm người nhận
            </button>
          </>
        )}
        {recipientView === 'lists' && <button className="primary-button" onClick={() => setOverlay({ kind: 'segment', segment: { kind: 'list' } })}><UiIcon name="plus" size={16} /> Tạo danh sách</button>}
        {recipientView === 'tags' && <button className="primary-button" onClick={() => setOverlay({ kind: 'segment', segment: { kind: 'tag' } })}><UiIcon name="plus" size={16} /> Quản lý tag</button>}
        {recipientView === 'imports' && <button className="primary-button" onClick={() => setImportOverlayOpen(true)}><UiIcon name="upload" size={16} /> Import file mới</button>}
      </header>

      <div className="module-frame-body">
        {(recipientView === 'lists' || recipientView === 'tags') && segmentsError && <RecipientLoadError onRetry={() => void loadSegments()} />}
        {recipientView === 'lists' && !segmentsError && recipientLists === null && <div className="module-card" role="status" style={{ padding: 24 }}><p>Đang tải danh sách…</p></div>}
        {recipientView === 'lists' && !segmentsError && recipientLists !== null && (recipientLists.length === 0 ? <div className="module-card" style={{ padding: 24 }}><h2 style={{ marginTop: 0 }}>Chưa có danh sách</h2><p>Tạo danh sách đầu tiên để lưu một nhóm người nhận có chủ đích.</p></div> : <div className="recipient-list-grid">{recipientLists.map((list, index) => <article key={list.id}><header><span className={`recipient-list-icon tone-${index % 4}`}>≡</span><button className="row-menu" aria-label={`Tùy chọn ${list.name}`} onClick={() => setOverlay({ kind: 'segment', segment: { kind: 'list', item: list } })}><UiIcon name="more" size={17} /></button></header><h3>{list.name}</h3><p>{list.description || 'Nhóm người nhận được lưu để tái sử dụng.'}</p><div><span><b>{list.memberCount.toLocaleString('vi-VN')}</b><small>Người nhận</small></span><span><b>{list.memberCount.toLocaleString('vi-VN')}</b><small>Hợp lệ</small></span></div><footer><small>Cập nhật {new Date(list.updatedAt).toLocaleString('vi-VN')}</small><button onClick={() => { setFilters({ status: [], listIds: [list.id], tagIds: [] }); setRecipientView('all'); }}>Xem thành viên <UiIcon name="arrowRight" size={14} /></button></footer></article>)}</div>)}
        {recipientView === 'tags' && !segmentsError && tags === null && <div className="module-card" role="status" style={{ padding: 24 }}><p>Đang tải tag…</p></div>}
        {recipientView === 'tags' && !segmentsError && tags !== null && <div className="recipient-tag-directory"><div className="tag-directory-summary"><div><b>{tags.length}</b><span>Tag đang hoạt động</span></div><p>Tag là nhãn linh động. Một người có thể có nhiều tag và vẫn thuộc nhiều danh sách.</p></div>{tags.length === 0 ? <div className="module-card" style={{ padding: 24 }}><h2 style={{ marginTop: 0 }}>Chưa có tag</h2><p>Tạo tag để phân loại người nhận linh động.</p></div> : <div className="tag-directory-grid">{tags.map((tag) => <article key={tag.id}><span style={{ background: tag.color }}>#</span><div><b>{tag.name}</b><small>{tag.memberCount.toLocaleString('vi-VN')} người nhận</small></div><button className="row-menu" aria-label={`Tùy chọn tag ${tag.name}`} onClick={() => setOverlay({ kind: 'segment', segment: { kind: 'tag', item: tag } })}><UiIcon name="more" size={17} /></button></article>)}</div>}</div>}

        {recipientView === 'imports' && (
          <div className="recipient-import-history">
            <div className="import-guidance"><span><UiIcon name="upload" size={18} /></span><div><b>Import có kiểm tra và mapping dữ liệu</b><small>Hỗ trợ email, thông tin cơ bản và theo dõi tiến trình xử lý.</small></div><button className="secondary-button" onClick={() => setImportOverlayOpen(true)}>Import file mới</button></div>
            {importError ? <RecipientLoadError onRetry={() => void loadImportJobs()} /> : importJobs === null ? <div className="module-card" role="status" style={{ padding: 24 }}><p>Đang tải lịch sử import…</p></div> : importJobs.length === 0 ? <div className="module-card" style={{ padding: 24 }}><h2 style={{ marginTop: 0 }}>Chưa có lần import nào</h2><p>Chọn file CSV để tạo job import đầu tiên.</p></div> : <div className="table-wrap"><table><thead><tr><th>TÊN FILE</th><th>TỔNG DÒNG</th><th>THÀNH CÔNG</th><th>BỎ QUA</th><th>CẦN KIỂM TRA</th><th>THỜI GIAN</th><th>TRẠNG THÁI</th></tr></thead><tbody>{importJobs.map((job) => { const outcomes = jobOutcomeBreakdown(job); return <tr key={job.id}><td><b>{job.fileName}</b><small className="cell-subtitle">Import job · {job.id.slice(0, 8)}</small></td><td>{job.totalRows.toLocaleString('vi-VN')}</td><td>{outcomes.succeeded.toLocaleString('vi-VN')}</td><td>{outcomes.skipped.toLocaleString('vi-VN')}</td><td>{outcomes.failed.toLocaleString('vi-VN')}</td><td>{new Date(job.createdAt).toLocaleString('vi-VN')}</td><td><span className={`status ${job.status === 'completed' ? 'success' : job.status === 'failed' ? 'warning' : 'warning'}`}>{job.status === 'completed' ? 'Hoàn tất' : job.status === 'partial_success' ? 'Hoàn tất một phần' : job.status === 'failed' ? 'Thất bại' : job.status === 'running' ? 'Đang xử lý' : 'Đang chờ'}</span>{outcomes.unfinished > 0 && <small className="cell-subtitle">{outcomes.unfinished} chưa hoàn tất</small>}{job.failedRows > 0 && <a className="cell-subtitle" href={importJobErrorFileUrl(job.id)}>Tải lỗi CSV</a>}</td></tr>; })}</tbody></table></div>}
          </div>
        )}

        {recipientView === 'all' && Boolean(error) && !loading && <RecipientLoadError onRetry={refresh} />}

        {recipientView === 'all' && !error && loading && items === null && (
          <div className="module-card" role="status" aria-live="polite" style={{ padding: 24 }}>
            <p>Đang tải người nhận…</p>
          </div>
        )}

        {recipientView === 'all' && !error && items !== null && (
          <>
            {activeFilterCount > 0 && (
              <div className="active-filter-row">
                <span>Đang lọc:</span>
                {filters.status.map((status) => (
                  <button key={status} onClick={() => setFilters((current) => ({ ...current, status: current.status.filter((item) => item !== status) }))}>
                    {statusLabel[status]}
                    <i>×</i>
                  </button>
                ))}
                {filters.listIds.map((id) => {
                  const list = filterLists.find((item) => item.id === id);
                  return <button key={id} onClick={() => setFilters((current) => ({ ...current, listIds: current.listIds.filter((item) => item !== id) }))}>{list?.name ?? 'Danh sách'}<i>×</i></button>;
                })}
                {filters.tagIds.map((id) => {
                  const tag = filterTags.find((item) => item.id === id);
                  return <button key={id} onClick={() => setFilters((current) => ({ ...current, tagIds: current.tagIds.filter((item) => item !== id) }))}>{tag?.name ?? 'Tag'}<i>×</i></button>;
                })}
                <button className="clear-filters" onClick={() => setFilters({ status: [], listIds: [], tagIds: [] })}>
                  Xóa tất cả
                </button>
              </div>
            )}

            <div className="data-summary">
              <span>
                <b>{total.toLocaleString('vi-VN')}</b> người nhận
              </span>
            </div>

            {bulkError ? <RecipientLoadError onRetry={() => void loadBulkJobs()} /> : bulkJobs?.length ? (
              <div className="module-card" style={{ padding: 16, marginBottom: 16 }} aria-label="Kết quả cập nhật hàng loạt">
                <b>Kết quả cập nhật hàng loạt gần đây</b>
                {bulkJobs.slice(0, 3).map((job) => (
                  <div key={job.jobId} className="cell-subtitle" style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'center' }}>
                    <span>{jobOutcomeBreakdown(job).succeeded}/{job.resolvedCount} thành công · {jobOutcomeBreakdown(job).failed} lỗi · {jobOutcomeBreakdown(job).skipped} bỏ qua{jobOutcomeBreakdown(job).unfinished > 0 ? ` · ${jobOutcomeBreakdown(job).unfinished} chưa hoàn tất (retry chỉ tiếp tục phần này)` : ''}</span>
                    <span className={`status ${job.status === 'completed' ? 'success' : 'warning'}`}>{job.status === 'completed' ? 'Hoàn tất' : job.status === 'partial_success' ? 'Hoàn tất một phần' : job.status === 'failed' ? 'Thất bại' : 'Đang xử lý'}</span>
                    {job.failedRows > 0 && <a href={bulkJobErrorFileUrl(job.jobId)}>Tải lỗi CSV</a>}
                    {job.action === 'export' && job.succeededRows > 0 && <a href={bulkJobResultFileUrl(job.jobId)}>Tải CSV</a>}
                  </div>
                ))}
              </div>
            ) : null}

            {(selectedIds.length > 0 || activeFilterCount > 0) && (
              <div className="recipient-bulk-bar">
                <span>
                  {selectedIds.length > 0 ? <><b>{selectedIds.length}</b> người nhận đã chọn</> : <>Dùng <b>bộ lọc hiện tại</b> làm phạm vi cập nhật</>}
                </span>
                <div>
                  {selectedIds.length > 0 && <button onClick={() => setOverlay('bulk-tag')}>Gắn tag</button>}
                  {selectedIds.length > 0 && <button onClick={() => setOverlay('bulk-list')}>Thêm vào danh sách</button>}
                  {selectedIds.length > 0 && <button onClick={() => void createRecipientBulkJob('export')}>Xuất CSV</button>}
                  {selectedIds.length > 0 && <button className="danger-text" onClick={() => void createRecipientBulkJob('delete')}>Xóa đã chọn</button>}
                  <button onClick={() => { void loadSegments(); setOverlay('bulk-custom-data'); }}>Cập nhật dữ liệu</button>
                </div>
                <button aria-label="Bỏ chọn tất cả" onClick={() => setSelectedIds([])}>
                  ×
                </button>
              </div>
            )}

            {items.length === 0 ? (
              <div className="module-card" style={{ padding: 24 }}>
                <h2 style={{ marginTop: 0 }}>Chưa có người nhận</h2>
                <p>{search || activeFilterCount > 0 ? 'Không tìm thấy người nhận phù hợp với bộ lọc hiện tại.' : 'Thêm người nhận đầu tiên để bắt đầu gửi email.'}</p>
              </div>
            ) : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            checked={selectedIds.length === items.length && items.length > 0}
                            onChange={(event) => setSelectedIds(event.target.checked ? items.map((person) => person.id) : [])}
                            aria-label="Chọn tất cả người nhận"
                          />
                        </th>
                        <th>HỌ TÊN</th>
                        <th>EMAIL</th>
                        <th>PHÒNG BAN</th>
                        <th>TAG</th>
                        <th>TRẠNG THÁI</th>
                        <th>
                          <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>Hành động</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((person) => (
                        <tr className={selectedIds.includes(person.id) ? 'is-selected' : ''} key={person.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(person.id)}
                              onChange={(event) =>
                                setSelectedIds((current) => (event.target.checked ? [...current, person.id] : current.filter((id) => id !== person.id)))
                              }
                              aria-label={`Chọn ${displayName(person)}`}
                            />
                          </td>
                          <td>
                            <span className="person-avatar">{initials(person)}</span>
                            <b>{displayName(person)}</b>
                          </td>
                          <td>{person.email}</td>
                          <td>
                            {person.department}
                            {person.location && <small className="cell-subtitle">{person.location}</small>}
                          </td>
                          <td><div className="recipient-tags-cell">{(recipientTags[person.id] ?? []).slice(0, 2).map((tag) => <span className="recipient-tag" key={tag.id} style={{ borderColor: tag.color }}># {tag.name}</span>)}{(recipientTags[person.id]?.length ?? 0) > 2 && <div className="recipient-tag-overflow"><button type="button" aria-expanded={tagPopoverFor === person.id} aria-label={`Xem toàn bộ tag của ${displayName(person)}`} onClick={() => setTagPopoverFor((current) => current === person.id ? null : person.id)}>+{recipientTags[person.id].length - 2}</button>{tagPopoverFor === person.id && <div role="dialog" aria-label={`Toàn bộ tag của ${displayName(person)}`} className="recipient-tag-popover">{recipientTags[person.id].map((tag) => <span className="recipient-tag" key={tag.id} style={{ borderColor: tag.color }}># {tag.name}</span>)}</div>}</div>}</div></td>
                          <td>
                            <span className={`status ${statusClass[person.subscriptionStatus]}`}>{statusLabel[person.subscriptionStatus]}</span>
                          </td>
                          <td>
                            <EntityActionMenu label={`Tùy chọn ${displayName(person)}`} items={[
                              { label: 'Chỉnh sửa người nhận', icon: 'edit', onSelect: () => setOverlay({ kind: 'actions', recipient: person }) },
                              { label: 'Xóa người nhận', icon: 'trash', tone: 'danger', onSelect: () => void handleDelete(person) },
                            ]} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pagination">
                  <span>
                    Trang {pageIndex + 1} · {items.length} / {total.toLocaleString('vi-VN')}
                  </span>
                  <div>
                    <button disabled={pageIndex === 0} onClick={goPrev}>
                      ‹
                    </button>
                    <button disabled={!nextCursor} onClick={goNext}>
                      ›
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {overlay === 'add' && (
        <AddRecipientOverlay
          onClose={() => setOverlay(null)}
          onCreated={() => {
            setOverlay(null);
            showToast('Đã thêm người nhận mới');
            refresh();
          }}
        />
      )}
      {importOverlayOpen && <ImportRecipientsOverlay onClose={() => setImportOverlayOpen(false)} onToast={showToast} onCreated={() => void loadImportJobs()} />}
      {overlay === 'bulk-custom-data' && <BulkCustomDataOverlay recipientIds={selectedIds} filters={filters} lists={filterLists} tags={filterTags} onClose={() => setOverlay(null)} onToast={showToast} onCreated={() => { setSelectedIds([]); refresh(); void loadBulkJobs(); }} />}
      {overlay === 'bulk-tag' && <BulkSegmentOverlay recipientIds={selectedIds} kind="tag" onClose={() => setOverlay(null)} onToast={showToast} onCreated={() => { setSelectedIds([]); refresh(); void loadBulkJobs(); }} />}
      {overlay === 'bulk-list' && <BulkSegmentOverlay recipientIds={selectedIds} kind="list" onClose={() => setOverlay(null)} onToast={showToast} onCreated={() => { setSelectedIds([]); refresh(); void loadBulkJobs(); }} />}
      {overlay === 'filter' && (
        <RecipientFilterOverlay
          value={filters}
          lists={filterLists}
          tags={filterTags}
          onClose={() => setOverlay(null)}
          onApply={(next) => {
            setFilters(next);
            setOverlay(null);
          }}
        />
      )}
      {overlay && typeof overlay === 'object' && overlay.kind === 'actions' && (
        <RecipientActionsOverlay
          recipient={overlay.recipient}
          onClose={() => setOverlay(null)}
          onUpdated={() => {
            setOverlay(null);
            refresh();
          }}
        />
      )}
      {overlay && typeof overlay === 'object' && overlay.kind === 'segment' && <ManageSegmentOverlay segment={overlay.segment} onClose={() => setOverlay(null)} onChanged={(message) => { showToast(message); void loadSegments(); }} />}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <span>✓</span>
          {toast}
        </div>
      )}
    </section>
  );
}

export default RecipientsScreen;
