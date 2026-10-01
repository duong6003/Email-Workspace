import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getCurrentUser } from '../../api/auth.js';
import { ApiError } from '../../api/problem.js';
import { apiFieldErrors, firstValidationError, requiredText, type FieldValidationErrors } from '../../api/frontend-validation.js';
import {
  analyzeTemplate, archiveTemplate, createTemplate, listTemplates, previewTemplateDraft, previewTemplateVersion, sendTemplateVersionTest,
  type EmailTemplateSummary, type TemplateAnalysis, type TemplatePreview, type TemplateStatus,
} from '../../api/templates.js';
import { UiIcon } from '../../app/ui-icons.js';
import { useSession } from '../../auth/use-session.js';
import { missingImportedImages } from './imported-image-sources.js';
import { LINT_MESSAGE } from './lint-messages.js';
import { TEMPLATE_PREVIEW_SAMPLES, editorPathFor, templateContentIsReadOnly, type TemplatePreviewSampleKey } from './template-editor.js';
import { TemplateThumbnail } from './TemplateThumbnail.js';
import { EntityActionMenu } from '../../components/EntityActionMenu.js';
import { ModalFrame } from '../../components/ModalFrame.js';

type Overlay = null | { kind: 'import' } | { kind: 'preview'; template: EmailTemplateSummary } | { kind: 'sendTest'; template: EmailTemplateSummary } | { kind: 'archive'; template: EmailTemplateSummary };

const PREVIEW_SAMPLES = TEMPLATE_PREVIEW_SAMPLES;
type PreviewSampleKey = TemplatePreviewSampleKey;

function TemplateLoadError({ onRetry }: { onRetry: () => void }) {
  return <div className="module-card permission-denied-card">
    <i aria-hidden="true"><UiIcon name="warning" size={22} /></i>
    <span className="status danger" role="status">Không thể tải dữ liệu</span>
    <h2>Không thể tải thư viện template</h2>
    <p>Đã xảy ra lỗi khi tải template. Vui lòng thử lại.</p>
    <button type="button" className="secondary-button" onClick={onRetry}><UiIcon name="refresh" size={16} /> Thử lại</button>
  </div>;
}

/**
 * MC-UI-006 upload_html/analyze/review_report/create_draft.
 *
 * S7 Task 44 made this two steps rather than one. It used to analyse and create
 * in a single click, which meant the analysis was fetched, stored in state, and
 * then thrown away as the modal closed -- the user learned what the sanitizer had
 * discarded only by opening the saved draft and noticing something missing. The
 * import now stops on the report: what went, how much of it, and where a
 * replacement exists, what to write instead. Nothing is repaired automatically
 * (ADR-043's rule for `missing_assets`, applied to every finding here).
 *
 * The report's lines come from `validation.changes`, which the API produces by
 * comparing what went into each stage of the sanitizer with what came out of it.
 * They are sentences rather than codes on purpose (sanitizer-report design §3.4):
 * this surface exists for a person to read. The six lint codes beside them are
 * the machine-readable half, and they already have their own shape.
 */
