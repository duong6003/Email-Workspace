import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext, useNavigate, useParams, Link } from 'react-router-dom';
import { cancelCampaign, cancelCampaignSchedule, createCampaignDraft, getCampaignDraft, getCampaignProgress, previewCampaignAudience, updateCampaignDraft, type AudienceResolution, type CampaignAudience, type CampaignDraft, type CampaignPatch, type CampaignProgress } from '../../api/campaigns.js';
import { getTemplateVersion, listTemplateVersions, listTemplates, type TemplateVersion, type TemplateVersionSummary } from '../../api/templates.js';
import { listSenderConfigs, type SenderConfig } from '../../api/senderConfigs.js';
import { ApiError } from '../../api/problem.js';
import { subscribeToCampaigns, socket } from '../../api/realtime.js';
import { pollIntervalMs, useRealtimeStatus } from '../../api/realtime-status.js';
import type { SetShellSaveState } from '../../app/save-state.js';
import { UiIcon } from '../../app/ui-icons.js';
import { RecipientPickerOverlay } from '../../overlays/RecipientPickerOverlay.js';
import { ScheduleSendOverlay } from '../../overlays/ScheduleSendOverlay.js';
import { formatHumanDateTimeInZone } from '../../overlays/schedule-time-preview.js';
import { SendConfirmOverlay } from '../../overlays/SendConfirmOverlay.js';
import { StopSendConfirmOverlay } from '../../overlays/StopSendConfirmOverlay.js';
import { TemplatePickerOverlay } from '../../overlays/TemplatePickerOverlay.js';
import { applyProgressEvent, type CampaignProgressEvent } from '../campaigns/campaign-realtime.js';
import { autosaveReducer, type AutosaveAction, type AutosaveState } from './autosave-reducer.js';
import { localComposeValidation, type ComposeFieldKey } from './compose-validation.js';
import { computeLockCountdown } from './lock-countdown.js';
import { computeVersionUpdatePrompt, type VersionUpdatePrompt } from './template-version-pin.js';

/** BR-SCH-005/A20: a live countdown to the lock window, ticking every second while a scheduled banner is mounted. */
function ScheduledBanner({ draft, onReschedule, onCancelled }: { draft: CampaignDraft; onReschedule: () => void; onCancelled: () => void }) {
  const [now, setNow] = useState(() => new Date());
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!draft.scheduledAtUtc || !draft.scheduledTimezone) return null;
  const countdown = computeLockCountdown(new Date(draft.scheduledAtUtc), draft.scheduleLockWindowSeconds, now);

  const cancelSchedule = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelCampaignSchedule(draft.id);
      onCancelled();
    } catch (cause) {
      setCancelError(cause instanceof ApiError ? cause.message : 'Không thể hủy lịch gửi.');
    } finally {
      setCancelling(false);
    }
  };

  return <div className="frozen-banner" role="status">
    <div>
      <b>Chiến dịch đã được lên lịch gửi.</b>
      <p>Sẽ gửi {formatHumanDateTimeInZone(draft.scheduledAtUtc, draft.scheduledTimezone)} ({draft.scheduledTimezone}). {countdown.label}</p>
      {cancelError && <p className="login-error" role="alert">{cancelError}</p>}
    </div>
    <div className="frozen-banner-actions">
      <button className="secondary-button" disabled={countdown.locked} onClick={onReschedule}>Đổi giờ</button>
      <button className="secondary-button" disabled={countdown.locked || cancelling} onClick={() => void cancelSchedule()}>{cancelling ? 'Đang hủy…' : 'Hủy lịch'}</button>
    </div>
  </div>;
}

const SENDING_STATUS_LABEL: Record<string, string> = {
  sending: 'Đang gửi email…',
  completed: 'Đã gửi xong.',
  partial_failed: 'Đã gửi xong, có một phần lỗi.',
  failed: 'Gửi thất bại.',
};
const SENDING_STATUS_TONE: Record<string, string> = {
  sending: 'status-sending',
  completed: 'status-completed',
  partial_failed: 'status-partial-failed',
  failed: 'status-failed',
};

