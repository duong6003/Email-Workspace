import { useEffect, useMemo, useRef, useState } from 'react';
import {
  acceptCampaignAudienceWaiver, getCampaignPreflight, scheduleCampaign, validateCampaignAudience,
  type CampaignDraft, type CampaignScheduleAccepted, type CampaignScheduleValidationReport, type ValidateCampaignAudienceResult,
} from '../api/campaigns.js';
import { ApiError } from '../api/problem.js';
import { formatHumanDateTimeInZone, formatInstantInZone, previewLocalSchedule } from './schedule-time-preview.js';
import { scheduleErrorCopy, type ScheduleProblemExtras } from './schedule-error-copy.js';
import { preflightBlockers } from '../screens/compose/compose-validation.js';
import { SendPreviewPanel } from './SendPreviewPanel.js';

const BROWSER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/**
 * `Intl.supportedValuesOf('timeZone')` enumerates only canonical IANA names
 * and, depending on the host's ICU/CLDR data, can omit long-valid aliases
 * `Intl.DateTimeFormat` itself still accepts -- observed on this host: no
 * 'UTC' at all (only the link target, itself unlisted) and 'Asia/Saigon'
 * instead of 'Asia/Ho_Chi_Minh'. Both are this feature's own reference
 * zones throughout apps/api's tests and the plan (DEC-093), so they are
 * force-included rather than left to enumeration to decide they exist.
 */
const TIME_ZONES = Array.from(new Set([
  ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []),
  'UTC', 'Asia/Ho_Chi_Minh', BROWSER_TIME_ZONE,
])).sort();

function splitLocalDateTime(localDateTime: string): { date: string; time: string } {
  const [date, time] = localDateTime.split('T');
  return { date: date ?? '', time: time ?? '' };
}

/**
 * Ported from the handoff's scheduleSend (action-overlays.tsx L142-149:
 * .schedule-send-form, .schedule-grid, .schedule-preview, .variable-policy),
 * replacing its hardcoded date/time/zone/counts with real values (M5-S2
 * CP6, plan SS3.6). Same shape as SendConfirmOverlay: one Idempotency-Key
 * per overlay mount held in a ref, validate-audience gates the primary CTA,
 * every dismiss path disables while a request is in flight.
 *
 * `.schedule-preview`'s resolved instant is a client-side-only estimate
 * (schedule-time-preview.ts) -- catches a wrong zone before submit, but the
 * DST gap/repeat decision is always the server's `POST /schedule` 422,
 * rendered as human copy by schedule-error-copy.ts rather than a raw
 * problem body (A19).
 */