function ImportTemplateOverlay({ onClose, onCreated }: { onClose: () => void; onCreated: (created: { id: string; origin: 'imported' | 'builder' }, undeclaredVariableCount: number) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldValidationErrors>({});
  const [analysis, setAnalysis] = useState<TemplateAnalysis | null>(null);
  /**
   * `import_fallback`. Analysis is a convenience, not a gate: the API sanitizes
   * on save regardless, so an author whose analysis request failed must still be
   * able to keep their work. Refusing to save because a report could not be
   * produced would lose the import over a diagnostic.
   */
  const [fallback, setFallback] = useState(false);
  /**
   * `missing_assets`, read from what the author supplied rather than from the
   * response: the sanitized HTML no longer contains the addresses being reported.
   */
  const missingImages = useMemo(() => missingImportedImages(html), [html]);

  const readFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setError('Tệp HTML vượt quá giới hạn 5 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => { setHtml(typeof reader.result === 'string' ? reader.result : ''); setAnalysis(null); setFallback(false); setError(null); setFieldErrors((current) => { const next = { ...current }; delete next.html; return next; }); };
    reader.onerror = () => setError('Không thể đọc tệp HTML.');
    reader.readAsText(file, 'utf-8');
  };

  const failWith = (cause: unknown, whenUnexplained: string) => {
    const serverErrors = apiFieldErrors(cause);
    setFieldErrors(serverErrors);
    setError(firstValidationError(serverErrors) ?? (cause instanceof ApiError ? cause.message : whenUnexplained));
  };

  const analyse = async () => {
    const missingHtml = requiredText(html, 'Chọn tệp HTML hoặc dán mã HTML trước khi phân tích.');
    if (missingHtml) { setFieldErrors({ html: missingHtml }); setError(missingHtml); return; }
    setAnalysing(true); setError(null); setFieldErrors({}); setFallback(false);
    try { setAnalysis(await analyzeTemplate({ subject, html })); }
    catch (cause) {
      // A rejected payload is the author's to fix and keeps them on the form; a
      // failure with nothing to point at is ours, and drops to the raw-HTML path
      // rather than stranding them.
      const serverErrors = apiFieldErrors(cause);
      if (Object.keys(serverErrors).length > 0) failWith(cause, 'Không thể phân tích HTML.');
      else setFallback(true);
    }
    finally { setAnalysing(false); }
  };

  const submit = async () => {
    const clientErrors = Object.fromEntries([
      ['name', requiredText(name, 'Nhập tên template để nhận biết trong thư viện.')],
      ['html', requiredText(html, 'Chọn tệp HTML hoặc dán mã HTML trước khi lưu.')],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])));
    if (Object.keys(clientErrors).length > 0) { setFieldErrors(clientErrors); setError(firstValidationError(clientErrors)); return; }
    if (!analysis && !fallback) { await analyse(); return; }
    setBusy(true); setError(null); setFieldErrors({});
    try {
      // The raw HTML, not the sanitized copy the report was computed from.
      //
      // Sending the sanitized copy looked safer -- save exactly what was shown --
      // but it erased the report from the saved draft: sanitizing an already
      // clean document removes nothing, so `draft_validation_json.changes` came
      // back empty and an author reopening the template a week later had no way
      // to learn what the import had cost. Caught by the e2e, which asserts the
      // sentences survive the round trip.
      //
      // Safe because sanitization is idempotent: `sanitize(sanitize(x))` is
      // byte-identical to `sanitize(x)`, asserted in template-html-sanitizer's
      // own tests, so the draft that gets stored is the same one the report
      // described.
      const created = await createTemplate({ name, subject, html });
      const removed = created.validation.changes.length;
      onCreated(created, new Set((analysis?.unknownVariables ?? []).map((variable) => variable.key)).size);
      onClose();
      const messages = [removed > 0 ? `đã loại bỏ ${removed} loại nội dung không dùng được` : null, analysis && analysis.unknownVariables.length > 0 ? `cần khai báo ${analysis.unknownVariables.length} biến riêng trước khi xuất bản` : null].filter(Boolean);
      window.dispatchEvent(new CustomEvent('eow:template-toast', { detail: messages.length > 0 ? `Đã lưu bản nháp; ${messages.join('; ')}.` : 'Đã lưu bản nháp template.' }));
    } catch (cause) { failWith(cause, 'Không thể import template.'); }
    finally { setBusy(false); }
  };

  const removedCount = analysis?.validation.changes.length ?? 0;
  const unknownCount = new Set((analysis?.unknownVariables ?? []).map((variable) => variable.key)).size;
  const clean = Boolean(analysis) && removedCount === 0 && missingImages.length === 0;

  return <div className="overlay-backdrop" onMouseDown={onClose}>
    {/* `modal-workspace` rather than `modal-medium`: the prototype puts source and
        report side by side (`v3-import-work` is a two-column grid that collapses
        below 820px), and a 620px modal would have collapsed it always -- which is
        how the report ended up below a long textarea, out of sight until you
        scrolled. ADR-044. */}
    <section role="dialog" aria-modal="true" aria-labelledby="template-import-title" className="action-overlay modal-workspace" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="template-import-title">Import HTML</h2><p>Chọn tệp HTML tối đa 5 MB hoặc dán mã. Script, iframe và nguồn ảnh không an toàn sẽ bị loại bỏ trước khi lưu.</p></div><button aria-label="Đóng cửa sổ" onClick={onClose}>×</button></header>
      <div className="overlay-content">
        {/* Name and subject have no counterpart in the prototype, which replaces the
            open document rather than creating a named template. The API requires a
            name, so they stay -- recorded here rather than left to be rediscovered. */}
        <div className="modal-form-grid">
          <label className={`modal-field ${fieldErrors.name ? 'field-invalid' : ''}`}><span>Tên template <i className="required-mark">*</i></span><input autoFocus aria-invalid={Boolean(fieldErrors.name)} value={name} onChange={(event) => { setName(event.target.value); setFieldErrors((current) => { const next = { ...current }; delete next.name; return next; }); }} maxLength={160} /><small className={fieldErrors.name ? 'field-error' : 'field-help'}>{fieldErrors.name ?? 'Thiếu tên sẽ không thể lưu template.'}</small></label>
          <label className="modal-field"><span>Tiêu đề email</span><input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={998} /><small className="field-help">Có thể để trống khi lưu nháp, nhưng phải nhập trước khi xuất bản.</small></label>
        </div>

        <div className="v3-import-work">
          <div className="v3-import-source">
            <label className="v3-import-file">
              <input className="visually-hidden" data-mc-action="MC-UI-006.upload_html" type="file" accept=".html,.htm,text/html" onChange={(event) => readFile(event.target.files?.[0])} />
              <span>&lt;/&gt;</span>
              <b>{html ? <span data-mc-state="MC-UI-006.file_selected">Đã nạp HTML — chọn tệp khác</span> : 'Chọn tệp HTML'}</b>
              <small>.html · .htm, tối đa 5 MB</small>
            </label>
            <span>hoặc dán mã nguồn</span>
            <textarea
              aria-label="Mã HTML" aria-invalid={Boolean(fieldErrors.html)} value={html}
              onChange={(event) => { setHtml(event.target.value); setAnalysis(null); setFallback(false); setFieldErrors((current) => { const next = { ...current }; delete next.html; return next; }); }}
              maxLength={6 * 1024 * 1024} placeholder="<!doctype html>…"
            />
            {fieldErrors.html && <small className="field-error">{fieldErrors.html}</small>}
            <button type="button" data-mc-action="MC-UI-006.analyze" disabled={analysing || busy || !html.trim()} onClick={() => void analyse()}>
              {analysing ? <span data-mc-state="MC-UI-006.import_analyzing">Đang phân tích…</span> : analysis || fallback ? 'Phân tích lại' : 'Phân tích cấu trúc'}
            </button>
          </div>

          {/* MC-UI-006 import_fallback. The analysis is a diagnostic; losing one must
              not cost the author their import. The API sanitizes on save either way,
              so the draft is exactly as safe -- only the explanation is missing. */}
          {fallback ? <div className="v3-import-report" data-mc-state="MC-UI-006.import_fallback">
            <div className="v3-import-score warn">
              <span>!</span>
              <div><b>Chưa phân tích được tệp này</b><small>Bản nháp vẫn lưu được bằng HTML thô.</small></div>
            </div>
            <section className="warn">
              <h3>Điều này có nghĩa gì</h3>
              <p>Hệ thống luôn dọn nội dung không an toàn khi lưu, nên bản nháp an toàn đúng như mọi lần. Chỉ là lần này không kèm được báo cáo chi tiết về những gì bị loại bỏ.</p>
            </section>
          </div>
          : analysis ? <div className="v3-import-report" data-mc-action="MC-UI-006.review_report">
            <div className={`v3-import-score ${clean ? '' : 'warn'}`}>
              <span>{clean ? '✓' : '!'}</span>
              <div>
                <b>{clean ? 'Giữ nguyên được toàn bộ nội dung' : 'Có phần cần xem lại trước khi lưu'}</b>
                <small>{analysis.variables.length} vị trí biến · {analysis.catalogue.length} trường dữ liệu khả dụng</small>
              </div>
            </div>

            {/* The prototype's four tiles are Native blocks / Preserved fallback /
                Blocked / Assets to link. The first two count blocks produced by
                importing INTO the builder, which ADR-037 §3 forbids and the S7 plan
                fences off explicitly, so they are replaced by the two counts this
                import actually produces. Recorded rather than silently dropped
                (ADR-044 clause 4). */}
            <div className="v3-import-metrics">
              <div className={removedCount ? 'warn' : ''}><b>{removedCount}</b><span>Loại nội dung bị loại</span></div>
              <div className={missingImages.length ? 'warn' : ''}><b>{missingImages.length}</b><span>Ảnh cần thay</span></div>
              <div className={unknownCount ? 'warn' : ''}><b>{unknownCount}</b><span>Biến chưa khai báo</span></div>
              <div className={analysis.lint.length ? 'warn' : ''}><b>{analysis.lint.length}</b><span>Cảnh báo nội dung</span></div>
            </div>

            {removedCount > 0 && <section className="warn" data-mc-state="MC-UI-006.import_partial">
              <h3>Đã loại bỏ khỏi email</h3>
              {analysis.validation.changes.map((change) => <p key={change}>⚠ {change}</p>)}
            </section>}

            {/* MC-UI-006 missing_assets. Listed, never repaired (ADR-043). Read from
                the pasted HTML, because the sanitized copy has already had these
                addresses removed and can only say how many went, never which. */}
            {missingImages.length > 0 && <section data-mc-state="MC-UI-006.missing_assets">
              <h3>Tài nguyên cần thay thế</h3>
              <p>Địa chỉ không phải https sẽ bị loại bỏ. Tải ảnh lên thư viện rồi chèn lại sau khi lưu.</p>
              {missingImages.map((image) => <code key={image.src}>{image.alt ? `${image.alt} — ` : ''}{image.src}</code>)}
            </section>}

            {analysis.unknownVariables.length > 0 && <section>
              <h3>Biến chưa khai báo</h3>
              <p>Bản nháp vẫn được lưu; mở template để tạo biến riêng trước khi xuất bản.</p>
              {[...new Set(analysis.unknownVariables.map((variable) => variable.key))].map((key) => <code key={key}>{`{{${key}}}`}</code>)}
            </section>}

            {analysis.lint.length > 0 && <section className="warn">
              <h3>Cảnh báo nội dung</h3>
              {analysis.lint.map((issue) => <p key={`${issue.code}-${issue.field}`}>⚠ {LINT_MESSAGE[issue.code](issue.count)}</p>)}
            </section>}

            {clean && analysis.lint.length === 0 && analysis.unknownVariables.length === 0 && <section>
              <h3>Không có gì bị loại bỏ</h3>
              <p>Email sẽ hiển thị đúng như tệp gốc.</p>
            </section>}
          </div>
          : <div className="v3-import-empty">
            <span>⇥</span>
            <b>Nạp một email HTML để bắt đầu</b>
            <p>Hệ thống sẽ nêu rõ những gì bị loại bỏ, ảnh nào không hiển thị được và biến nào chưa khai báo — trước khi bản nháp được tạo.</p>
          </div>}
        </div>

        {error && <p className="login-error" data-mc-state="MC-UI-006.error" role="alert">{error}</p>}
      </div>
      <footer>
        <span className="footer-summary">{analysis ? `${removedCount} loại bị loại · ${missingImages.length} ảnh cần thay` : fallback ? 'Không có báo cáo — vẫn lưu được bằng HTML thô' : 'Phân tích trước khi tạo bản nháp'}</span>
        <button className="secondary-button" onClick={onClose}>Hủy</button>
        {/* Disabled until a report exists (or the fallback path opened it): the point
            of this screen is that nobody creates a draft without first being told
            what the import cost. */}
        <button className="primary-button" data-mc-action="MC-UI-006.create_draft" disabled={busy || analysing || !(analysis || fallback)} onClick={() => void submit()}>{busy ? 'Đang lưu…' : fallback ? 'Lưu bằng HTML thô' : 'Lưu template'}</button>
      </footer>
    </section>
  </div>;
}

