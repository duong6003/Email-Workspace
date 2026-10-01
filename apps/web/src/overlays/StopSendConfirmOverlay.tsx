import { useRef, useState } from 'react';
import { cancelCampaignSend, type CampaignSendCancelAccepted } from '../api/campaigns.js';
import { ApiError } from '../api/problem.js';

/**
 * M5-S3 CP8 (BR-SEND-010, A18). Same disabled-during-flight discipline as
 * SendConfirmOverlay: a stop-send is irreversible for whatever has already
 * been submitted, so the plain-language warning names that limit explicitly
 * rather than only describing what the action does.
 */
export function StopSendConfirmOverlay({ campaignId, onClose, onStopped }: {
  campaignId: string;
  onClose: () => void;
  onStopped: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'stopping' | 'success'>('idle');
  const [result, setResult] = useState<CampaignSendCancelAccepted | null>(null);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const stopping = state === 'stopping';

  const confirmStop = async () => {
    setState('stopping');
    setError(null);
    try {
      const accepted = await cancelCampaignSend(campaignId, idempotencyKeyRef.current);
      setResult(accepted);
      setState('success');
      onStopped();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Không thể dừng gửi chiến dịch.');
      setState('idle');
    }
  };

  if (state === 'success' && result) {
    return <div className="overlay-backdrop" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="stop-send-success-title" className="action-overlay modal-small" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><h2 id="stop-send-success-title">Đã dừng gửi</h2><p>Phần chưa gửi đã được hủy.</p></div>
        </header>
        <div className="overlay-content">
          <div className="send-summary">
            <div><span>Đã gửi (không thể thu hồi)</span><b>{result.submittedCount} email</b></div>
            <div><span>Đã hủy</span><b>{result.cancelledCount} người</b></div>
          </div>
        </div>
        <footer>
          <button className="primary-button" onClick={onClose}>Đóng</button>
        </footer>
      </section>
    </div>;
  }

  return <div className="overlay-backdrop" onMouseDown={stopping ? undefined : onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="stop-send-confirm-title" className="action-overlay modal-small" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><h2 id="stop-send-confirm-title">Dừng gửi chiến dịch?</h2><p>Hành động này không thể hoàn tác.</p></div>
        <button aria-label="Đóng cửa sổ" onClick={onClose} disabled={stopping}>×</button>
      </header>
      <div className="overlay-content">
        {error && <p className="login-error" role="alert">{error}</p>}
        <div className="check-list">
          <p><span>!</span> Email đã gửi thành công sẽ <b>không thể thu hồi</b>.</p>
          <p><span>·</span> Chỉ những email chưa gửi sẽ bị hủy.</p>
        </div>
      </div>
      <footer>
        <button className="secondary-button" onClick={onClose} disabled={stopping}>Quay lại</button>
        <button className="primary-button" aria-busy={stopping} disabled={stopping} onClick={() => void confirmStop()}>
          {stopping ? 'Đang dừng…' : 'Dừng gửi'}
        </button>
      </footer>
    </section>
  </div>;
}
