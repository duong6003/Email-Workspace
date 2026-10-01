import { useEffect, useState } from 'react';
import { ApiError } from '../../api/problem.js';
import { getTemplateVersion, previewTemplateVersion, type TemplatePreview, type TemplateVersion, type TemplateVersionSummary } from '../../api/templates.js';
import { TEMPLATE_PREVIEW_SAMPLE, templateConflictExcerpt } from './template-editor.js';
import {
  changedVersionFields,
  diffVersionHtml,
  formatHiddenDiffCount,
  truncateLineDiff,
  versionsAreIdentical,
  VERSION_DIFF_FIELD_LABEL,
} from './version-diff.js';

/** Rows of `html` line diff shown before `truncateLineDiff` counts the rest as
 *  hidden. Inside version-diff.test.ts's tested range (6-20), and small enough
 *  that `.version-diff-line-list` stays a list rather than a second scroll
 *  region fighting the host dialog's own. */
const COMPARE_HTML_LINE_LIMIT = 14;

/**
 * MC-UI-009's version list, extracted from `TemplateEditorScreen` so the
 * builder's "Lịch sử" rail destination can show the same thing (ADR-044
 * Task SV-2, decision 1: a rail entry reaches what EOW already has -- it does
 * not grow a second version history beside the one that exists).
 *
 * Only the list is shared. Each screen keeps its own container -- a
 * `ModalFrame` in the editor, the prototype's `v3-sheet` in the builder --
 * and its own restore call, because restore has to write through that
 * screen's own draft revision (a stale one comes back 412 against its own
 * action, the trap documented on `TemplateEditorScreen.restore`).
 *
 * S8 ports the rest of `studio.tsx`'s `history` sheet branch (MC-UI-009
 * chrome): immutability banner, timeline rows, selection summary, actionbar.
 * Selection lives here rather than per-screen because preview and compare both
 * act on it and both screens must agree -- the SV-2 reasoning again.
 *
 * Task 47 (`preview`) calls the existing `POST /template-versions/:id/preview`
 * against one fixed sample, and reuses the mould `TemplatesScreen`,
 * `SendPreviewPanel` and the builder's draft preview already share:
 * `mail-preview-stage` around a sandboxed `template-preview-frame`, plus
 * BR-TPL-005's `missingKeys` line. Not a fourth preview surface -- a fourth
 * caller of the one mould.
 *
 * Task 48 (`compare`) diffs two published versions through `version-diff.ts`
 * (line diff for `html`, changed-field flags for the rest, a `contentHash`
 * short-circuit). "⇄ So sánh" opens a second selection step instead of making
 * the timeline multi-select, so "Xem phiên bản" and "＋ Tạo bản nháp mới" keep
 * reading the same `selected` they always did; a history with one version
 * disables it with a `title` rather than opening an empty picker.
 *
 * Preview, the compare picker and the diff each REPLACE this component's body
 * rather than stacking a dialog inside either host's own chrome, with a
 * "‹ Quay lại danh sách" button back -- one behaviour that works in the
 * builder's `v3-sheet` and the editor's `ModalFrame` alike.
 *
 * Two things the prototype draws here are deliberately NOT ported:
 *
 * - The "Hoạt động" (Activity) tab next to "Phiên bản" in `v3-history-toolbar`.
 *   It opens an audit log the prototype fakes with a toast. EOW has no audit
 *   log: `grep -rn "auditLog\|activityLog" apps/web/src` and the
 *   `apps/api/src/**\/*.ts` route surface both come back empty. Porting the
 *   tab would draw a second empty screen next to the disabled compare button
 *   -- the same reason SV-2 dropped `v3-lang`. Do not restore it without an
 *   audit feature behind it.
 * - The prototype's row 0, "Bản nháp hiện tại" (the live canvas, shown as an
 *   editable timeline entry with its own `selectedVersion === 0` branch).
 *   EOW's version list is only ever published, immutable versions -- the
 *   draft is the canvas the user is already standing on, not a history row.
 *   Every row this component renders is therefore always the "locked"
 *   branch of the prototype's per-row markup; there is no unlocked row.
 */