function ArchiveTemplateOverlay({ template, onClose, onArchived }: { template: EmailTemplateSummary; onClose: () => void; onArchived: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archive = async () => {
    setBusy(true); setError(null);
    try { await archiveTemplate(template.id); onArchived(); onClose(); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : 'Không thể lưu trữ template.'); }
    finally { setBusy(false); }
  };
  return <ModalFrame titleId="archive-template-title" title="Lưu trữ template" description="Template sẽ không còn xuất hiện trong thư viện hoạt động; các phiên bản đã dùng vẫn được giữ." size="small" onClose={onClose} footer={<><button className="secondary-button" disabled={busy} onClick={onClose}>Hủy</button><button className="danger-button" disabled={busy} onClick={() => void archive()}>{busy ? 'Đang lưu trữ…' : 'Lưu trữ template'}</button></>}>
    <div className="confirmation-copy"><b>{template.name}</b><p>Hãy xác nhận bạn muốn lưu trữ template này.</p></div>{error && <p className="login-error" role="alert">{error}</p>}
  </ModalFrame>;
}

/** BR-TPL-005/007/012 (composePreview): lenient server render, desktop/mobile toggle, sample-recipient switch. */
function TemplatePreviewOverlay({ template, readOnly, onClose, onSendTest }: { template: EmailTemplateSummary; readOnly: boolean; onClose: () => void; onSendTest: () => void }) {
  const [sample, setSample] = useState<PreviewSampleKey>('an');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [result, setResult] = useState<TemplatePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const { label: _label, ...mergeData } = PREVIEW_SAMPLES[sample];
    try { setResult(template.latestVersionId ? await previewTemplateVersion(template.latestVersionId, mergeData) : await previewTemplateDraft(template.id, mergeData)); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : 'Không thể tạo bản xem trước.'); }
  }, [sample, template.id, template.latestVersionId]);

  useEffect(() => { void load(); }, [load]);

  return <div className="overlay-backdrop" onMouseDown={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="template-preview-title" className="action-overlay modal-large template-preview-overlay" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="template-preview-title">Xem trước email</h2><p>Nội dung thực tế sau khi thay dữ liệu của người nhận mẫu.</p></div><button aria-label="Đóng cửa sổ" onClick={onClose}>×</button></header>
      <div className="overlay-content">
        <div className="compose-preview">
          <div className="compose-preview-toolbar">
            <label><span>Người nhận mẫu</span>
              <select value={sample} onChange={(event) => setSample(event.target.value as PreviewSampleKey)}>
                {(Object.keys(PREVIEW_SAMPLES) as PreviewSampleKey[]).map((key) => <option key={key} value={key}>{PREVIEW_SAMPLES[key].label}</option>)}
              </select>
            </label>
            <div className="device-switch">
              <button className={device === 'desktop' ? 'active' : ''} onClick={() => setDevice('desktop')}>▱ Desktop</button>
              <button className={device === 'mobile' ? 'active' : ''} onClick={() => setDevice('mobile')}>▯ Mobile</button>
            </div>
          </div>
          {error && <p className="login-error" role="alert">{error}</p>}
          {!error && !result && <div className="template-preview-loading" role="status">Đang tạo bản xem trước…</div>}
          {result && <div className="template-preview-layout">
            <aside className="template-preview-summary">
              <div className="mail-preview-meta">
                <div><span>Người nhận</span><b>{PREVIEW_SAMPLES[sample].email}</b></div>
                <div><span>Tiêu đề</span><b>{result.subject || 'Chưa có tiêu đề'}</b></div>
              </div>
              {result.missingKeys.length > 0 ? <p className="template-warning" role="status">Thiếu dữ liệu mẫu cho: {result.missingKeys.join(', ')}</p> : <p className="template-preview-ready">✓ Dữ liệu mẫu đã được thay đầy đủ.</p>}
            </aside>
            <section className="template-preview-rendered" aria-label="Nội dung email đã render">
              <header><span>Nội dung người nhận sẽ thấy</span><b>{result.subject || 'Chưa có tiêu đề email'}</b></header>
              <div className={`mail-preview-stage ${device}`}>
              {/* Sandboxed and isolated from the app's own CSS -- unlike the previous
                  dangerouslySetInnerHTML render, the app's global stylesheet cannot
                  cascade into the email markup, so this shows what a recipient's
                  own mail client will actually render. sandbox="" grants nothing
                  back (no scripts, no same-origin, no forms, no top-level
                  navigation); result.html was already sanitized when saved and
                  again by the strict-mode renderer. */}
                <iframe className="template-preview-frame" title="Bản xem trước email" sandbox="" srcDoc={result.html} />
              </div>
            </section>
          </div>}
        </div>
      </div>
      {/* Gửi thử is POST /template-versions/:id/test-send -- content:manage. */}
      <footer><button className="secondary-button" onClick={onClose}>Đóng</button>{!readOnly && <button className="primary-button" onClick={onSendTest}>Gửi thử email này</button>}</footer>
    </section>
  </div>;
}

