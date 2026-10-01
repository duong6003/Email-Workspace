import { useEffect, useState } from 'react';
import { previewCampaignAudience, type CampaignAudience } from '../api/campaigns.js';
import { getRecipient, type Recipient } from '../api/recipients.js';
import { ApiError } from '../api/problem.js';
import { previewTemplateVersion, sendTemplateVersionTest, type TemplatePreview } from '../api/templates.js';
import { buildPreviewMergeData, pickPreviewRecipient } from './send-preview.js';

/**
 * The send/schedule confirmation's "is this what they'll actually get"
 * check (docs/superpowers/specs/2026-08-27-preview-at-send-confirmation-design.md).
 * Renders the campaign's pinned template against the first actionable
 * recipient in the live audience sample, with settings.variableOverrides
 * applied using the same precedence the real send uses -- see
 * send-preview.ts. No audience picker: the product owner chose "first
 * actionable sample entry" over a recipient picker (2026-08-27).
 */
export function SendPreviewPanel({ campaignId, audience, templateVersionId, variableOverrides }: {
  campaignId: string;
  audience: CampaignAudience;
  templateVersionId: string | null;
  variableOverrides: Record<string, unknown> | undefined;
}) {
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [noSampleRecipient, setNoSampleRecipient] = useState(false);
  const [result, setResult] = useState<TemplatePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testState, setTestState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    setRecipient(null);
    setNoSampleRecipient(false);
    setResult(null);
    setError(null);
    if (!templateVersionId) return;
    let cancelled = false;
    previewCampaignAudience(campaignId, audience)
      .then((resolution) => {
        const sampled = pickPreviewRecipient(resolution.sample);
        if (!sampled) { if (!cancelled) setNoSampleRecipient(true); return null; }
        return getRecipient(sampled.recipientId);
      })
      .then((found) => { if (!cancelled && found) setRecipient(found); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'Không thể tải người nhận mẫu để xem trước.'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, templateVersionId, JSON.stringify(audience)]);

  useEffect(() => {
    setResult(null);
    setError(null);
    if (!templateVersionId || !recipient) return;
    let cancelled = false;
    const mergeData = buildPreviewMergeData(recipient, variableOverrides ?? {}, window.location.origin);
    previewTemplateVersion(templateVersionId, mergeData)
      .then((preview) => { if (!cancelled) setResult(preview); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'Không thể tạo bản xem trước.'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateVersionId, recipient, JSON.stringify(variableOverrides ?? {})]);

  if (!templateVersionId) return <div className="template-preview-layout send-preview"><p className="compose-variable-state" role="status">Chưa chọn template nên chưa có nội dung để xem trước.</p></div>;
  if (error) return <div className="template-preview-layout send-preview"><p className="login-error" role="alert">{error}</p></div>;
  if (noSampleRecipient) return <div className="template-preview-layout send-preview"><p className="compose-variable-state" role="status">Không tìm thấy người nhận đủ điều kiện trong mẫu để xem trước. Vẫn có thể tiếp tục gửi nếu số liệu người nhận ở trên hợp lệ.</p></div>;
  if (!recipient || !result) return <div className="template-preview-layout send-preview"><p className="compose-variable-state" role="status">Đang tạo bản xem trước…</p></div>;

  const recipientLabel = recipient.firstName ? `${recipient.firstName}${recipient.lastName ? ` ${recipient.lastName}` : ''} · ${recipient.email}` : recipient.email;

  return <div className="template-preview-layout send-preview">
    {/* No meta block here on purpose. It repeated the subject that the preview
        header shows immediately below it, and labelled the sampled person
        "Người nhận" -- the same label the confirmation summary above already
        uses for the audience counts, so one dialog carried two "Người nhận"
        rows meaning different things. The person is named in the preview
        header instead, where it reads as "whose data this render used". */}
    <aside className="template-preview-summary">
      {/* BR-TPL-005: the server decides what is missing; hiding missingKeys
          would turn a preview that cannot be rendered for this real
          recipient into one that looks complete. */}
      {result.missingKeys.length > 0
        ? <p className="template-warning" role="status">Thiếu dữ liệu cho: {result.missingKeys.join(', ')}</p>
        : <p className="template-preview-ready" role="status">✓ Dữ liệu người nhận đã được thay đầy đủ.</p>}
      {/* Sends exactly what the frame above rendered -- the same merge data,
          rebuilt from the same inputs -- so "it looked right" and "it arrived
          right" cannot disagree. The server delivers a test only to the
          authenticated actor, never to the sampled recipient whose data was
          borrowed. Audited as a template test send, since no campaign-level
          test-send route exists; a campaign-scoped audit trail would need one. */}
      <button
        type="button"
        className="secondary-button"
        disabled={testState === 'sending'}
        onClick={() => {
          setTestState('sending');
          setTestError(null);
          void sendTemplateVersionTest(templateVersionId, buildPreviewMergeData(recipient, variableOverrides ?? {}, window.location.origin), crypto.randomUUID())
            .then(() => setTestState('sent'))
            .catch((cause) => { setTestState('idle'); setTestError(cause instanceof ApiError ? cause.message : 'Không gửi được email thử.'); });
        }}
      >{testState === 'sending' ? 'Đang gửi thử…' : 'Gửi thử cho tôi'}</button>
      {testState === 'sent' && <p className="template-preview-ready" role="status">✓ Đã gửi email thử tới hộp thư của bạn.</p>}
      {testError && <p className="template-warning" role="alert">{testError}</p>}
    </aside>
    <section className="template-preview-rendered" aria-label="Nội dung email đã render">
      <header><span>Xem trước · {recipientLabel}</span><b>{result.subject || 'Chưa có tiêu đề email'}</b></header>
      <div className="mail-preview-stage">
        {/* Same sandboxed-iframe containment as TemplatePreviewOverlay -- see
            that component for the full rationale. */}
        <iframe className="template-preview-frame" title="Bản xem trước email gửi thật" sandbox="" srcDoc={result.html} />
      </div>
    </section>
  </div>;
}