/**
 * M5-S3 CP8 (BR-SEND-002/010). Real counts from getCampaignProgress (D-92) --
 * polled every 3s while 'sending' so the banner reflects the worker's own
 * scan cadence without claiming BR-SEND-004's realtime contract (M6-S1's).
 * Terminal statuses fetch once and stop; only 'sending' shows the stop-send
 * action.
 */
function SendingBanner({ campaignId, status, onStopSend }: { campaignId: string; status: CampaignDraft['status']; onStopSend: () => void }) {
  const [progress, setProgress] = useState<CampaignProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const realtimeStatus = useRealtimeStatus();
  const wasLive = useRef(realtimeStatus === 'live');

  useEffect(() => {
    let cancelled = false;
    const load = () => getCampaignProgress(campaignId)
      .then((result) => { if (!cancelled) setProgress(result); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'Không thể tải tiến độ gửi.'); });
    void load();
    if (status !== 'sending') return () => { cancelled = true; };
    const id = window.setInterval(() => void load(), pollIntervalMs(realtimeStatus));
    return () => { cancelled = true; window.clearInterval(id); };
  }, [campaignId, status, realtimeStatus]);

  // M6-S1 (BR-SEND-004, TC-SEND-016): campaign.progress is a hint, not a
  // second copy of state (ADR-010) -- a version-gated event only ever
  // triggers a REST refetch, it never renders socket payload fields
  // directly. Reconnecting back to 'live' also triggers one refetch: the
  // reconnect reconciliation this rule's own acceptance requires, with no
  // replay buffer needed since REST is already the source of truth.
  useEffect(() => {
    if (status !== 'sending') return;
    let cursor: { version: number } | null = null;
    const refetch = () => void getCampaignProgress(campaignId)
      .then((result) => setProgress(result))
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : 'Không thể tải tiến độ gửi.'));
    const handleProgress = (event: CampaignProgressEvent) => {
      const next = applyProgressEvent(cursor, event, campaignId);
      if (next !== cursor) { cursor = next; refetch(); }
    };
    socket.on('campaign.progress', handleProgress);
    subscribeToCampaigns([campaignId]);
    return () => { socket.off('campaign.progress', handleProgress); };
  }, [campaignId, status]);

  useEffect(() => {
    if (realtimeStatus === 'live' && !wasLive.current && status === 'sending') {
      void getCampaignProgress(campaignId).then((result) => setProgress(result)).catch(() => undefined);
    }
    wasLive.current = realtimeStatus === 'live';
  }, [realtimeStatus, campaignId, status]);

  return <div className={`frozen-banner ${SENDING_STATUS_TONE[status] ?? ''}`} role="status">
    <div>
      <b>{SENDING_STATUS_LABEL[status] ?? 'Đang xử lý…'}</b>
      {status === 'sending' && realtimeStatus === 'reconnecting' && <p className="login-error" role="status">Đang kết nối lại…</p>}
      {error && <p className="login-error" role="alert">{error}</p>}
      {progress && (
        <div className="send-summary">
          {/* D-105 (M5-S4 CP5): progress.sent/delivered/failed are the
              monotonic rollups (never decrease); progress.counts is the
              exact per-status partition that sums to totalSnapshot. A
              delivery webhook moves a row out of "submitted" into
              "delivered"/"bounced", so counts.submitted alone would visibly
              go backwards on screen the moment a delivery event lands. */}
          <div><span>Đã gửi</span><b>{progress.sent}</b></div>
          <div><span>Đã nhận</span><b>{progress.delivered}</b></div>
          <div><span>Thất bại</span><b>{progress.failed}</b></div>
          <div><span>Chờ gửi</span><b>{progress.counts.pending + progress.counts.queued}</b></div>
          <div><span>Tổng</span><b>{progress.totalSnapshot}</b></div>
        </div>
      )}
      {status === 'sending' && <Link to={`/campaigns/${campaignId}`} className="soft-button">Xem tiến độ trực tiếp</Link>}
    </div>
    {status === 'sending' && <div className="frozen-banner-actions">
      <button className="secondary-button" onClick={onStopSend}>Dừng gửi</button>
    </div>}
  </div>;
}