/** BR-TPL-011 (sendTest): recipient is always the authenticated actor's own email, never user-suppliable — see templates.service.ts D4. */
function TemplateSendTestOverlay({ template, onClose }: { template: EmailTemplateSummary; onClose: () => void }) {
  const [selfEmail, setSelfEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void getCurrentUser().then((me) => setSelfEmail(me.email)).catch(() => setSelfEmail(null)); }, []);

  const send = async () => {
    if (!template.latestVersionId) return;
    setBusy(true); setError(null);
    try {
      // Note the spread carries `label` through as a merge key, unlike the preview
      // path above which strips it. Pre-existing, and left alone here: the sample's
      // key set is what BR-TPL-005's `missingKeys` is computed against.
      await sendTemplateVersionTest(template.latestVersionId, { ...PREVIEW_SAMPLES.an }, crypto.randomUUID());
      window.dispatchEvent(new CustomEvent('eow:template-toast', { detail: `Đã gửi email thử${selfEmail ? ` đến ${selfEmail}` : ''}.` }));
      onClose();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : 'Không thể gửi email thử.'); }
    finally { setBusy(false); }
  };

  return <div className="overlay-backdrop" onMouseDown={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="template-send-test-title" className="action-overlay modal-small" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="template-send-test-title">Gửi email thử</h2><p>Kiểm tra email thực tế trước khi gửi cho toàn bộ người nhận.</p></div><button aria-label="Đóng cửa sổ" onClick={onClose}>×</button></header>
      <div className="overlay-content">
        <div className="info-banner">Email thử sẽ được gửi tới {selfEmail ?? 'tài khoản đang đăng nhập'}. Bản thử không được ghi vào lịch sử gửi chính thức.</div>
        {error && <p className="login-error" role="alert">{error}</p>}
      </div>
      <footer><button className="secondary-button" disabled={busy} onClick={onClose}>Hủy</button><button className="primary-button" disabled={busy} onClick={() => void send()}>{busy ? 'Đang gửi…' : 'Gửi bản thử'}</button></footer>
    </section>
  </div>;
}