export function ScheduleSendOverlay({ campaignId, draft, templateName, mode, onClose, onWaiverAccepted, onScheduled }: {
  campaignId: string;
  draft: CampaignDraft;
  templateName: string | null;
  mode: 'schedule' | 'reschedule';
  onClose: () => void;
  onWaiverAccepted: (draft: CampaignDraft) => void;
  onScheduled: () => void;
}) {
  const initial = mode === 'reschedule' && draft.scheduledAtUtc && draft.scheduledTimezone
    ? splitLocalDateTime(formatInstantInZone(draft.scheduledAtUtc, draft.scheduledTimezone))
    : { date: '', time: '' };
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [zone, setZone] = useState(mode === 'reschedule' && draft.scheduledTimezone ? draft.scheduledTimezone : BROWSER_TIME_ZONE);
  const [offsetMinutes, setOffsetMinutes] = useState<number | null>(null);

  const [validation, setValidation] = useState<ValidateCampaignAudienceResult | null>(null);
  const [preflight, setPreflight] = useState<CampaignScheduleValidationReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorCopy, setErrorCopy] = useState<ReturnType<typeof scheduleErrorCopy> | null>(null);
  const [result, setResult] = useState<CampaignScheduleAccepted | null>(null);
  const idempotencyKeyRef = useRef(crypto.randomUUID());

  const load = () => {
    setLoadError(null);
    Promise.all([validateCampaignAudience(campaignId), getCampaignPreflight(campaignId)])
      .then(([audience, report]) => { setValidation(audience); setPreflight(report); })
      .catch((cause) => setLoadError(cause instanceof ApiError ? cause.message : 'Không thể kiểm tra dữ liệu người nhận.'));
  };
  useEffect(load, [campaignId]);

  const localDateTime = date && time ? `${date}T${time}` : null;
  const preview = useMemo(() => (localDateTime ? previewLocalSchedule(localDateTime, zone) : null), [localDateTime, zone]);

  const acceptWaiver = async () => {
    setAccepting(true);
    try {
      const updated = await acceptCampaignAudienceWaiver(campaignId, draft.version);
      onWaiverAccepted(updated);
      load();
    } catch (cause) {
      setLoadError(cause instanceof ApiError ? cause.message : 'Không thể ghi nhận xác nhận loại trừ.');
    } finally {
      setAccepting(false);
    }
  };

  const p0Blocked = preflight?.blocking ?? true;
  const blockers = preflightBlockers(preflight);
  const canSubmit = validation !== null && !p0Blocked && confirmed && !submitting && !!localDateTime;

  const submit = async () => {
    if (!localDateTime) return;
    setSubmitting(true);
    setErrorCopy(null);
    try {
      const response = await scheduleCampaign(campaignId, idempotencyKeyRef.current, {
        localDateTime, timeZone: zone, ...(offsetMinutes !== null ? { offsetMinutes } : {}),
      });
      setResult(response);
      onScheduled();
    } catch (cause) {
      setErrorCopy(scheduleErrorCopy(cause instanceof ApiError ? (cause.problem as ScheduleProblemExtras | null) : null));
    } finally {
      setSubmitting(false);
    }
  };

  const applySuggestedTime = () => {
    if (!errorCopy?.suggestedLocalDateTime) return;
    const split = splitLocalDateTime(errorCopy.suggestedLocalDateTime);
    setDate(split.date);
    setTime(split.time);
    setErrorCopy(null);
  };

  const chooseOffset = (candidate: number) => {
    setOffsetMinutes(candidate);
    setErrorCopy(null);
  };

  const dismissBlocked = submitting;

  if (result) {
    return <div className="overlay-backdrop" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="schedule-success-title" className="action-overlay send-success" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><h2 id="schedule-success-title">Đã lên lịch gửi</h2><p>Chiến dịch sẽ tự động gửi vào thời điểm đã chọn.</p></div>
        </header>
        <div className="overlay-content">
          <div className="send-summary">
            <div><span>Thời gian gửi</span><b>{formatHumanDateTimeInZone(result.scheduledAtUtc, result.timeZone)} ({result.timeZone})</b></div>
            <div><span>Đã đóng băng</span><b>{result.totalSnapshot} người nhận</b></div>
            <div><span>Sẽ gửi</span><b>{result.sendableCount} email</b></div>
            {result.skippedCount > 0 && <div><span>Tạm loại</span><b>{result.skippedCount} người</b></div>}
          </div>
        </div>
        <footer>
          <button className="primary-button" onClick={onClose}>Đóng</button>
        </footer>
      </section>
    </div>;
  }

  return <div className="overlay-backdrop" onMouseDown={dismissBlocked ? undefined : onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="schedule-send-title" className="action-overlay modal-large" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div>
          <h2 id="schedule-send-title">{mode === 'reschedule' ? 'Đổi giờ gửi' : 'Hẹn thời gian gửi'}</h2>
          <p>Lịch gửi dùng múi giờ đã chọn và có thể thay đổi trước khi bắt đầu.</p>
        </div>
        <button aria-label="Đóng cửa sổ" onClick={onClose} disabled={dismissBlocked}>×</button>
      </header>
      <div className="overlay-content">
        {loadError && <p className="login-error" role="alert">{loadError}</p>}
        <div className="schedule-send-form">
          <div className="schedule-grid">
            <label className="modal-field">
              <span>Ngày gửi</span>
              <input type="date" value={date} disabled={submitting} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label className="modal-field">
              <span>Giờ gửi</span>
              <input type="time" value={time} disabled={submitting} onChange={(event) => setTime(event.target.value)} />
            </label>
            <label className="modal-field full">
              <span>Múi giờ</span>
              <select value={zone} disabled={submitting} onChange={(event) => { setZone(event.target.value); setOffsetMinutes(null); }}>
                {TIME_ZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </label>
          </div>
          <div className="schedule-preview">
            <span>◷</span>
            <div>
              {preview
                ? <>
                  <b>{formatHumanDateTimeInZone(preview.scheduledAtUtc.toISOString(), zone)} ({zone})</b>
                  <small>Giờ UTC: {preview.scheduledAtUtc.toISOString().slice(0, 16).replace('T', ' ')}. {validation ? `Hệ thống sẽ bắt đầu gửi ${validation.completeCount} email${validation.missingCount > 0 ? `; ${validation.missingCount} người thiếu dữ liệu đã được tạm loại` : ''}.` : ''}</small>
                </>
                : <b>Chọn ngày, giờ và múi giờ để xem trước.</b>}
            </div>
          </div>
          {errorCopy && <div className="schedule-error" role="alert">
            <p>{errorCopy.message}</p>
            {(errorCopy.suggestedLocalDateTime || errorCopy.candidateOffsetMinutes) && <div className="schedule-error-actions">
              {errorCopy.suggestedLocalDateTime && <button type="button" className="secondary-button" onClick={applySuggestedTime}>Dùng giờ gợi ý: {errorCopy.suggestedLocalDateTime.replace('T', ' ')}</button>}
              {errorCopy.candidateOffsetMinutes && <>
                <button type="button" className="secondary-button" onClick={() => chooseOffset(errorCopy.candidateOffsetMinutes![0])}>Dùng giờ trước khi đổi giờ (UTC{errorCopy.candidateOffsetMinutes[0] >= 0 ? '+' : ''}{errorCopy.candidateOffsetMinutes[0] / 60})</button>
                <button type="button" className="secondary-button" onClick={() => chooseOffset(errorCopy.candidateOffsetMinutes![1])}>Dùng giờ sau khi đổi giờ (UTC{errorCopy.candidateOffsetMinutes[1] >= 0 ? '+' : ''}{errorCopy.candidateOffsetMinutes[1] / 60})</button>
              </>}
            </div>}
          </div>}
          <div className="variable-policy">
            <header><b>Kiểm tra trước giờ gửi</b><span>{preflight && !preflight.blocking ? 'Sẵn sàng' : 'Cần xử lý'}</span></header>
            <label><input type="checkbox" checked={(preflight?.name.valid && preflight?.subject.valid) ?? false} readOnly /><span><b>Tên chiến dịch và tiêu đề</b><small>Hai trường bắt buộc phải được nhập trước khi hẹn giờ.</small></span></label>
            <label><input type="checkbox" checked={(preflight?.sender.valid && preflight?.template.valid) ?? false} readOnly /><span><b>Người gửi và template</b><small>Người gửi phải xác thực và template phải có phiên bản đã xuất bản.</small></span></label>
            <label><input type="checkbox" checked={preflight?.quota.valid ?? false} readOnly /><span><b>Người nhận, biến và hạn mức</b><small>Hệ thống dừng lịch nếu phạm vi, biến bắt buộc hoặc quota không hợp lệ.</small></span></label>
            {preflight && (preflight.content.warnings.length > 0 || preflight.domain.warnings.length > 0) && <label><input type="checkbox" checked readOnly /><span><b>Cảnh báo không chặn</b><small>{preflight.content.warnings.length} cảnh báo nội dung; SPF/DKIM/DMARC chưa có dữ liệu xác minh trong hệ thống.</small></span></label>}
          </div>
          {blockers.length > 0 && <div className="preflight-blockers" role="alert"><b>Chưa thể hẹn giờ vì:</b><ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul><small>Quay lại bản nháp và hoàn tất các mục được đánh dấu.</small></div>}
        </div>
        {validation && <SendPreviewPanel campaignId={campaignId} audience={draft.audience} templateVersionId={draft.templateVersionId} variableOverrides={draft.settings.variableOverrides} />}
        {validation && validation.missingCount > 0 && (
          <div className="variable-resolution">
            <header>
              <span>!</span>
              <div>
                <b>{validation.missingCount} người nhận thiếu biến bắt buộc</b>
                <small>{validation.missingByVariable.map((entry) => `${entry.label}: ${entry.count} người`).join(' · ')}</small>
              </div>
            </header>
            <p>Hệ thống không gửi nội dung có biến trống. {validation.waiverStatus === 'valid' ? 'Các bản ghi này đã được xác nhận loại khỏi lần gửi.' : 'Xác nhận loại các bản ghi này khỏi lần gửi, hoặc cập nhật dữ liệu trước khi tiếp tục.'}</p>
            {validation.waiverStatus !== 'valid' && (
              <button onClick={() => void acceptWaiver()} disabled={accepting}>{accepting ? 'Đang xác nhận…' : 'Chấp nhận loại trừ và tiếp tục'}</button>
            )}
          </div>
        )}
        <label className="confirm-check">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={submitting} />
          Tôi đã kiểm tra thời gian, múi giờ và phạm vi người nhận.
        </label>
      </div>
      <footer>
        <button className="secondary-button" onClick={onClose} disabled={dismissBlocked}>Quay lại</button>
        <button className="primary-button" aria-busy={submitting} disabled={!canSubmit} onClick={() => void submit()}>
          {submitting ? 'Đang lên lịch…' : mode === 'reschedule' ? 'Cập nhật lịch gửi' : `Lên lịch gửi ${validation ? validation.completeCount : ''} email`}
        </button>
      </footer>
    </section>
  </div>;
}
