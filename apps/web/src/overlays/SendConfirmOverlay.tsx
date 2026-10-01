import { useEffect, useRef, useState } from 'react';
import { acceptCampaignAudienceWaiver, getCampaignPreflight, sendCampaign, validateCampaignAudience, type CampaignDraft, type CampaignScheduleValidationReport, type CampaignSnapshotAccepted, type ValidateCampaignAudienceResult } from '../api/campaigns.js';
import { ApiError } from '../api/problem.js';
import { preflightBlockers } from '../screens/compose/compose-validation.js';
import { SendPreviewPanel } from './SendPreviewPanel.js';

/**
 * Ported from the handoff's sendConfirm (action-overlays.tsx L146-149:
 * .send-summary, .variable-resolution, .check-list, .confirm-check), wired
 * to real validate-audience data instead of the handoff's fixed "121 gửi ·
 * 7 tạm loại" numbers (BR-CMP-008).
 *
 * M4-S4: the primary CTA is now a real terminal action (BR-CMP-007/010).
 * The Idempotency-Key is generated once per overlay mount, held in a ref --
 * not regenerated per click -- so a double-click or a retry after a network
 * failure replays the same request rather than freezing a second snapshot.
 * While sending, the CTA and every dismiss path (backdrop, ×, "Quay lại")
 * are disabled so a second click during flight can never issue a second
 * request. Success replaces the overlay body with a minimal sendSuccess
 * state (frozen counts + "Đóng"); this is an in-overlay confirmation, not a
 * durable notification (M6-S2's notification center is unrelated to this
 * confirmation). M5-S2 adds real scheduling as a separate trigger/overlay
 * (ComposeDraftScreen's "Hẹn giờ" button, ScheduleSendOverlay.tsx) rather
 * than a "Hẹn giờ" option inside this one -- sendConfirm and scheduleSend
 * end in different terminal states (queued vs scheduled) and the handoff
 * itself keeps them as separate action-overlay branches.
 */