export function TemplatesScreen() {
  const navigate = useNavigate();
  const session = useSession();
  // content:read reaches this library; only content:manage may change what is
  // in it. Same split the editor uses (§5.1) -- browsing and previewing stay,
  // importing, archiving and test-sending go.
  const readOnly = templateContentIsReadOnly(session.data?.permissions);
  const [items, setItems] = useState<EmailTemplateSummary[] | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'draft' | 'published'>('all');
  const [error, setError] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [startingMailcraft, setStartingMailcraft] = useState(false);

  /**
   * The other half of "hai con đường tạo template" (spec §1.2): Import HTML
   * has always created `origin: 'imported'` here, but nothing created
   * `origin: 'builder'` -- S3/S4's own e2e coverage reaches `/build` by
   * POSTing the API directly (`origin: 'builder'`), which a real user cannot
   * do. No name/subject prompt: the builder's own title field (already
   * wired) is where that gets typed, matching the "ten minutes, nobody to
   * ask" target in mailcraft-design-direction.md §2.
   */
  /**
   * The draft name has to be unique on the way in. Template names are unique
   * per tenant (unique index; the service turns 23505 into
   * TEMPLATE_NAME_CONFLICT), and this used to post the literal string "Email
   * chưa đặt tên" every time -- so the first click of this button worked and
   * every later one 409'd, permanently, in every tenant. Probed against the
   * running API: same name 409 twice, a fresh name 201.
   *
   * Making POST /templates attach a version to the existing template instead
   * was considered and rejected -- versions have their own endpoints, and a
   * create that sometimes does not create would write into whatever template
   * happened to share the name, including another author's.
   */
  const untitledDraftName = () => {
    const now = new Date();
    // Assembled rather than handed to toLocaleString: vi-VN orders that option
    // set as "20:02:14 10-09", time first and the date ambiguous. Seconds, not
    // minutes -- two drafts started inside the same minute is an ordinary thing
    // to do, and a colliding name puts the button straight back into the state
    // this exists to fix.
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${pad(now.getDate())}/${pad(now.getMonth() + 1)} `
      + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return `Email chưa đặt tên ${stamp}`;
  };

  const startMailcraft = async () => {
    setStartingMailcraft(true);
    try {
      const created = await createTemplate({ name: untitledDraftName(), origin: 'builder' });
      navigate(editorPathFor(created));
    } catch (cause) {
      setToast(cause instanceof ApiError ? cause.message : 'Không thể tạo template mới.');
      window.setTimeout(() => setToast(null), 3000);
    } finally {
      setStartingMailcraft(false);
    }
  };

  const load = useCallback(async () => {
    setError(false);
    try { setItems((await listTemplates({ search: search || undefined, status: status === 'all' ? undefined : status, limit: 100 })).items); }
    catch { setError(true); }
  }, [search, status]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timeout = window.setTimeout(() => setSearch(searchInput), 300); return () => window.clearTimeout(timeout); }, [searchInput]);
  useEffect(() => {
    const listener = (event: Event) => { setToast((event as CustomEvent<string>).detail); window.setTimeout(() => setToast(null), 3000); };
    window.addEventListener('eow:template-toast', listener);
    return () => window.removeEventListener('eow:template-toast', listener);
  }, []);

  const statusLabel = useMemo(() => ({ draft: 'Bản nháp', published: 'Đã xuất bản', archived: 'Đã lưu trữ' } satisfies Record<TemplateStatus, string>), []);
  if (error) return <TemplateLoadError onRetry={() => void load()} />;

  return <section className="workspace-module-frame standard-module-frame templates-module">
    <header className="module-frame-toolbar standard-filter-bar">
      <div className="search-box"><UiIcon name="search" /><input aria-label="Tìm email template" placeholder="Tìm email template" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} /></div>
      <div className="pill-filter quick-filter" aria-label="Lọc trạng thái template">{(['all', 'draft', 'published'] as const).map((value) => <button key={value} className={status === value ? 'active' : ''} onClick={() => setStatus(value)}>{value === 'all' ? 'Tất cả' : statusLabel[value]}</button>)}</div>
      {/* Mailcraft is the main way to author here, and the pair used to say the
          opposite: Mailcraft neutral, Import in the coral primary. This one
          carries Mailcraft's own colour and mark so it reads as opening an
          application rather than performing an action, and Import steps back to
          secondary. Import is NOT removed -- an imported template is HTML with
          no component tree (ADR-037), so the builder cannot take its place. */}
      {!readOnly && <button className="mc-launch-button" disabled={startingMailcraft} onClick={() => void startMailcraft()}><img src="/mailcraft-mark-white.svg" alt="" /> {startingMailcraft ? 'Đang tạo…' : 'Soạn bằng Mailcraft'}</button>}
      {!readOnly && <button className="secondary-button" onClick={() => setOverlay({ kind: 'import' })}><UiIcon name="upload" size={16} /> Import HTML</button>}
    </header>
    <div className="module-frame-body">
      {items === null ? <div className="template-grid" aria-busy="true">{[0, 1, 2, 3].map((index) => <article className="template-card template-skeleton" key={index}><div className="template-preview" /><div className="template-meta"><div><b>Đang tải…</b><small>Đang lấy thư viện template</small></div></div></article>)}</div> : items.length === 0 ? <div className="module-card templates-empty"><UiIcon name="template" size={30} /><h2>Chưa có template phù hợp</h2><p>{readOnly ? 'Không có template nào khớp với bộ lọc hiện tại. Vai trò của bạn cho phép xem template nhưng không tạo mới.' : 'Dựng bằng Mailcraft nếu không có sẵn file HTML, hoặc Import HTML nếu đã có. Nội dung import sẽ được kiểm tra và làm sạch trước khi lưu.'}</p>{!readOnly && <div className="templates-empty-actions"><button className="mc-launch-button" disabled={startingMailcraft} onClick={() => void startMailcraft()}><img src="/mailcraft-mark-white.svg" alt="" />{startingMailcraft ? 'Đang tạo…' : 'Soạn bằng Mailcraft'}</button><button className="secondary-button" onClick={() => setOverlay({ kind: 'import' })}>Import HTML</button></div>}</div> : <div className="template-grid">{items.map((template) => <article className="template-card" key={template.id}><button className="template-preview" onClick={() => setOverlay({ kind: 'preview', template })} aria-label={`Xem trước template ${template.name}`}><TemplateThumbnail templateId={template.id} poster={<><small className="template-sample-label">HTML TEMPLATE</small><span className="template-preview-brand">EMAIL</span><h3>{template.name}</h3><p>{template.subject || 'Chưa có tiêu đề'}</p><i /><i /></>} /><span className="template-hover-layer"><span>◉</span><b>Xem trước template</b><small>Kiểm tra desktop, mobile và dữ liệu mẫu</small></span></button><div className="template-meta"><div><b>{template.name}</b><small>{statusLabel[template.status]} · cập nhật {new Date(template.updatedAt).toLocaleDateString('vi-VN')}</small></div><EntityActionMenu label={`Tùy chọn template ${template.name}`} items={[{ label: readOnly ? 'Xem nội dung template' : 'Chỉnh sửa template', icon: readOnly ? 'eye' : 'edit', onSelect: () => navigate(editorPathFor(template)) }, { label: 'Xem trước email', icon: 'eye', onSelect: () => setOverlay({ kind: 'preview', template }) }, ...(readOnly ? [] : [{ label: 'Lưu trữ template', icon: 'trash' as const, tone: 'danger' as const, onSelect: () => setOverlay({ kind: 'archive', template }) }])]} /></div></article>)}</div>}
      {!readOnly && <button className="drop-zone" onClick={() => setOverlay({ kind: 'import' })}><b>Kéo thả file HTML vào đây</b><span>Hệ thống sẽ kiểm tra cấu trúc và tài nguyên trước khi lưu.</span></button>}
    </div>
    {toast && <div className="toast" role="status">{toast}</div>}
    {/* An import that references variables nobody has declared leaves the author
        with a toast and a search. The editor already turns each undeclared
        variable into a button that opens the create-variable overlay with the
        key filled in, so send them straight there rather than describing where
        to go. Imports with nothing undeclared stay on the library, where the
        new card is the useful thing to see. */}
    {overlay?.kind === 'import' && <ImportTemplateOverlay
      onClose={() => setOverlay(null)}
      onCreated={(created, undeclaredVariableCount) => {
        void load();
        if (undeclaredVariableCount > 0) navigate(editorPathFor(created));
      }}
    />}
    {overlay?.kind === 'preview' && <TemplatePreviewOverlay template={overlay.template} readOnly={readOnly} onClose={() => setOverlay(null)} onSendTest={() => setOverlay({ kind: 'sendTest', template: overlay.template })} />}
    {overlay?.kind === 'sendTest' && <TemplateSendTestOverlay template={overlay.template} onClose={() => setOverlay(null)} />}
    {overlay?.kind === 'archive' && <ArchiveTemplateOverlay template={overlay.template} onClose={() => setOverlay(null)} onArchived={() => void load()} />}
  </section>;
}
