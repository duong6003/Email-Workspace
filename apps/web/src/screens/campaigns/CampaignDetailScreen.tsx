import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getCampaignDraft, getCampaignProgress, type CampaignDraft, type CampaignProgress } from '../../api/campaigns.js';
import { ApiError } from '../../api/problem.js';
import { socket, subscribeToCampaigns } from '../../api/realtime.js';
import { pollIntervalMs, useRealtimeStatus } from '../../api/realtime-status.js';
import { applyProgressEvent, type CampaignProgressEvent } from './campaign-realtime.js';
import { formatEta } from './eta-format.js';
import { createCampaignExport, fetchCampaignRecipients, getCampaignExport, campaignExportDownloadUrl, pauseCampaign, resumeCampaign, type CampaignExport, type CampaignRecipientHistory } from '../../api/campaign-list.js';
import { useSession } from '../../auth/use-session.js';
import { hasPermission, PERMISSIONS } from '../../auth/permissions.js';
import { RECIPIENT_STATUS_LABEL, recipientFailureReason, recipientStatusTone } from './recipient-delivery.js';

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'ĐÃ LÊN LỊCH', queued: 'SẴN SÀNG GỬI', validating: 'ĐANG KIỂM TRA', sending: 'ĐANG GỬI', paused: 'ĐÃ TẠM DỪNG', completed: 'GỬI HOÀN TẤT', partial_failed: 'HOÀN TẤT, CÓ EMAIL LỖI', failed: 'KHÔNG GỬI ĐƯỢC', cancelled: 'ĐÃ DỪNG',
};

/**
 * M6-S1 CP11 (BR-HIS-002, UI-HIS-002). The approved historyDetail overlay
 * (design-reference/.../action-overlays.tsx:220), rebuilt as a routed page
 * (/history/:campaignId, EXECPLAN.md:429) rather than a modal -- M6-S3's
 * History list will link its own rows at this same route instead of
 * rebuilding it. The approved layout's 4 headline tiles keep their
 * presentation (Tổng/Đã gửi/Đang chờ/Lỗi); delivered/bounced/skipped/đang xử
 * lý (BR-HIS-002's other 5 fields) move into history-meta rows (DEC-130) --
 * the approved design's own second content region, not a fabricated one.
 *
 * M6-S3 CP11 wires the approved footer's two previously-inert buttons
 * ("Tạm dừng"/BR-SEND-009, "Tải báo cáo"/BR-HIS-003/007) and adds a
 * status-scoped drill-down (BR-HIS-003): clicking a stat tile creates a
 * background export filtered to that one message status, reusing the same
 * export machinery "Tải báo cáo" uses rather than a second recipient-list
 * endpoint this node does not build.
 */