export function SendConfirmOverlay({ campaignId, draft, templateName, onClose, onWaiverAccepted, onSent }: {
  campaignId: string;
  draft: CampaignDraft;
  templateName: string | null;
  onClose: () => void;
  onWaiverAccepted: (draft: CampaignDraft) => void;
  onSent: () => void;
}) {
  const [validation, setValidation] = useState<ValidateCampaignAudienceResult | null>(null);
  const [preflight, setPreflight] = useState<CampaignScheduleValidationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [sendResult, setSendResult] = useState<CampaignSnapshotAccepted | null>(null);

  const load = () => {
    setError(null);
    Promise.all([validateCampaignAudience(campaignId), getCampaignPreflight(campaignId)])
      .then(([audience, report]) => { setValidation(audience); setPreflight(report); })
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : 'Không thể kiểm tra dữ liệu người nhận.'));
  };
  useEffect(load, [campaignId]);

  const acceptWaiver = async () => {
    setAccepting(true);
    try {
      const updated = await acceptCampaignAudienceWaiver(campaignId, draft.version);
      onWaiverAccepted(updated);
      load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Không thể ghi nhận xác nhận loại trừ.');
    } finally {
      setAccepting(false);
    }
  };

  const confirmSend = async () => {
    setSendState('sending');
    setError(null);
    try {
      const result = await sendCampaign(campaignId, idempotencyKeyRef.current);
      setSendResult(result);
      setSendState('success');
      onSent();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Không thể gửi chiến dịch.');
      setSendState('error');
    }
  };

  const p0Blocked = preflight?.blocking ?? true;
  const blockers = preflightBlockers(preflight);
  const sending = sendState === 'sending';
  const canConfirm = validation !== null && !p0Blocked && confirmed && !sending;
  const dismissBlocked = sending;

  if (sendState === 'success' && sendResult) {
    return <div className="overlay-backdrop" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="send-success-title" className="action-overlay send-success" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><h2 id="send-success-title">Đã gửi thành công</h2><p>Chiến dịch đã được đóng băng và đưa vào hàng đợi gửi.</p></div>
        </header>
        <div className="overlay-content">
          <div className="send-summary">
            <div><span>Đã đóng băng</span><b>{sendResult.totalSnapshot} người nhận</b></div>
            <div><span>Sẽ gửi</span><b>{sendResult.sendableCount} email</b></div>
            {sendResult.skippedCount > 0 && <div><span>Tạm loại</span><b>{sendResult.skippedCount} người</b></div>}
          </div>
        </div>
        <footer>
          <button className="primary-button" onClick={onClose}>Đóng</button>
        </footer>
      </section>
    </div>;
  }

  return <div className="overlay-backdrop" onMouseDown={dismissBlocked ? undefined : onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="send-confirm-title" className="action-overlay modal-large" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><h2 id="send-confirm-title">Xác nhận gửi email</h2><p>Kiểm tra lần cuối trước khi bắt đầu gửi.</p></div>
        <button aria-label="Đóng cửa sổ" onClick={onClose} disabled={dismissBlocked}>×</button>
      </header>
      <div className="overlay-content">
        {error && <p className="login-error" role="alert">{error}</p>}
        {validation && (
          <div className="send-summary">
            <div><span>Người nhận</span><b>{validation.completeCount} gửi{validation.missingCount > 0 ? ` · ${validation.missingCount} tạm loại` : ''}</b></div>
            <div><span>Người gửi</span><b>{draft.sender.fromEmail ?? 'Chưa chọn cấu hình gửi'}</b></div>
            <div><span>Template</span><b>{templateName ?? 'Chưa chọn template'}</b></div>
            <div><span>Thời gian</span><b>Gửi ngay</b></div>
          </div>
        )}
        {validation && <SendPreviewPanel campaignId={campaignId} audience={draft.audience} templateVersionId={draft.templateVersionId} variableOverrides={draft.settings.variableOverrides} />}
        {preflight && <div className="check-list" aria-live="polite">
          <p><span>{preflight.name.valid ? '✓' : '!'}</span> Tên chiến dịch {preflight.name.valid ? 'đã có' : 'còn thiếu'}</p>
          <p><span>{preflight.subject.valid ? '✓' : '!'}</span> Tiêu đề email {preflight.subject.valid ? 'đã có' : 'còn thiếu'}</p>
          <p><span>{preflight.sender.valid ? '✓' : '!'}</span> Người gửi {preflight.sender.valid ? 'đã xác thực' : 'chưa sẵn sàng'}</p>
          <p><span>{preflight.template.valid ? '✓' : '!'}</span> Template {preflight.template.valid ? 'đã xuất bản' : 'chưa sẵn sàng'}</p>
          <p><span>{preflight.audience.valid ? '✓' : '!'}</span> Phạm vi {preflight.audience.totalUnique.toLocaleString('vi-VN')} người nhận</p>
          <p><span>{preflight.quota.valid ? '✓' : '!'}</span> Hạn mức gửi {preflight.quota.valid ? 'đáp ứng' : 'đã vượt giới hạn'}</p>
          {preflight.content.warnings.length > 0 && <p><span>!</span> {preflight.content.warnings.length} cảnh báo chất lượng nội dung (không chặn gửi)</p>}
          <p><span>!</span> Chưa có dữ liệu xác minh SPF/DKIM/DMARC; đây là cảnh báo, không thay thế kiểm tra nhà cung cấp.</p>
        </div>}
        {blockers.length > 0 && <div className="preflight-blockers" role="alert"><b>Chưa thể gửi vì:</b><ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul><small>Quay lại bản nháp và hoàn tất các mục được đánh dấu.</small></div>}
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
        {validation && (
          <div className="check-list">
            <p><span>{validation.completeCount > 0 ? '✓' : '·'}</span> {validation.completeCount} địa chỉ đủ điều kiện gửi</p>
            {validation.missingCount > 0 && <p><span>{validation.waiverStatus === 'valid' ? '✓' : '·'}</span> Đã áp dụng quy tắc loại bản ghi thiếu biến</p>}
          </div>
        )}
        <label className="confirm-check">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={sending} />
          Tôi đã kiểm tra nội dung và phạm vi người nhận.
        </label>
      </div>
      <footer>
        <button className="secondary-button" onClick={onClose} disabled={dismissBlocked}>Quay lại</button>
        <button className="primary-button" aria-busy={sending} disabled={!canConfirm} onClick={() => void confirmSend()}>
          {sending ? 'Đang gửi…' : `Gửi ${validation ? validation.completeCount : ''} email`}
        </button>
      </footer>
    </section>
  </div>;
}