export function TemplateVersionHistory({ versions, error, busy, readOnly, onRestore }: {
  versions: TemplateVersionSummary[] | null;
  error: string | null;
  busy: boolean;
  readOnly: boolean;
  onRestore: (version: TemplateVersionSummary) => void;
}) {
  // `listTemplateVersions` orders newest-first (`templates.repository` sorts
  // `version.version DESC`), so `versions[0]` is the default -- and the same
  // fallback covers "selected id no longer listed" without a separate effect.
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  // The version itself, not its id, so the preview header can name it without
  // depending on `versions` still listing it.
  const [viewingVersion, setViewingVersion] = useState<TemplateVersionSummary | null>(null);
  const [previewResult, setPreviewResult] = useState<TemplatePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Picker step -> both sides named (metadata) -> both full records fetched.
  // Three presence flags rather than one union, because the picker and the
  // result are two different bodies below.
  const [comparePickerOpen, setComparePickerOpen] = useState(false);
  const [comparePair, setComparePair] = useState<{ left: TemplateVersionSummary; right: TemplateVersionSummary } | null>(null);
  const [compareContent, setCompareContent] = useState<{ left: TemplateVersion; right: TemplateVersion } | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  // Hooks must run before the early returns below -- which is why
  // `viewingVersion` is state rather than derived from `selected`.
  useEffect(() => {
    if (!viewingVersion) return;
    setPreviewResult(null);
    setPreviewError(null);
    let cancelled = false;
    // One fixed sample -- browsing an immutable version does not need the
    // recipient switcher the authoring surfaces own.
    previewTemplateVersion(viewingVersion.id, TEMPLATE_PREVIEW_SAMPLE)
      .then((result) => { if (!cancelled) setPreviewResult(result); })
      .catch((cause) => { if (!cancelled) setPreviewError(cause instanceof ApiError ? cause.message : 'Không thể tạo bản xem trước.'); });
    return () => { cancelled = true; };
  }, [viewingVersion]);

  // `listTemplateVersions` is metadata-only, so `version-diff.ts` needs the
  // full record per side: `getTemplateVersion` twice, `cancelled`-guarded so a
  // stale pair cannot land after a newer pick.
  useEffect(() => {
    if (!comparePair) return;
    setCompareContent(null);
    setCompareError(null);
    let cancelled = false;
    Promise.all([getTemplateVersion(comparePair.left.id), getTemplateVersion(comparePair.right.id)])
      .then(([left, right]) => { if (!cancelled) setCompareContent({ left, right }); })
      .catch((cause) => { if (!cancelled) setCompareError(cause instanceof ApiError ? cause.message : 'Không thể tải nội dung để so sánh.'); });
    return () => { cancelled = true; };
  }, [comparePair]);

  if (error) return <p className="login-error" role="alert">{error}</p>;
  if (versions === null) return <p className="compose-variable-state" role="status">Đang tải lịch sử…</p>;
  if (versions.length === 0) {
    return <div className="confirmation-copy" data-mc-state="MC-UI-009.empty">
      <b>Chưa có phiên bản nào</b>
      <p>Template này chưa được xuất bản lần nào. Xuất bản để tạo phiên bản đầu tiên.</p>
    </div>;
  }

  const selected = versions.find((item) => item.id === selectedVersionId) ?? versions[0];

  // Every branch below shares this wrapper. `sheet-history` picks up
  // studio.css's copied refinements; `v3-history-embed` supplies
  // `--workspace-accent`/`--workspace-accent-soft`, which studio.css sets only
  // on `.v3-sheet-bg` -- an ancestor the builder has and `ModalFrame` does
  // not. Full reasoning, with the values, sits on the globals.css rule.
  if (viewingVersion) {
    // `readOnly` never gates this: §2.1 locks writes, not reading.
    return <div className="sheet-history v3-history-embed">
      <div className="compose-preview-toolbar">
        <button type="button" className="secondary-button" onClick={() => setViewingVersion(null)}>‹ Quay lại danh sách</button>
        <b>{`Xem phiên bản ${viewingVersion.version}`}</b>
      </div>
      {previewError && <p className="login-error" data-mc-state="MC-UI-009.error" role="alert">{previewError}</p>}
      {!previewError && !previewResult && <div className="template-preview-loading" data-mc-state="MC-UI-009.loading" role="status">Đang tạo bản xem trước…</div>}
      {previewResult && <section className="template-preview-rendered" aria-label="Nội dung email đã render">
        <header><span>Xem trước · Dữ liệu mẫu</span><b>{previewResult.subject || 'Chưa có tiêu đề email'}</b></header>
        {/* BR-TPL-005: the server decides what is missing. Hiding missingKeys
            would turn a preview that cannot be rendered as-is into one that
            looks complete. */}
        {previewResult.missingKeys.length > 0
          ? <p className="template-warning" role="status">Thiếu dữ liệu mẫu cho: {previewResult.missingKeys.join(', ')}</p>
          : <p className="template-preview-ready" role="status">✓ Dữ liệu mẫu đã được thay đầy đủ.</p>}
        <div className="mail-preview-stage">
          {/* ADR-044 records the sandboxed frame as a place this repo is ahead
              of the prototype, not a gap to close. */}
          <iframe className="template-preview-frame" data-mc-state="MC-UI-009.success" title="Bản xem trước email" sandbox="" srcDoc={previewResult.html} />
        </div>
      </section>}
    </div>;
  }

  // Older version on the left regardless of click order, so added/removed
  // reads as "what the newer version changed".
  const pickForCompare = (candidate: TemplateVersionSummary) => {
    const [left, right] = selected.version <= candidate.version ? [selected, candidate] : [candidate, selected];
    setComparePair({ left, right });
    setComparePickerOpen(false);
  };

  if (comparePair) {
    // Same replace-the-whole-body shape as `viewingVersion` above, and the
    // same reason: a fifth dialog stacked on either host's own chrome would
    // be one dialog too many. `readOnly` never gates this either -- comparing
    // two already-published versions writes nothing.
    const identical = compareContent ? versionsAreIdentical(compareContent.left, compareContent.right) : false;
    const changedFields = compareContent && !identical ? changedVersionFields(compareContent.left, compareContent.right) : [];
    const htmlTruncated = compareContent && changedFields.includes('html')
      ? truncateLineDiff(diffVersionHtml(compareContent.left, compareContent.right), COMPARE_HTML_LINE_LIMIT)
      : null;
    return <div className="sheet-history v3-history-embed">
      <div className="compose-preview-toolbar">
        <button type="button" className="secondary-button" onClick={() => { setComparePair(null); setCompareContent(null); setCompareError(null); }}>‹ Quay lại danh sách</button>
        <b>{`So sánh v${comparePair.left.version} · v${comparePair.right.version}`}</b>
      </div>
      {compareError && <p className="login-error" data-mc-state="MC-UI-009.error" role="alert">{compareError}</p>}
      {!compareError && !compareContent && <div className="template-preview-loading" data-mc-state="MC-UI-009.loading" role="status">Đang tải nội dung để so sánh…</div>}
      {/* `versionsAreIdentical` (contentHash) short-circuits before rendering
          an empty-looking grid -- two versions sharing a hash have nothing to
          diff, and a blank `.compose-conflict-diff` would read as broken
          rather than as "nothing changed". `changedFields.length === 0` with
          a different hash should not happen ("if you think version-diff.ts
          itself is wrong here, report it -- don't patch around it" per the
          brief), but is folded into the same message rather than rendering
          an empty grid if it ever does. */}
      {compareContent && (identical || changedFields.length === 0) && <p className="template-preview-ready" data-mc-state="MC-UI-009.success" role="status">✓ Hai phiên bản có nội dung giống hệt nhau.</p>}
      {compareContent && !identical && changedFields.length > 0 && <div className="compose-conflict-diff" data-mc-state="MC-UI-009.success">
        {changedFields.map((field) => field === 'html'
          ? <div key={field}>
              <span>{VERSION_DIFF_FIELD_LABEL.html}</span>
              <ul className="version-diff-line-list" aria-label={`Khác biệt ${VERSION_DIFF_FIELD_LABEL.html.toLowerCase()} theo dòng`}>
                {htmlTruncated!.entries.map((entry, index) => <li key={index} className={`version-diff-line is-${entry.op}`}>
                  <em aria-hidden="true">{entry.op === 'added' ? '+' : entry.op === 'removed' ? '−' : ' '}</em>{entry.line}
                </li>)}
              </ul>
              {htmlTruncated!.hiddenCount > 0 && <small className="field-help">{formatHiddenDiffCount(htmlTruncated!.hiddenCount)}</small>}
            </div>
          : /* `templateConflictExcerpt` is right for these three: version-diff.ts
               rejects it only for `html`, where the emitter's 367-character
               preamble eats the whole 120-character budget. These have no such
               preamble, and a second collapse-and-cut helper beside the one
               that exists would be the duplication this slice keeps refusing. */
            <div key={field}>
              <span>{VERSION_DIFF_FIELD_LABEL[field]}</span>
              <small>{`v${comparePair.left.version}: ${templateConflictExcerpt(compareContent!.left[field])}`}</small>
              <b>{`v${comparePair.right.version}: ${templateConflictExcerpt(compareContent!.right[field])}`}</b>
            </div>)}
      </div>}
    </div>;
  }

  if (comparePickerOpen) {
    // Excludes `selected` -- comparing a version against itself is not a
    // choice worth offering. `versions.length >= 2` is guaranteed here: the
    // "⇄ So sánh" button that leads here is disabled otherwise (below).
    const candidates = versions.filter((version) => version.id !== selected.id);
    return <div className="sheet-history v3-history-embed">
      <div className="compose-preview-toolbar">
        <button type="button" className="secondary-button" onClick={() => setComparePickerOpen(false)}>‹ Quay lại danh sách</button>
        <b>{`Chọn phiên bản để so sánh với v${selected.version}`}</b>
      </div>
      <div className="v3-versions timeline">
        {candidates.map((version) => <button type="button" key={version.id} onClick={() => pickForCompare(version)}>
          <i aria-hidden="true" />
          <div>
            <span>
              <b>{`v${version.version}`}</b>
              <em className="locked">⌾ Đã xuất bản</em>
            </span>
            <small>{new Date(version.publishedAt).toLocaleString('vi-VN')} · {version.publishedBy ? 'đã ghi nhận người xuất bản' : 'không rõ người xuất bản'}</small>
            <p>{version.subject || 'Chưa có tiêu đề'}</p>
          </div>
          <strong>›</strong>
        </button>)}
      </div>
    </div>;
  }

  return <div className="sheet-history v3-history-embed">
    <div className="v3-immutable">
      <span aria-hidden="true">⌾</span>
      <div>
        <b>Lịch sử an toàn tuyệt đối</b>
        <p>Bản đã xuất bản không thể sửa. Khôi phục luôn tạo một bản nháp mới.</p>
      </div>
    </div>
    <div className="v3-history-toolbar">
      {/* Single tab on purpose -- see the file header for why "Hoạt động" is
          not ported. A one-item toggle group still matches the prototype's
          `.v3-history-toolbar>div` shape and CSS. */}
      <div>
        <button type="button" className="active" aria-current="true">Phiên bản</button>
      </div>
      {/* S8 Task 48: compare mode. `readOnly` never gates this -- comparing
          two published versions writes nothing. A history with only one
          published version keeps the button's earlier disabled-with-reason
          shape, just with a reason that now names the actual constraint
          ("nothing to compare against") rather than "not built yet". */}
      <button
        type="button"
        data-mc-action="MC-UI-009.compare"
        disabled={versions.length < 2}
        title={versions.length < 2 ? 'Cần ít nhất 2 phiên bản đã xuất bản để so sánh' : undefined}
        aria-label={versions.length < 2 ? 'So sánh phiên bản (cần thêm phiên bản đã xuất bản)' : 'So sánh phiên bản'}
        onClick={() => setComparePickerOpen(true)}
      >⇄ So sánh</button>
    </div>
    <div className="v3-versions timeline">
      {versions.map((version) => {
        const isSelected = version.id === selected.id;
        return <button
          type="button"
          key={version.id}
          className={isSelected ? 'selected' : ''}
          aria-pressed={isSelected}
          onClick={() => setSelectedVersionId(version.id)}
        >
          <i aria-hidden="true" />
          <div>
            <span>
              <b>{`v${version.version}`}</b>
              <em className="locked">⌾ Đã xuất bản</em>
            </span>
            <small>{new Date(version.publishedAt).toLocaleString('vi-VN')} · {version.publishedBy ? 'đã ghi nhận người xuất bản' : 'không rõ người xuất bản'}</small>
            <p>{version.subject || 'Chưa có tiêu đề'}</p>
          </div>
          <strong>{isSelected ? '✓' : '›'}</strong>
        </button>;
      })}
    </div>
    <div className="v3-history-selection">
      <span>ĐANG CHỌN</span>
      <b>{`Phiên bản ${selected.version} · Bản bất biến`}</b>
      <small>Có thể xem, so sánh hoặc tạo bản nháp mới từ phiên bản này.</small>
    </div>
    <div className="v3-sheet-actionbar history-action">
      {/* S8 Task 47: preview reads the selected version, never gated on
          `readOnly` (spec §2.1 -- read-only locks writes, not reading). */}
      <button type="button" className="secondary" data-mc-action="MC-UI-009.preview" onClick={() => setViewingVersion(selected)}>Xem phiên bản</button>
      {/* §2.1: restore writes, so read-only locks it. The shell's own
          permission_denied notice sits behind this sheet's overlay, so the
          reason goes on the disabled control -- not a second banner. */}
      <button
        type="button"
        disabled={busy || readOnly}
        title={readOnly ? 'Chế độ chỉ đọc — không thể tạo bản nháp mới' : undefined}
        aria-label={readOnly ? 'Tạo bản nháp mới (chế độ chỉ đọc, không khả dụng)' : 'Tạo bản nháp mới'}
        onClick={() => onRestore(selected)}
      >＋ Tạo bản nháp mới</button>
    </div>
  </div>;
}