export function CampaignDetailScreen() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const session = useSession();
  const canExport = hasPermission(session.data?.permissions, PERMISSIONS.HISTORY_EXPORT);
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [progress, setProgress] = useState<CampaignProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [exportJob, setExportJob] = useState<CampaignExport | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<CampaignRecipientHistory[]>([]);
  const [recipientCursor, setRecipientCursor] = useState<string | null>(null);
  const [recipientStatus, setRecipientStatus] = useState<CampaignRecipientHistory['status'] | ''>('');
  const [recipientSearch, setRecipientSearch] = useState('');
  const [recipientSearchInput, setRecipientSearchInput] = useState('');
  const [recipientLoading, setRecipientLoading] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const realtimeStatus = useRealtimeStatus();
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const recipientRefreshTimer = useRef<number | null>(null);
  const recipientRequestVersion = useRef(0);

  useEffect(() => {
    if (!campaignId) return;
    void getCampaignDraft(campaignId).then(setDraft).catch(() => undefined);
  }, [campaignId]);

  // A draft has never been sent, so there is no progress and no per-recipient
  // result to show here. Reaching /campaigns/:id for one means the caller
  // wanted the composer.
  const navigate = useNavigate();
  useEffect(() => {
    if (draft?.status === 'draft' && campaignId) navigate(`/campaigns/${campaignId}/edit`, { replace: true });
  }, [draft?.status, campaignId, navigate]);

  const loadProgress = useCallback(() => {
    if (!campaignId) return Promise.resolve();
    return getCampaignProgress(campaignId)
      .then(setProgress)
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : 'Không thể tải tiến độ gửi.'));
  }, [campaignId]);

  const loadRecipients = useCallback((cursor?: string, append = false) => {
    if (!campaignId) return Promise.resolve();
    const requestVersion = ++recipientRequestVersion.current;
    setRecipientLoading(true); setRecipientError(null);
    return fetchCampaignRecipients(campaignId, { status: recipientStatus || undefined, search: recipientSearch || undefined, cursor, limit: 50 })
      .then((page) => { if (requestVersion !== recipientRequestVersion.current) return; setRecipients((current) => append ? [...current, ...page.items] : page.items); setRecipientCursor(page.nextCursor); })
      .catch((cause) => { if (requestVersion === recipientRequestVersion.current) setRecipientError(cause instanceof ApiError ? cause.message : 'Không thể tải chi tiết người nhận.'); })
      .finally(() => { if (requestVersion === recipientRequestVersion.current) setRecipientLoading(false); });
  }, [campaignId, recipientSearch, recipientStatus]);

  useEffect(() => { void loadRecipients(); }, [loadRecipients]);

  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    const load = () => getCampaignProgress(campaignId)
      .then((result) => { if (!cancelled) setProgress(result); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'Không thể tải tiến độ gửi.'); });
    void load();
    const id = window.setInterval(() => void load(), pollIntervalMs(realtimeStatus));
    return () => { cancelled = true; window.clearInterval(id); };
  }, [campaignId, realtimeStatus]);

  useEffect(() => {
    if (!campaignId) return;
    let cursor: { version: number } | null = null;
    const refetch = () => {
      void getCampaignProgress(campaignId).then(setProgress).catch(() => undefined);
      if (recipientRefreshTimer.current === null) recipientRefreshTimer.current = window.setTimeout(() => { recipientRefreshTimer.current = null; void loadRecipients(); }, 1_200);
    };
    const handleProgress = (event: CampaignProgressEvent) => {
      const next = applyProgressEvent(cursor, event, campaignId);
      if (next !== cursor) { cursor = next; refetch(); }
    };
    socket.on('campaign.progress', handleProgress);
    subscribeToCampaigns([campaignId]);
    return () => { socket.off('campaign.progress', handleProgress); if (recipientRefreshTimer.current !== null) window.clearTimeout(recipientRefreshTimer.current); };
  }, [campaignId, loadRecipients]);

  // BR-HIS-003/007: poll a pending export job until it completes.
  useEffect(() => {
    if (!campaignId || !exportJob || exportJob.status === 'completed' || exportJob.status === 'failed') return;
    const id = window.setInterval(() => {
      getCampaignExport(campaignId, exportJob.id).then(setExportJob).catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(id);
  }, [campaignId, exportJob]);

  if (!campaignId) return null;

  const etaText = progress ? formatEta(progress.eta) : null;
  const processing = progress ? progress.counts.submitted : 0;
  const canPause = progress?.status === 'sending';
  const canResume = progress?.status === 'paused';

  const togglePause = () => {
    if (!campaignId) return;
    setPausing(true);
    setPauseError(null);
    const action = canResume ? resumeCampaign : pauseCampaign;
    action(campaignId, idempotencyKeyRef.current)
      .then(() => { idempotencyKeyRef.current = crypto.randomUUID(); return loadProgress(); })
      .catch((cause) => setPauseError(cause instanceof ApiError ? cause.message : 'Không thể cập nhật trạng thái gửi.'))
      .finally(() => setPausing(false));
  };

  const startExport = (statusFilter?: string[]) => {
    if (!campaignId) return;
    setExportError(null);
    createCampaignExport(campaignId, crypto.randomUUID(), statusFilter ? { statusFilter } : {})
      .then(setExportJob)
      .catch((cause) => setExportError(cause instanceof ApiError ? cause.message : 'Không thể tạo báo cáo.'));
  };

  return (
    <section className="workspace-module-frame standard-module-frame">
      <header className="module-frame-toolbar standard-filter-bar">
        <div><h1 style={{ margin: 0, fontSize: 16 }}>Tiến độ gửi email</h1><p style={{ margin: 0 }}>{draft?.name ?? 'Đang tải…'}</p></div>
        <Link to="/campaigns" className="secondary-button">← Quay lại danh sách chiến dịch</Link>
      </header>
      <div className="module-frame-body">
        {realtimeStatus === 'reconnecting' && <p className="login-error" role="status">Đang kết nối lại…</p>}
        {error && <p className="login-error" role="alert">{error}</p>}
        {pauseError && <p className="login-error" role="alert">{pauseError}</p>}
        {exportError && <p className="login-error" role="alert">{exportError}</p>}
        {recipientError && <p className="login-error" role="alert">{recipientError}</p>}
        {progress && (
          <>
            <div className="live-send-state">
              <div><span><i />{STATUS_LABEL[progress.status] ?? progress.status.toUpperCase()}</span><b>{progress.percent}%</b></div>
              <div className="live-progress-track"><i style={{ width: `${progress.percent}%` }} /></div>
              <footer>
                <span>{progress.sent + progress.delivered} / {progress.totalSnapshot} email đã xử lý</span>
                {etaText && <b>{etaText}</b>}
              </footer>
            </div>
            <div className="history-stats four">
              <div><b>{progress.totalSnapshot}</b><small>Tổng</small></div>
              <div title="Sent = đã gửi tới máy chủ nhận thư; Delivered = xác nhận đã tới hộp thư. Hai con số khác nhau vì delivered luôn theo sau và có thể ít hơn sent.">
                <b>{progress.sent}</b><small>Đã gửi</small>
              </div>
              <div><b>{progress.counts.pending + progress.counts.queued}</b><small>Đang chờ</small></div>
              {canExport ? (
                <button type="button" className="stat-tile-button" onClick={() => startExport(['failed'])} disabled={progress.failed === 0}>
                  <b>{progress.failed}</b><small>Lỗi (tải danh sách)</small>
                </button>
              ) : (
                <div><b>{progress.failed}</b><small>Lỗi</small></div>
              )}
            </div>
            <div className="history-meta">
              <p><span>Đang xử lý</span><b>{processing}</b></p>
              <p><span>Đã giao thành công</span><b>{progress.delivered}</b></p>
              <p><span>Không giao được</span><b>{progress.counts.bounced}</b></p>
              <p><span>Không gửi theo chính sách</span><b>{progress.counts.skipped}</b></p>
              {draft && <p><span>Cấu hình gửi</span><b>{draft.sender.fromEmail ?? 'Mặc định'}</b></p>}
            </div>
            {exportJob && (
              <div className="module-card" style={{ padding: 12, marginTop: 12 }}>
                {exportJob.status === 'completed' && (
                  <a href={campaignExportDownloadUrl(campaignId, exportJob.id)} className="secondary-button">Tải xuống báo cáo ({exportJob.rowCount} dòng)</a>
                )}
                {exportJob.status === 'failed' && <span className="status danger">Xuất báo cáo thất bại.</span>}
                {(exportJob.status === 'queued' || exportJob.status === 'running') && <span role="status">Đang chuẩn bị báo cáo…</span>}
              </div>
            )}
            <section className="recipient-delivery-detail" aria-labelledby="recipient-delivery-title">
              <header><div><h2 id="recipient-delivery-title">Kết quả theo người nhận</h2><p>Theo dõi ai đã nhận, ai thất bại và lý do mới nhất từ worker hoặc nhà cung cấp.</p></div></header>
              <form className="recipient-delivery-filters" onSubmit={(event) => { event.preventDefault(); setRecipientSearch(recipientSearchInput.trim()); }}>
                <label><span>Trạng thái</span><select value={recipientStatus} onChange={(event) => setRecipientStatus(event.target.value as CampaignRecipientHistory['status'] | '')}><option value="">Tất cả trạng thái</option>{Object.entries(RECIPIENT_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>Tìm người nhận</span><input value={recipientSearchInput} onChange={(event) => setRecipientSearchInput(event.target.value)} placeholder="Tên hoặc email" /></label>
                <button className="secondary-button" disabled={recipientLoading}>Áp dụng</button>
              </form>
              <div className="recipient-delivery-table-wrap">
                <table className="recipient-delivery-table"><thead><tr><th>Người nhận</th><th>Trạng thái</th><th>Lần thử</th><th>Kết quả / lý do</th><th>Cập nhật</th></tr></thead><tbody>
                  {recipients.map((row) => { const reason = recipientFailureReason(row); return <tr key={row.id}><td><b>{row.displayName || row.email}</b><small>{row.displayName ? row.email : 'Email người nhận đã đóng băng'}</small></td><td><span className={`status ${recipientStatusTone(row.status)}`}>{RECIPIENT_STATUS_LABEL[row.status]}</span></td><td><b>{row.attemptCount}</b>{row.nextRetryAt && <small>Thử lại {new Date(row.nextRetryAt).toLocaleString('vi-VN')}</small>}</td><td className={reason ? 'delivery-reason' : ''}><b>{reason ?? (row.status === 'delivered' ? 'Nhà cung cấp xác nhận đã nhận.' : row.status === 'submitted' ? 'Máy chủ nhận đã chấp nhận email.' : 'Chưa có lỗi được ghi nhận.')}</b>{row.lastErrorCode && <small>{row.lastErrorCode}{row.lastErrorClass ? ` · ${row.lastErrorClass}` : ''}</small>}{row.providerMessageId && <small>ID: {row.providerMessageId}</small>}</td><td>{new Date(row.updatedAt).toLocaleString('vi-VN')}</td></tr>; })}
                  {!recipientLoading && recipients.length === 0 && <tr><td colSpan={5}><div className="recipient-delivery-empty">Không có người nhận phù hợp bộ lọc.</div></td></tr>}
                </tbody></table>
              </div>
              <footer>{recipientLoading && <span role="status">Đang tải chi tiết…</span>}{recipientCursor && <button className="secondary-button" disabled={recipientLoading} onClick={() => void loadRecipients(recipientCursor, true)}>Tải thêm</button>}</footer>
            </section>
          </>
        )}
      </div>
      <footer className="module-frame-toolbar" style={{ borderTop: '1px solid var(--border-subtle, #e5e7eb)' }}>
        {(canPause || canResume) && (
          <button type="button" className="soft-button" onClick={togglePause} disabled={pausing}>
            {canResume ? 'Tiếp tục' : 'Tạm dừng'}
          </button>
        )}
        <span className="footer-spacer" />
        {canExport && (
          <button type="button" className="primary-button" onClick={() => startExport()}>Tải báo cáo</button>
        )}
      </footer>
    </section>
  );
}