/**
 * BR-TPL-012: shows the immutable version a campaign will actually send
 * (previously invisible -- templateVersion was fetched only to compute
 * overridableVariables, never displayed) plus an opt-in nudge when a newer
 * published version exists. The pin itself never changes on its own; the
 * button is the only way to move it, and it does so through the caller's
 * own `change({ templateVersionId })` -- the same path TemplatePickerOverlay
 * uses -- so there is exactly one write path for this field.
 */
function TemplateVersionPin({ version, updatePrompt, onUpdateToLatest }: {
  version: TemplateVersion;
  updatePrompt: VersionUpdatePrompt;
  onUpdateToLatest: () => void;
}) {
  return <div className="template-version-pin">
    <span className="template-version-pin-badge">Đang gửi bản v{version.version}</span>
    {updatePrompt.available && <div className="template-version-pin-update" role="status">
      <span>Đã có bản v{updatePrompt.latest.version}</span>
      <button type="button" onClick={onUpdateToLatest}>Cập nhật lên bản mới nhất</button>
    </div>}
  </div>;
}

function isAudienceEmpty(audience: CampaignAudience): boolean {
  return !(audience.listIds?.length || audience.tagIds?.length || audience.recipientIds?.length);
}

function stateFrom(draft: CampaignDraft): AutosaveState { return { draft, pending: null, inFlight: null, status: 'saved' }; }

