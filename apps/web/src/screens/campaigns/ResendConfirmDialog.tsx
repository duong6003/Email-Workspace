import { useRef, useState } from 'react';
import { ApiError } from '../../api/problem.js';
import { resendCampaign } from '../../api/campaign-list.js';
import type { CampaignHistoryRow } from '../../api/campaign-list.js';

/**
 * BR-HIS-005's resend confirm/success pair, following the approved
 * handoff's `resendConfirm`/`resendSuccess` overlays
 * (action-overlays.tsx:224-227): "Chỉ gửi lại cho các địa chỉ thất bại ở
 * lần gửi trước" -- the row's own already-fetched failed count is shown
 * (no separate preview endpoint exists), and the real count/executionId
 * this campaign's resend actually created is what the success state shows,
 * not an assumed number.
 */
export function ResendConfirmDialog({
  row, onClose, onResent,
}: {
  row: CampaignHistoryRow;
  onClose: () => void;
  onResent: (recipientCount: number) => void;
}) {
  const [stage, setStage] = useState<'confirm' | 'sending' | 'success' | 'error'>('confirm');
  const [error, setError] = useState<string | null>(null);
  const [recipientCount, setRecipientCount] = useState(0);
  const failedCount = row.progress?.failed ?? 0;
  const idempotencyKeyRef = useRef(crypto.randomUUID());

  const sending = stage === 'sending';

  const confirmResend = () => {
    setStage('sending');
    setError(null);
    resendCampaign(row.id, idempotencyKeyRef.current)
      .then((result) => { setRecipientCount(result.recipientCount); setStage('success'); })
      .catch((cause) => {
        setError(cause instanceof ApiError ? cause.message : 'Không thể gửi lại chiến dịch.');
        setStage('error');
      });
  };

  if (stage === 'success') {
    return (
      <div className="overlay-backdrop" onMouseDown={onClose}>
        <section role="dialog" aria-modal="true" aria-labelledby="resend-success-title" className="action-overlay modal-small" onMouseDown={(event) => event.stopPropagation()}>
          <div className="success-state">
            <span>✓</span>
            <h2 id="resend-success-title">Đã gửi lại email</h2>
            <p>{recipientCount} email đang được xử lý. Kết quả mới sẽ được cập nhật trong lịch sử gửi.</p>
            <div><b>{recipientCount}</b><small>Email gửi lại</small></div>
          </div>
          <footer>
            <button className="primary-button" onClick={() => onResent(recipientCount)}>Hoàn tất</button>
          </footer>
        </section>
      </div>
    );
  }

  return (
    <div className="overlay-backdrop" onMouseDown={sending ? undefined : onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="resend-confirm-title" className="action-overlay modal-small" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><h2 id="resend-confirm-title">Gửi lại email</h2><p>Chỉ gửi lại cho các địa chỉ thất bại ở lần gửi trước.</p></div>
          <button aria-label="Đóng cửa sổ" onClick={onClose} disabled={sending}>×</button>
        </header>
        <div className="overlay-content">
          <div className="resend-summary">
            <span>↻</span>
            <div>
              <b>{failedCount} email sẽ được gửi lại</b>
              <p>Không gửi lại cho các địa chỉ đã nhận email thành công.</p>
            </div>
          </div>
          {error && <p className="login-error" role="alert">{error}</p>}
        </div>
        <footer>
          <button className="secondary-button" onClick={onClose} disabled={sending}>Hủy</button>
          <button className="primary-button" aria-busy={sending} disabled={sending} onClick={confirmResend}>
            {sending ? 'Đang gửi lại…' : `Gửi lại ${failedCount} email`}
          </button>
        </footer>
      </section>
    </div>
  );
}