/** M4-S1 compose surface: real campaign persistence and serialized If-Match autosave. */
export function ComposeDraftScreen() {
  const setShellSaveState = useOutletContext<SetShellSaveState>();
  const navigate = useNavigate();
  // /campaigns/new creates a draft and replaces the URL with
  // /campaigns/:campaignId/edit, so this is undefined only on the very first
  // render of a brand-new draft.
  const { campaignId } = useParams<{ campaignId: string }>();
  const [state, setState] = useState<AutosaveState | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recipientPickerOpen, setRecipientPickerOpen] = useState(false);
  const [audiencePreview, setAudiencePreview] = useState<AudienceResolution | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendConfirmOpen, setSendConfirmOpen] = useState(false);
  const [stopSendOpen, setStopSendOpen] = useState(false);
  const [scheduleOverlay, setScheduleOverlay] = useState<'schedule' | 'reschedule' | null>(null);
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [templateVersion, setTemplateVersion] = useState<TemplateVersion | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [senders, setSenders] = useState<SenderConfig[] | null>(null);
  const [senderError, setSenderError] = useState<string | null>(null);
  const [conflictServerDraft, setConflictServerDraft] = useState<CampaignDraft | null>(null);
  const [conflictLoadError, setConflictLoadError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Partial<Record<ComposeFieldKey, string>>>({});
  const createStarted = useRef(false);

  useEffect(() => {
    void listSenderConfigs({ usable: true })
      .then((result) => setSenders(result.items))
      .catch((cause) => setSenderError(cause instanceof ApiError ? cause.message : 'Không thể tải cấu hình gửi.'));
  }, []);
  useEffect(() => () => setShellSaveState('idle'), [setShellSaveState]);
  const dispatch = useCallback((action: AutosaveAction) => {
    setState((current) => current ? autosaveReducer(current, action) : action.type === 'saved' ? stateFrom(action.draft) : current);
  }, []);
  useEffect(() => {
    if (campaignId) {
      void getCampaignDraft(campaignId).then((draft) => dispatch({ type: 'saved', draft })).catch((cause) => setLoadError(cause instanceof ApiError ? cause.message : 'Không thể tải bản nháp.'));
      return;
    }
    if (createStarted.current || state) return;
    createStarted.current = true;
    setCreating(true);
    void createCampaignDraft({ name: '' })
      .then((draft) => { dispatch({ type: 'saved', draft }); navigate(`/campaigns/${draft.id}/edit`, { replace: true }); })
      .catch((cause) => { createStarted.current = false; setLoadError(cause instanceof ApiError ? cause.message : 'Không thể tạo bản nháp.'); })
      .finally(() => setCreating(false));
  }, [campaignId, navigate]);
  useEffect(() => { setShellSaveState(state?.status ?? 'idle'); }, [setShellSaveState, state?.status]);
  useEffect(() => {
    // 'error' holds the same way 'conflict' does: a failed save now keeps its
    // patch in `pending`, so retrying on a timer would hammer a down server
    // forever. The next keystroke sets status back to 'idle' and flushes it.
    if (!state?.pending || state.inFlight || state.status === 'conflict' || state.status === 'error') return;
    const timer = window.setTimeout(() => dispatch({ type: 'start' }), 500);
    return () => window.clearTimeout(timer);
  }, [state?.pending, state?.inFlight, state?.status]);
  useEffect(() => {
    if (!state?.inFlight) return;
    const patch = state.inFlight;
    void updateCampaignDraft(state.draft.id, state.draft.version, patch)
      .then((draft) => dispatch({ type: 'saved', draft }))
      .catch((cause) => {
        const conflict = cause instanceof ApiError && cause.status === 412;
        dispatch({ type: 'failed', conflict });
        if (!conflict) return;
        setConflictLoadError(null);
        void getCampaignDraft(state.draft.id)
          .then(setConflictServerDraft)
          .catch((latestCause) => setConflictLoadError(latestCause instanceof ApiError ? latestCause.message : 'Không thể tải phiên bản mới nhất.'));
      });
  }, [state?.draft.id, state?.draft.version, state?.inFlight]);
  const audience = state?.draft.audience;
  useEffect(() => {
    if (!state || !audience || isAudienceEmpty(audience)) { setAudiencePreview(null); return; }
    let cancelled = false;
    previewCampaignAudience(state.draft.id, audience)
      .then((resolution) => { if (!cancelled) setAudiencePreview(resolution); })
      .catch(() => { if (!cancelled) setAudiencePreview(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.draft.id, JSON.stringify(audience)]);
  const templateId = state?.draft.templateId;
  const templateVersionId = state?.draft.templateVersionId;
  // Moved up from further below (it originally sat right before the JSX
  // return): the version-list effect just below needs it, and `frozen`
  // itself only ever depends on `state`, so hoisting it has no effect on
  // anything between its old and new position.
  const frozen = state?.draft.status !== 'draft';
  useEffect(() => {
    if (!templateId) { setTemplateName(null); return; }
    let cancelled = false;
    listTemplates({ limit: 100 }).then((page) => {
      if (cancelled) return;
      setTemplateName(page.items.find((template) => template.id === templateId)?.name ?? null);
    }).catch(() => { if (!cancelled) setTemplateName(null); });
    return () => { cancelled = true; };
  }, [templateId]);
  useEffect(() => {
    if (!templateVersionId) { setTemplateVersion(null); return; }
    let cancelled = false;
    getTemplateVersion(templateVersionId).then((version) => { if (!cancelled) setTemplateVersion(version); }).catch(() => { if (!cancelled) setTemplateVersion(null); });
    return () => { cancelled = true; };
  }, [templateVersionId]);
  // BR-TPL-012: only worth checking for a newer version while the draft can
  // still be repinned. Frozen (sent/scheduled/etc.) always shows `available:
  // false` below regardless of what the last fetch found, since offering a
  // switch on a campaign that already left 'draft' would contradict the
  // freeze itself.
  const [templateVersions, setTemplateVersions] = useState<TemplateVersionSummary[] | null>(null);
  useEffect(() => {
    if (!templateId || frozen) { setTemplateVersions(null); return; }
    let cancelled = false;
    listTemplateVersions(templateId).then((page) => { if (!cancelled) setTemplateVersions(page.items); }).catch(() => { if (!cancelled) setTemplateVersions(null); });
    return () => { cancelled = true; };
  }, [templateId, frozen]);

  const change = (patch: CampaignPatch) => dispatch({ type: 'change', patch });
  const versionUpdatePrompt: VersionUpdatePrompt = templateVersionId && templateVersions ? computeVersionUpdatePrompt(templateVersionId, templateVersions) : { available: false };
  const composeCardRef = useRef<HTMLElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);
  // The frozen banner mounts/unmounts at the same moment the sendConfirm
  // overlay unmounts; left alone, the browser's post-interaction scroll/focus
  // handling can leave the scrollable ancestor scrolled past the banner and
  // the top fields. Nothing is ever unreachable (the content still scrolls),
  // but landing at the top on every freeze/unfreeze transition is the correct
  // resting state for BR-CF-008's banner to actually be seen. Which element
  // owns the scroll differs by breakpoint -- .compose-card scrolls internally
  // at desktop/tablet widths, while globals.css switches it to
  // overflow:visible under 760px and the page itself scrolls instead -- so
  // both are reset together rather than picking one.
  useEffect(() => {
    composeCardRef.current?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [frozen]);
  const refreshDraft = async (id: string) => dispatch({ type: 'saved', draft: await getCampaignDraft(id) });
  const openReview = (kind: 'send' | 'schedule') => {
    if (!state) return;
    const checked = localComposeValidation(state.draft, audiencePreview?.actionable ?? (isAudienceEmpty(state.draft.audience) ? 0 : null));
    setValidationErrors(checked.errors);
    if (checked.firstInvalid) {
      if (checked.firstInvalid === 'name') nameInputRef.current?.focus();
      else if (checked.firstInvalid === 'subject') subjectInputRef.current?.focus();
      else if (checked.firstInvalid === 'sender') document.getElementById('campaign-sender')?.focus();
      else if (checked.firstInvalid === 'audience') setRecipientPickerOpen(true);
      else if (checked.firstInvalid === 'template') setTemplatePickerOpen(true);
      return;
    }
    if (kind === 'send') setSendConfirmOpen(true);
    else setScheduleOverlay('schedule');
  };
  const cancelToRefresh = async () => {
    if (!state) return;
    setCancelling(true); setCancelError(null);
    try {
      await cancelCampaign(state.draft.id);
      await refreshDraft(state.draft.id);
    } catch (cause) { setCancelError(cause instanceof ApiError ? cause.message : 'Không thể hủy để chỉnh sửa lại.'); }
    finally { setCancelling(false); }
  };
  const overridableVariables = Object.entries(templateVersion?.variableSchema.configured ?? {}).filter(([, definition]) => definition.allowCampaignOverride);

  if (loadError && !state) return <section className="workspace-module-frame"><div className="module-frame-body"><div className="module-card permission-denied-card" role="alert"><h2>Không thể mở bản nháp</h2><p>{loadError}</p><button className="secondary-button" onClick={() => navigate('/campaigns')}>Quay lại danh sách chiến dịch</button></div></div></section>;
  if (!state) return <section className="workspace-module-frame compose-variables-module"><header className="workspace-module-topbar"><div><h2>Soạn email</h2><p>Đang mở một bản nháp mới để bạn bắt đầu ngay.</p></div></header><div className="email-workspace-body"><section className="compose-card" role="status">{creating ? 'Đang tạo bản nháp…' : 'Đang tải trình soạn thảo…'}</section></div></section>;

  return <section className="workspace-module-frame compose-variables-module">
    <header className="workspace-module-topbar"><div><h2>Soạn email</h2><p>Thay đổi được tự động lưu tuần tự để không ghi đè phiên mới hơn.</p></div></header>
    <div className="email-workspace-body"><div className="compose-grid compose-grid--single"><section className="compose-card" ref={composeCardRef}>
      {state.draft.status === 'scheduled'
        ? <ScheduledBanner draft={state.draft} onReschedule={() => setScheduleOverlay('reschedule')} onCancelled={() => void refreshDraft(state.draft.id)} />
        : (['sending', 'completed', 'partial_failed', 'failed'] as const).includes(state.draft.status as never)
        ? <SendingBanner campaignId={state.draft.id} status={state.draft.status} onStopSend={() => setStopSendOpen(true)} />
        : frozen && <div className="frozen-banner" role="status">
          <div>
            <b>Chiến dịch đã được đóng băng để gửi.</b>
            <p>Người nhận, template và dữ liệu tùy chỉnh đã được chốt tại thời điểm xác nhận gửi. Thay đổi dữ liệu người nhận hoặc trường tùy chỉnh từ bây giờ sẽ không được áp dụng cho chiến dịch này.</p>
            {cancelError && <p className="login-error" role="alert">{cancelError}</p>}
          </div>
          <button className="secondary-button" disabled={cancelling} onClick={() => void cancelToRefresh()}>{cancelling ? 'Đang hủy…' : 'Hủy để chỉnh sửa lại'}</button>
        </div>}
      <div className="compose-fields">
      <label className={`field full ${validationErrors.name ? 'field-invalid' : ''}`}><span>Tên chiến dịch <i className="required-mark">*</i></span><input ref={nameInputRef} aria-invalid={Boolean(validationErrors.name)} aria-describedby="campaign-name-help" placeholder="Ví dụ: Chào mừng nhân viên tháng 8" value={state.draft.name} maxLength={200} disabled={frozen} onChange={(event) => { setValidationErrors((current) => ({ ...current, name: undefined })); change({ name: event.target.value }); }} /><small id="campaign-name-help" className={validationErrors.name ? 'field-error' : 'field-help'}>{validationErrors.name ?? 'Dùng để nhận biết chiến dịch trong lịch sử và báo cáo; thiếu tên sẽ không thể gửi.'}</small></label>
      <label className={`select-field ${validationErrors.sender ? 'field-invalid' : ''}`}><span>Cấu hình gửi <i className="required-mark">*</i></span><select id="campaign-sender" aria-label="Cấu hình gửi" aria-invalid={Boolean(validationErrors.sender)} disabled={frozen || senders === null} value={state.draft.sender.senderConfigId ?? ''} onChange={(event) => { setValidationErrors((current) => ({ ...current, sender: undefined })); const sender = senders?.find((item) => item.id === event.target.value); change({ sender: sender ? { senderConfigId: sender.id, fromName: sender.fromName, fromEmail: sender.fromEmail } : {} }); }}><option value="">{senders === null ? 'Đang tải cấu hình gửi…' : 'Chưa chọn cấu hình gửi'}</option>{(senders ?? []).map((sender) => <option key={sender.id} value={sender.id}>{sender.name} · {sender.fromEmail}</option>)}</select><small className={validationErrors.sender || senderError ? 'field-error' : 'field-help'} role={validationErrors.sender || senderError ? 'alert' : undefined}>{validationErrors.sender ?? senderError ?? 'Chỉ cấu hình đã xác thực mới có thể gửi email.'}</small></label>
      <label className={`select-field recipient-field ${validationErrors.audience ? 'field-invalid' : ''}`}><span>Người nhận <i className="required-mark">*</i></span><button type="button" aria-invalid={Boolean(validationErrors.audience)} disabled={frozen} onClick={() => { setValidationErrors((current) => ({ ...current, audience: undefined })); setRecipientPickerOpen(true); }}><span className="list-dot">{audiencePreview ? audiencePreview.actionable : 0}</span><b>{audiencePreview ? `${audiencePreview.actionable} người nhận` : isAudienceEmpty(state.draft.audience) ? 'Chưa chọn người nhận' : 'Đang tính…'}</b><small>{audiencePreview && audiencePreview.skipped > 0 ? `${audiencePreview.skipped} người bị loại` : 'Chọn danh sách hoặc tag'}</small><i><UiIcon name="chevronDown" size={16} /></i></button><small className={validationErrors.audience ? 'field-error' : 'field-help'}>{validationErrors.audience ?? 'Cần ít nhất một người nhận đủ điều kiện; không có người nhận sẽ chặn gửi.'}</small></label>
      <label className="field"><span>CC</span><input placeholder="email1@congty.vn, email2@congty.vn" value={(state.draft.settings.cc ?? []).join(', ')} disabled={frozen} onChange={(event) => change({ settings: { ...state.draft.settings, cc: event.target.value ? event.target.value.split(',').map((value) => value.trim()).filter(Boolean) : [] } })} /><small className="field-help">Để trống nếu không cần gửi bản sao.</small></label>
      <label className="field"><span>BCC</span><input placeholder="email@congty.vn" value={(state.draft.settings.bcc ?? []).join(', ')} disabled={frozen} onChange={(event) => change({ settings: { ...state.draft.settings, bcc: event.target.value ? event.target.value.split(',').map((value) => value.trim()).filter(Boolean) : [] } })} /><small className="field-help">Để trống nếu không cần bản sao ẩn.</small></label>
      <label className={`field full ${validationErrors.subject ? 'field-invalid' : ''}`}><span>Tiêu đề email <i className="required-mark">*</i></span><input ref={subjectInputRef} aria-invalid={Boolean(validationErrors.subject)} placeholder="Nội dung người nhận sẽ thấy trong hộp thư" value={state.draft.subject} maxLength={998} disabled={frozen} onChange={(event) => { setValidationErrors((current) => ({ ...current, subject: undefined })); change({ subject: event.target.value }); }} /><small className={validationErrors.subject ? 'field-error' : 'field-help'}>{validationErrors.subject ?? 'Thiếu tiêu đề sẽ chặn gửi và hẹn giờ.'}</small></label>
    </div><div className={`template-row ${validationErrors.template ? 'field-invalid' : ''}`}><div><span>HTML TEMPLATE <i className="required-mark">*</i></span><b>{templateName ?? (state.draft.templateId ? 'Template đã chọn' : 'Chưa chọn template')}</b><small className={validationErrors.template ? 'field-error' : ''}>{validationErrors.template ?? (state.draft.templateId ? 'Chọn template khác nếu cần' : 'Chọn một template đã xuất bản; thiếu template sẽ chặn gửi.')}</small></div><button className="secondary-button" disabled={frozen} onClick={() => { setValidationErrors((current) => ({ ...current, template: undefined })); setTemplatePickerOpen(true); }}>Chọn template</button></div>
    {templateVersion && <TemplateVersionPin version={templateVersion} updatePrompt={versionUpdatePrompt} onUpdateToLatest={() => { if (versionUpdatePrompt.available) change({ templateVersionId: versionUpdatePrompt.latest.id }); }} />}
    {overridableVariables.length > 0 && <section className="compose-variable-overrides"><header><b>Tùy chỉnh nội dung cho lượt gửi này</b><small>Chỉ các biến được template cho phép mới xuất hiện tại đây. Để trống sẽ dùng giá trị toàn hệ thống hoặc mặc định của template.</small></header><div>{overridableVariables.map(([key, definition]) => <label className="field" key={key}><span>{definition.label}</span><input disabled={frozen} value={String(state.draft.settings.variableOverrides?.[key] ?? '')} placeholder="Dùng giá trị mặc định" onChange={(event) => { const variableOverrides = { ...(state.draft.settings.variableOverrides ?? {}) }; if (event.target.value) variableOverrides[key] = event.target.value; else delete variableOverrides[key]; change({ settings: { ...state.draft.settings, variableOverrides } }); }} /><small className="field-help"><code>{`{{${key}}}`}</code> · {definition.scope === 'global' ? 'mặc định toàn hệ thống' : 'mặc định theo template'}</small></label>)}</div></section>}
      {state.status === 'conflict' && <div className="compose-conflict" role="alert">
        <div><b>Bản nháp đã thay đổi ở nơi khác</b><p>Nội dung cục bộ được giữ nguyên. Chọn phiên bản máy chủ hoặc áp lại các trường bạn vừa sửa lên phiên bản mới nhất.</p></div>
        {conflictServerDraft && <div className="compose-conflict-diff">
          {Object.entries(state.pending ?? {}).map(([field, localValue]) => <div key={field}><span>{field}</span><small>Máy chủ: {JSON.stringify(conflictServerDraft[field as keyof CampaignDraft])}</small><b>Cục bộ: {JSON.stringify(localValue)}</b></div>)}
        </div>}
        {conflictLoadError && <p className="login-error">{conflictLoadError}</p>}
        <div className="compose-conflict-actions">
          <button className="secondary-button" disabled={!conflictServerDraft} onClick={() => { if (conflictServerDraft) dispatch({ type: 'resolveConflict', serverDraft: conflictServerDraft, keepLocal: false }); setConflictServerDraft(null); }}>Dùng bản trên máy chủ</button>
          <button className="primary-button" disabled={!conflictServerDraft} onClick={() => { if (conflictServerDraft) dispatch({ type: 'resolveConflict', serverDraft: conflictServerDraft, keepLocal: true }); setConflictServerDraft(null); }}>Giữ thay đổi của tôi</button>
          {!conflictServerDraft && <button className="secondary-button" onClick={() => void getCampaignDraft(state.draft.id).then(setConflictServerDraft).catch((cause) => setConflictLoadError(cause instanceof ApiError ? cause.message : 'Không thể tải phiên bản mới nhất.'))}>Tải lại so sánh</button>}
        </div>
      </div>}
      {!frozen && <div className="page-actions">
        {Object.values(validationErrors).some(Boolean) && <p className="compose-validation-summary" role="alert">Cần hoàn tất các trường được đánh dấu trước khi tiếp tục.</p>}
        <button className="secondary-button" onClick={() => openReview('schedule')}>Hẹn giờ</button>
        <button className="primary-button" onClick={() => openReview('send')}>Xem lại &amp; xác nhận gửi</button>
      </div>}
    </section></div></div>
    {recipientPickerOpen && <RecipientPickerOverlay campaignId={state.draft.id} audience={state.draft.audience} onApply={(audience) => change({ audience })} onClose={() => setRecipientPickerOpen(false)} />}
    {templatePickerOpen && <TemplatePickerOverlay
      onApply={({ templateId: id, templateVersionId }) => {
        change({ templateId: id, templateVersionId });
        listTemplates({ limit: 100 }).then((page) => setTemplateName(page.items.find((template) => template.id === id)?.name ?? null)).catch(() => {});
      }}
      onClose={() => setTemplatePickerOpen(false)}
    />}
    {sendConfirmOpen && <SendConfirmOverlay
      campaignId={state.draft.id}
      draft={state.draft}
      templateName={templateName}
      onClose={() => setSendConfirmOpen(false)}
      onWaiverAccepted={(draft) => dispatch({ type: 'saved', draft })}
      onSent={() => void refreshDraft(state.draft.id)}
    />}
    {stopSendOpen && <StopSendConfirmOverlay
      campaignId={state.draft.id}
      onClose={() => setStopSendOpen(false)}
      onStopped={() => void refreshDraft(state.draft.id)}
    />}
    {scheduleOverlay && <ScheduleSendOverlay
      campaignId={state.draft.id}
      draft={state.draft}
      templateName={templateName}
      mode={scheduleOverlay}
      onClose={() => setScheduleOverlay(null)}
      onWaiverAccepted={(draft) => dispatch({ type: 'saved', draft })}
      onScheduled={() => void refreshDraft(state.draft.id)}
    />}
  </section>;
}
