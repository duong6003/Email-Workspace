import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { autosaveReducer, type AutosaveAction, type AutosaveState } from '../../api/autosave-reducer.js';
import { deleteTemplateVariable, listTemplateVariables, type ConfiguredVariable } from '../../api/configuredVariables.js';
import { apiFieldErrors, firstValidationError, requiredText, type FieldValidationErrors } from '../../api/frontend-validation.js';
import { ApiError } from '../../api/problem.js';
import { createSequenceGuard } from '../../api/sequence-guard.js';
import {
  analyzeTemplate, archiveTemplate, getTemplate, listTemplateVersions, previewTemplateDraft, publishTemplate, restoreTemplateVersion, updateTemplate,
  type EmailTemplate, type TemplateAnalysis, type TemplatePatch, type TemplatePreview, type TemplateStatus, type TemplateVariableCatalogueItem, type TemplateVersionSummary,
} from '../../api/templates.js';
import { useSession } from '../../auth/use-session.js';
import type { SetShellSaveState } from '../../app/save-state.js';
import { UiIcon } from '../../app/ui-icons.js';
import { EntityActionMenu } from '../../components/EntityActionMenu.js';
import { ModalFrame } from '../../components/ModalFrame.js';
import { TemplateVersionHistory } from './TemplateVersionHistory.js';
import { ManageConfiguredVariableOverlay } from '../../overlays/ManageConfiguredVariableOverlay.js';
import type { TemplateEditorPorts } from './editor-ports.js';
import type { AnalysisRange } from './lint-positions.js';
import { LINT_MESSAGE } from './lint-messages.js';
import { TemplateCodeView } from './TemplateCodeView.js';
import { templatePublishError } from './template-errors.js';
import { TEMPLATE_CONFLICT_FIELD_LABEL, TEMPLATE_PREVIEW_SAMPLE, editorPathFor, groupTemplateCatalogue, insertTemplateVariable, templateConflictExcerpt, templateContentIsReadOnly, templateLoadFailure, textBodyIsEmpty, type TemplateEditorField, type TemplateEditorTab } from './template-editor.js';

type EditorState = AutosaveState<EmailTemplate, TemplatePatch>;
type EditorAction = AutosaveAction<EmailTemplate, TemplatePatch>;

/**
 * The generic autosave reducer needs a draft to start from, and this screen has
 * none until the first GET lands, so the loaded/unloaded distinction lives here
 * rather than forcing every consumer of the reducer to model an empty draft.
 */
function templateEditorReducer(state: EditorState | null, action: EditorAction): EditorState | null {
  if (state) return autosaveReducer(state, action);
  return action.type === 'saved' ? { draft: action.draft, pending: null, inFlight: null, status: 'saved' } : state;
}

/** The screen header carries state the page title cannot know; the shell's own
 *  <h1> already says "Chỉnh sửa template", so repeating it here read as a bug. */
const STATUS_LABEL: Record<TemplateStatus, string> = { draft: 'Bản nháp', published: 'Đã xuất bản', archived: 'Đã lưu trữ' };

const FIELD_LABEL = TEMPLATE_CONFLICT_FIELD_LABEL;
const conflictExcerpt = templateConflictExcerpt;

function EditorFrame({ description, children }: { description: string; children: ReactNode }) {
  return <section className="workspace-module-frame compose-variables-module">
    <header className="workspace-module-topbar"><div><h2>Template</h2><p>{description}</p></div></header>
    <div className="email-workspace-body">{children}</div>
  </section>;
}

/**
 * M6 template authoring: a routed editor rather than a modal, so the draft has
 * an address, autosaves through the same serialized If-Match protocol the
 * campaign composer uses, and can offer a real code editor next to a live
 * server-rendered preview.
 */
export function TemplateEditorScreen() {
  const setShellSaveState = useOutletContext<SetShellSaveState>();
  const navigate = useNavigate();
  const session = useSession();
  const { templateId } = useParams<{ templateId: string }>();
  /**
   * §5.1's read-only permission_denied state. content:read got the caller in
   * here and loads the content; without content:manage every control that
   * would change it is inert. The API enforces the same split independently
   * (BR-AUTH-004), so this is what the user is shown, never what is relied on.
   */
  const readOnly = templateContentIsReadOnly(session.data?.permissions);
  const [state, dispatch] = useReducer(templateEditorReducer, null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorStatus, setLoadErrorStatus] = useState<number | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldValidationErrors>({});
  const [configured, setConfigured] = useState<ConfiguredVariable[] | null>(null);
  const [catalogue, setCatalogue] = useState<TemplateVariableCatalogueItem[] | null>(null);
  const [analysis, setAnalysis] = useState<TemplateAnalysis | null>(null);
  const [analysisStale, setAnalysisStale] = useState(false);
  const [tab, setTab] = useState<TemplateEditorTab>('preview');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [activeField, setActiveField] = useState<TemplateEditorField>('html');
  const [variableQuery, setVariableQuery] = useState('');
  const [variableOverlay, setVariableOverlay] = useState<ConfiguredVariable | { initialKey: string } | 'create' | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<TemplateVersionSummary[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<TemplateVersionSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [conflictServer, setConflictServer] = useState<EmailTemplate | null>(null);
  const [conflictLoadError, setConflictLoadError] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const htmlCaret = useRef(0);
  const analysisSequence = useRef(createSequenceGuard());

  const id = templateId ?? '';
  const ports = useMemo<TemplateEditorPorts>(() => ({
    variables: { list: () => analyzeTemplate({ templateId: id }).then((result) => result.catalogue) },
    preview: { render: ({ mergeData }) => previewTemplateDraft(id, mergeData) },
    lint: { check: (input) => analyzeTemplate({ templateId: id, ...input }) },
    content: {
      load: () => getTemplate(id),
      save: ({ draftRevision, ...patch }) => updateTemplate(id, draftRevision, patch),
      publish: () => publishTemplate(id).then((version) => ({ version: version.version })),
    },
  }), [id]);

  const load = useCallback(() => {
    setLoadError(null);
    setLoadErrorStatus(undefined);
    return ports.content.load()
      .then((draft) => dispatch({ type: 'saved', draft }))
      .catch((cause) => {
        setLoadErrorStatus(cause instanceof ApiError ? cause.status : undefined);
        setLoadError(cause instanceof ApiError ? cause.message : 'Không thể tải template.');
      });
  }, [ports]);
  const loadVariables = useCallback(() => Promise.all([listTemplateVariables(id), ports.variables.list()])
    .then(([owned, items]) => { setConfigured(owned.items); setCatalogue([...items]); })
    .catch((cause) => setActionError(cause instanceof ApiError ? cause.message : 'Không thể tải biến của template.')), [id, ports]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadVariables(); }, [loadVariables]);
  useEffect(() => () => setShellSaveState('idle'), [setShellSaveState]);
  // 'idle' renders as "Đã đồng bộ" in the shell; the autosave wording ("Đã tự
  // động lưu") would promise a save this mode never performs.
  useEffect(() => { setShellSaveState(readOnly ? 'idle' : state?.status ?? 'idle'); }, [readOnly, setShellSaveState, state?.status]);

  const draft = state?.draft;
  // ADR-041: /edit is imported-origin's editor. A builder-origin template
  // reaching this route is a stale link (a bookmark from before it existed,
  // or a saved URL) rather than the primary path -- TemplatesScreen already
  // links straight to /build (Task 13) -- so this only ever needs to be a
  // safety net, not the everyday route.
  useEffect(() => { if (draft?.origin === 'builder') navigate(editorPathFor(draft), { replace: true }); }, [draft, navigate]);
  const subject = draft?.subject ?? '';
  const html = draft?.html ?? '';
  const textBody = draft?.textBody ?? '';
  const loaded = state !== null;
  const nameBlank = loaded && !state.draft.name.trim();
  const savePending = Boolean(state?.pending || state?.inFlight);

  // A blank name is rejected by the update DTO (`z.string().trim().min(1)`), so
  // firing autosave on every keystroke of an emptied name would only produce a
  // stream of 400s. The edit stays in `pending` and flushes as soon as a name
  // is back.
  useEffect(() => {
    // 'error' holds the same way 'conflict' does: a failed save now keeps its
    // patch in `pending`, so retrying on a timer would hammer a down server
    // forever. The next keystroke sets status back to 'idle' and flushes it.
    if (readOnly || !state?.pending || state.inFlight || state.status === 'conflict' || state.status === 'error' || nameBlank) return;
    const timer = window.setTimeout(() => dispatch({ type: 'start' }), 500);
    return () => window.clearTimeout(timer);
  }, [readOnly, state?.pending, state?.inFlight, state?.status, nameBlank]);
  useEffect(() => {
    if (!state?.inFlight) return;
    const patch = state.inFlight;
    void ports.content.save({ ...patch, draftRevision: state.draft.draftRevision })
      .then((saved) => dispatch({ type: 'saved', draft: saved }))
      .catch((cause) => {
        const conflict = cause instanceof ApiError && cause.status === 412;
        dispatch({ type: 'failed', conflict });
        if (!conflict) {
          const serverErrors = apiFieldErrors(cause);
          setFieldErrors(serverErrors);
          setActionError(firstValidationError(serverErrors) ?? (cause instanceof ApiError ? cause.message : 'Không thể lưu thay đổi.'));
          return;
        }
        setConflictLoadError(null);
        void ports.content.load()
          .then(setConflictServer)
          .catch((latestCause) => setConflictLoadError(latestCause instanceof ApiError ? latestCause.message : 'Không thể tải phiên bản mới nhất.'));
      });
  }, [ports, state?.draft.draftRevision, state?.inFlight]);

  // The guard is what stops a slow earlier round trip from overwriting the
  // diagnostics a newer one already produced.
  useEffect(() => {
    if (!state) return;
    const timeout = window.setTimeout(() => {
      const token = analysisSequence.current.issue();
      void ports.lint.check({ subject, html, textBody })
        .then((result) => { if (analysisSequence.current.isCurrent(token)) { setAnalysis(result); setAnalysisStale(false); } })
        // A failed check must never blank the warnings: an empty diagnostics
        // area while the user is typing reads as "I fixed it" when nothing was
        // fixed. The last good analysis stays on screen, marked stale.
        .catch(() => { if (analysisSequence.current.isCurrent(token)) setAnalysisStale(true); });
    }, 450);
    return () => window.clearTimeout(timeout);
  }, [ports, loaded, subject, html, textBody, configured]);

  // The preview renders what is stored, so it follows draftRevision -- it
  // refreshes exactly when autosave commits, never on an unsaved keystroke.
  const draftRevision = draft?.draftRevision;
  useEffect(() => {
    if (tab !== 'preview' || draftRevision === undefined) return;
    let cancelled = false;
    setPreviewError(null);
    void ports.preview.render({ mergeData: TEMPLATE_PREVIEW_SAMPLE })
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((cause) => { if (!cancelled) setPreviewError(cause instanceof ApiError ? cause.message : 'Không thể tạo bản xem trước.'); });
    return () => { cancelled = true; };
  }, [ports, tab, draftRevision]);

  // Every edit path -- typing, variable insertion, conflict resolution -- funnels
  // through here, so one guard is enough to keep a read-only session from ever
  // producing a pending patch for autosave to flush.
  const change = (patch: TemplatePatch) => { if (readOnly) return; dispatch({ type: 'change', patch }); };
  const clearFieldError = (field: string) => setFieldErrors((current) => {
    const next = { ...current };
    delete next[field];
    return next;
  });

  const publish = async () => {
    if (!state) return;
    const next = Object.fromEntries([
      ['name', requiredText(state.draft.name, 'Nhập tên template để lưu bản nháp.')],
      ['subject', requiredText(subject, 'Nhập tiêu đề email trước khi xuất bản.')],
      ['html', requiredText(html, 'Nhập nội dung HTML trước khi xuất bản.')],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])));
    setFieldErrors(next);
    if (Object.keys(next).length > 0) { setActionError(firstValidationError(next)); return; }
    // Publishing snapshots what the server stored, so an edit still waiting on
    // autosave would be silently left out of the version.
    if (savePending) { setActionError('Thay đổi đang được lưu tự động. Thử lại sau giây lát.'); return; }
    setBusy(true); setActionError(null);
    try {
      const checked = await ports.lint.check({ subject, html, textBody });
      setAnalysis(checked); setAnalysisStale(false);
      if (checked.unknownVariables.length > 0) {
        setActionError(`Chưa thể xuất bản. Hãy tạo biến riêng cho: ${[...new Set(checked.unknownVariables.map((item) => `{{${item.key}}}`))].join(', ')}.`);
        return;
      }
      const version = await ports.content.publish();
      // Publish bumps draftRevision too, so the loaded draft has to be
      // refreshed or the next autosave would collide with the publish itself.
      await load();
      setToast(`Đã xuất bản phiên bản ${version.version}.`);
      window.setTimeout(() => setToast(null), 3000);
    }
    catch (cause) { setActionError(templatePublishError(cause)); }
    finally { setBusy(false); }
  };
  const openHistory = () => {
    setHistoryOpen(true);
    setVersions(null); setVersionsError(null);
    void listTemplateVersions(id)
      .then((page) => setVersions(page.items))
      .catch((cause) => setVersionsError(cause instanceof ApiError ? cause.message : 'Không thể tải lịch sử phiên bản.'));
  };

  /**
   * MC-UI-009 create_draft (S4 Task 21 fidelity gate touch point): "khôi phục"
   * copies a published version's content into a new draft, it never rewrites
   * the immutable version itself (spec §2.10). `compare` (a side-by-side diff
   * between two versions) and `preview` (a rendered view of one past version)
   * are not implemented -- the modal above lists version metadata and this
   * restore action only.
   *
   * Restore rewrites the draft on the server, which bumps draftRevision there.
   * Reloading afterwards is not cosmetic: without it the next autosave would
   * carry the revision we held before the restore and come back 412 against our
   * own action -- the same trap publish sprang.
   */
  const restore = async (version: TemplateVersionSummary) => {
    if (!state) return;
    setBusy(true); setActionError(null);
    try {
      const restored = await restoreTemplateVersion(id, version.id, state.draft.draftRevision);
      dispatch({ type: 'saved', draft: restored });
      setConfirmRestore(null); setHistoryOpen(false);
      setToast(`Đã khôi phục nội dung phiên bản ${version.version} vào bản nháp.`);
    } catch (cause) {
      setActionError(cause instanceof ApiError && cause.status === 412
        ? 'Bản nháp vừa thay đổi ở nơi khác. Tải lại trang rồi thử khôi phục lại.'
        : cause instanceof ApiError ? cause.message : 'Không thể khôi phục phiên bản.');
      setConfirmRestore(null);
    } finally { setBusy(false); }
  };

  const archive = async () => {
    setBusy(true); setActionError(null);
    try { await archiveTemplate(id); navigate('/templates'); }
    catch (cause) { setActionError(cause instanceof ApiError ? cause.message : 'Không thể lưu trữ template.'); setConfirmArchive(false); }
    finally { setBusy(false); }
  };
  const removeVariable = async (variable: ConfiguredVariable) => {
    setActionError(null);
    try { await deleteTemplateVariable(variable.id); await loadVariables(); }
    catch (cause) { setActionError(cause instanceof ApiError ? cause.message : 'Không thể xóa biến template.'); }
  };
  const insertVariable = (variable: TemplateVariableCatalogueItem) => {
    if (!state) return;
    if (activeField === 'html') {
      const inserted = insertTemplateVariable(html, htmlCaret.current, htmlCaret.current, variable.key);
      htmlCaret.current = inserted.caret;
      change({ html: inserted.value });
      setTab('code');
      return;
    }
    // The text body only exists while its own tab is open, so inserting into it
    // from anywhere else has to bring that tab forward -- otherwise the token
    // lands in state and the user never sees where it went.
    if (activeField === 'textBody') setTab('text');
    const target = activeField === 'subject' ? subjectRef.current : textRef.current;
    const inserted = insertTemplateVariable(activeField === 'subject' ? subject : textBody, target?.selectionStart ?? null, target?.selectionEnd ?? null, variable.key);
    change(activeField === 'subject' ? { subject: inserted.value } : { textBody: inserted.value });
    window.requestAnimationFrame(() => {
      const nextTarget = activeField === 'subject' ? subjectRef.current : textRef.current;
      nextTarget?.focus();
      nextTarget?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  const codeRanges = useMemo<AnalysisRange[]>(() => (analysis?.unknownVariables ?? [])
    .filter((variable) => variable.field === 'html')
    .map((variable) => ({ start: variable.start, end: variable.end, key: variable.key })), [analysis]);
  const query = variableQuery.trim().toLocaleLowerCase('vi');
  const catalogueGroups = groupTemplateCatalogue((catalogue ?? []).filter((item) => `${item.label} ${item.key}`.toLocaleLowerCase('vi').includes(query)));
  const groupLabel: Record<TemplateVariableCatalogueItem['source'], string> = { system: 'Mặc định hệ thống', global: 'Dùng chung hiện có', recipient: 'Dữ liệu người nhận', template: 'Riêng template này' };
  const saveStatusText = readOnly ? 'Chế độ chỉ đọc · không lưu thay đổi'
    : state?.status === 'saving' ? 'Tự động lưu · đang lưu'
    : state?.status === 'conflict' ? 'Cần xử lý xung đột'
    : state?.status === 'error' ? 'Tự động lưu · lỗi'
    : savePending ? 'Tự động lưu · đang chờ'
    : 'Tự động lưu · vừa xong';
  const textIsEmpty = textBodyIsEmpty(textBody);

  // A 403 means this session may no longer read the template at all (a role
  // changed server-side while the cached GET /auth/me that let the route guard
  // pass is still in hand). Retrying that is futile, so it gets the permission
  // wording and no retry button; every other failure keeps the card it had.
  if (loadError && !state && templateLoadFailure(loadErrorStatus) === 'permissionDenied') return <EditorFrame description="Không mở được template vì quyền truy cập.">
    <div className="module-card permission-denied-card" role="alert">
      <i aria-hidden="true"><UiIcon name="lock" size={22} /></i>
      <span className="status danger">Không đủ quyền truy cập</span>
      <h2>Bạn không có quyền xem template này</h2>
      <p>Vai trò hiện tại của bạn không cho phép xem nội dung template. Quyền có thể vừa được thay đổi — hãy đăng nhập lại, hoặc liên hệ quản trị viên nếu bạn cần được cấp quyền.</p>
      <button type="button" className="secondary-button" onClick={() => navigate('/templates')}>Quay lại thư viện</button>
    </div>
  </EditorFrame>;
  if (loadError && !state) return <EditorFrame description="Không mở được bản nháp template.">
    <div className="module-card permission-denied-card" role="alert">
      <i aria-hidden="true"><UiIcon name="warning" size={22} /></i>
      <span className="status danger">Không thể tải dữ liệu</span>
      <h2>Không thể mở template</h2>
      <p>{loadError}</p>
      <button type="button" className="secondary-button" onClick={() => void load()}><UiIcon name="refresh" size={16} /> Thử lại</button>
      <button type="button" className="secondary-button" onClick={() => navigate('/templates')}>Quay lại thư viện</button>
    </div>
  </EditorFrame>;
  if (!state) return <EditorFrame description="Đang mở bản nháp template."><section className="compose-card" role="status">Đang tải template…</section></EditorFrame>;

  return <section className="workspace-module-frame compose-variables-module">
    <header className="workspace-module-topbar">
      {/* The shell already renders "Chỉnh sửa template" as the page <h1>
          (page-meta.ts). Repeating it here printed the same sentence twice
          on screen, so this header names the template being edited instead —
          which is the thing the page title cannot know. */}
      <div><h2>{state.draft.name.trim() || 'Template chưa đặt tên'}</h2><p>{STATUS_LABEL[state.draft.status]} · cập nhật {new Date(state.draft.updatedAt).toLocaleString('vi-VN')}</p></div>
      <div className="page-actions">
        <button className="secondary-button" onClick={() => navigate('/templates')}>Quay lại thư viện</button>
        {/* History stays reachable read-only -- viewing past versions changes
            nothing. Restoring one from inside it is disabled separately. */}
        <button className="secondary-button" onClick={openHistory}>Lịch sử</button>
        <button className="text-button danger-text" disabled={busy || readOnly} onClick={() => (savePending ? setConfirmDiscard(true) : setConfirmArchive(true))}>Lưu trữ</button>
        <button className="primary-button" disabled={busy || savePending || readOnly} onClick={() => void publish()}>{busy ? 'Đang xử lý…' : 'Xuất bản'}</button>
      </div>
    </header>
    <div className="email-workspace-body">
      {/* §5.1: the read-only state has to *explain itself*. Placed above the
          content, not beside a control, so it is the first thing read at every
          viewport -- at 390px the variable panel is far below the fold. */}
      {readOnly && <div className="template-readonly-notice" role="status">
        <span aria-hidden="true"><UiIcon name="lock" size={16} /></span>
        <div>
          <b>Bạn đang xem template ở chế độ chỉ đọc</b>
          <p>Vai trò hiện tại của bạn cho phép xem nội dung template nhưng không cho phép chỉnh sửa, xuất bản hay lưu trữ. Liên hệ quản trị viên nếu bạn cần quyền chỉnh sửa nội dung.</p>
        </div>
      </div>}
      <div className="template-editor-workspace">
        <section className="template-editor-fields">
          <div className="modal-form-grid">
            <label className={`modal-field ${fieldErrors.name || nameBlank ? 'field-invalid' : ''}`}><span>Tên template <i className="required-mark">*</i></span><input value={state.draft.name} maxLength={160} readOnly={readOnly} aria-invalid={Boolean(fieldErrors.name) || nameBlank} onChange={(event) => { clearFieldError('name'); change({ name: event.target.value }); }} /><small className={fieldErrors.name || nameBlank ? 'field-error' : 'field-help'}>{fieldErrors.name ?? (nameBlank ? 'Nhập tên template để tiếp tục lưu tự động.' : 'Tên dùng để nhận biết trong thư viện, không hiển thị với người nhận.')}</small></label>
            <label className={`modal-field ${fieldErrors.subject ? 'field-invalid' : ''}`}><span>Tiêu đề email <i className="required-mark">*</i></span><input ref={subjectRef} value={subject} maxLength={998} readOnly={readOnly} aria-invalid={Boolean(fieldErrors.subject)} onFocus={() => setActiveField('subject')} onChange={(event) => { clearFieldError('subject'); change({ subject: event.target.value }); }} /><small className={fieldErrors.subject ? 'field-error' : 'field-help'}>{fieldErrors.subject ?? (readOnly ? 'Chỉ xem — không thể chỉnh sửa tiêu đề.' : 'Chọn biến bên phải để chèn tại vị trí con trỏ.')}</small></label>
          </div>

          <div className="editor-shell template-editor-surface">
            <div className="editor-head">
              <div className="view-switch">
                <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Trình soạn thảo</button>
                <button className={tab === 'code' ? 'active' : ''} onClick={() => { setTab('code'); setActiveField('html'); }}>&lt;/&gt; HTML</button>
                <button className={tab === 'text' ? 'active' : ''} onClick={() => { setTab('text'); setActiveField('textBody'); }}>Văn bản thuần{textIsEmpty && <i className="tab-empty-dot" role="img" aria-label="đang trống, sẽ được tạo tự động khi xuất bản">●</i>}</button>
              </div>
              <span>{saveStatusText}</span>
            </div>
            {tab === 'preview'
              && <div className="compose-preview">
                  <div className="compose-preview-toolbar">
                    <div className="preview-sample-recipient"><span>Người nhận mẫu</span><b>{TEMPLATE_PREVIEW_SAMPLE.email}</b></div>
                    <div className="device-switch">
                      <button className={device === 'desktop' ? 'active' : ''} onClick={() => setDevice('desktop')}>▱ Desktop</button>
                      <button className={device === 'mobile' ? 'active' : ''} onClick={() => setDevice('mobile')}>▯ Mobile</button>
                    </div>
                  </div>
                  {savePending && <p className="field-help" role="status">Bản xem trước đang hiển thị nội dung đã lưu gần nhất; thay đổi mới sẽ xuất hiện sau khi tự động lưu xong.</p>}
                  {previewError && <p className="login-error" role="alert">{previewError}</p>}
                  {!previewError && !preview && <div className="template-preview-loading" role="status">Đang tạo bản xem trước…</div>}
                  {preview && <>
                    {/* BR-TPL-005: the server decides what is missing. Hiding
                        missingKeys would turn a preview that cannot be rendered
                        for a real recipient into one that looks complete. */}
                    {preview.missingKeys.length > 0
                      ? <div className="validation-list" role="status"><p><i>!</i>Thiếu dữ liệu mẫu cho: {preview.missingKeys.join(', ')}. Người nhận thật sẽ nhận giá trị của chính họ.</p></div>
                      : <p className="template-preview-ready" role="status">✓ Dữ liệu mẫu đã được thay đầy đủ.</p>}
                    <div className={`mail-preview-stage ${device}`}>
                      {/* srcDoc into a fully sandboxed frame: `sandbox=""` grants
                          nothing back (no scripts, no same-origin, no forms, no
                          top-level navigation), and the HTML itself was already
                          sanitized on save and again by the strict-mode renderer.
                          Nothing here can reach the app's origin or its session. */}
                      <iframe
                        className="template-preview-frame"
                        title="Bản xem trước email"
                        sandbox=""
                        srcDoc={preview.html}
                      />
                    </div>
                  </>}
                </div>}
            {tab === 'code'
              && <TemplateCodeView
                  value={html}
                  ranges={codeRanges}
                  disabled={readOnly}
                  onChange={(value) => { setActiveField('html'); change({ html: value }); }}
                  onCaretChange={(offset) => { htmlCaret.current = offset; }}
                />}
            {tab === 'text'
              && <label className="modal-field template-text-panel">
                  <span>Nội dung văn bản thuần</span>
                  <textarea ref={textRef} value={textBody} readOnly={readOnly} onFocus={() => setActiveField('textBody')} onChange={(event) => change({ textBody: event.target.value })} />
                  <small className="field-help">{readOnly ? 'Chỉ xem — không thể chỉnh sửa nội dung văn bản thuần.' : 'Dùng cho hộp thư không hiển thị HTML. Để trống thì khi xuất bản hệ thống sẽ tự tạo từ HTML.'}</small>
                </label>}
          </div>

          <div className="template-editor-trailing">
          {analysisStale && analysis && <p className="field-help" role="status">Không kiểm tra được nội dung mới nhất. Cảnh báo bên dưới là từ lần kiểm gần nhất.</p>}
          {analysis && <div className="template-editor-diagnostics" role="status"><b>{analysis.unknownVariables.length === 0 ? '✓ Tất cả biến đã được nhận diện' : `${analysis.unknownVariables.length} vị trí biến cần xử lý`}</b>{analysis.unknownVariables.map((variable) => <button key={`${variable.field}-${variable.start}`} disabled={readOnly} onClick={() => setVariableOverlay({ initialKey: variable.key })}><code>{`{{${variable.key}}}`}</code><span>{readOnly ? 'Chưa có biến tương ứng' : 'Tạo biến riêng cho template'}</span></button>)}</div>}
          {analysis && analysis.lint.length > 0 && <div className="validation-list" role="status">{analysis.lint.map((issue) => <p key={`${issue.code}-${issue.field}`}><i>!</i>{LINT_MESSAGE[issue.code](issue.count)}</p>)}</div>}

          {state.status === 'conflict' && <div className="compose-conflict" role="alert">
            <div><b>Template đã thay đổi ở nơi khác</b><p>Nội dung cục bộ được giữ nguyên. Chọn phiên bản máy chủ hoặc áp lại các trường bạn vừa sửa lên phiên bản mới nhất.</p></div>
            {conflictServer && <div className="compose-conflict-diff">
              {Object.entries(state.pending ?? {}).map(([field, localValue]) => <div key={field}><span>{FIELD_LABEL[field] ?? field}</span><small>Máy chủ: {conflictExcerpt(conflictServer[field as keyof EmailTemplate])}</small><b>Cục bộ: {conflictExcerpt(localValue)}</b></div>)}
            </div>}
            {conflictLoadError && <p className="login-error">{conflictLoadError}</p>}
            <div className="compose-conflict-actions">
              <button className="secondary-button" disabled={!conflictServer} onClick={() => { if (conflictServer) dispatch({ type: 'resolveConflict', serverDraft: conflictServer, keepLocal: false }); setConflictServer(null); }}>Dùng bản trên máy chủ</button>
              <button className="primary-button" disabled={!conflictServer} onClick={() => { if (conflictServer) dispatch({ type: 'resolveConflict', serverDraft: conflictServer, keepLocal: true }); setConflictServer(null); }}>Giữ thay đổi của tôi</button>
              {!conflictServer && <button className="secondary-button" onClick={() => void ports.content.load().then(setConflictServer).catch((cause) => setConflictLoadError(cause instanceof ApiError ? cause.message : 'Không thể tải phiên bản mới nhất.'))}>Tải lại so sánh</button>}
            </div>
          </div>}
          {actionError && <p className="login-error" role="alert">{actionError}</p>}
          </div>
        </section>

        <aside className="template-variable-panel" aria-label="Danh mục biến template">
          <header><div><b>{readOnly ? 'Biến dùng trong nội dung' : 'Chèn biến vào nội dung'}</b><small>{readOnly ? 'Chỉ xem — không thể chèn hoặc sửa biến.' : `Đang chèn vào: ${activeField === 'subject' ? 'Tiêu đề' : activeField === 'html' ? 'HTML' : 'Văn bản thuần'}`}</small></div><button className="secondary-button" disabled={readOnly} onClick={() => setVariableOverlay('create')}><UiIcon name="plus" size={15} /> Tạo biến riêng</button></header>
          <div className="panel-search"><UiIcon name="search" size={16} /><input aria-label="Tìm biến template" value={variableQuery} onChange={(event) => setVariableQuery(event.target.value)} placeholder="Tìm theo tên hoặc mã biến" /></div>
          <div className="template-variable-catalogue">{catalogueGroups.map((group) => group.items.length > 0 && <section key={group.source}><span>{groupLabel[group.source]}</span>{group.items.map((variable) => {
            const owned = configured?.find((item) => item.key === variable.key);
            // Read-only keeps the catalogue legible -- the variables a template
            // uses are content -- but drops the insert affordance and the
            // edit/delete menu, both of which only lead to a 403.
            return <div className="template-variable-item" key={`${variable.source}-${variable.key}`}><button className="template-variable-insert" disabled={readOnly} onClick={() => insertVariable(variable)}><span><b>{variable.label}{variable.required && <i className="required-mark"> *</i>}</b><code>{`{{${variable.key}}}`}</code>{/* ADR-036: the token cannot show how a date reads, so the catalogue does. */}{variable.example && <small className="template-variable-example">Hiển thị: {variable.example}</small>}</span>{!readOnly && <UiIcon name="plus" size={15} />}</button>{owned && !readOnly && <EntityActionMenu label={`Tùy chọn biến ${variable.label}`} items={[{ label: 'Cập nhật biến', icon: 'edit', onSelect: () => setVariableOverlay(owned) }, { label: 'Xóa biến', icon: 'trash', tone: 'danger', onSelect: () => void removeVariable(owned) }]} />}</div>;
          })}</section>)}</div>
        </aside>
      </div>
    </div>
    {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    {variableOverlay && <ManageConfiguredVariableOverlay scope="template" templateId={id} existing={typeof variableOverlay === 'object' && 'id' in variableOverlay ? variableOverlay : null} initialKey={typeof variableOverlay === 'object' && 'initialKey' in variableOverlay ? variableOverlay.initialKey : ''} onClose={() => setVariableOverlay(null)} onSaved={() => { setVariableOverlay(null); void loadVariables(); }} />}
    {/* Closing no longer asks anything -- autosave means nothing is unsaved.
        Archiving still does: it ends the draft, and an edit that has not been
        flushed yet would go with it. */}
    {confirmDiscard && <ModalFrame titleId="discard-template-changes-title" title="Bỏ thay đổi chưa lưu?" description="Một vài thay đổi vừa nhập chưa kịp lưu tự động và sẽ mất khi lưu trữ template." size="small" onClose={() => setConfirmDiscard(false)} footer={<>
      <button className="secondary-button" onClick={() => setConfirmDiscard(false)}>Tiếp tục chỉnh sửa</button>
      <button className="danger-button" onClick={() => { setConfirmDiscard(false); setConfirmArchive(true); }}>Bỏ thay đổi</button>
    </>}>
      <div className="confirmation-copy"><b>{state.draft.name}</b><p>Bạn có thay đổi chưa được lưu tự động trong template này.</p></div>
    </ModalFrame>}
    {confirmArchive && <ModalFrame titleId="archive-template-title" title="Lưu trữ template" description="Template sẽ không còn xuất hiện trong thư viện hoạt động; các phiên bản đã dùng vẫn được giữ." size="small" onClose={() => setConfirmArchive(false)} footer={<>
      <button className="secondary-button" disabled={busy} onClick={() => setConfirmArchive(false)}>Hủy</button>
      <button className="danger-button" disabled={busy} onClick={() => void archive()}>{busy ? 'Đang lưu trữ…' : 'Lưu trữ template'}</button>
    </>}>
      <div className="confirmation-copy"><b>{state.draft.name}</b><p>Hãy xác nhận bạn muốn lưu trữ template này.</p></div>
    </ModalFrame>}
    {/* The immutability sentence now lives in the ported `v3-immutable` banner
        inside `TemplateVersionHistory` (S8, MC-UI-009 history chrome) -- this stays
        short so the modal does not say the same thing twice. */}
    {historyOpen && <ModalFrame titleId="template-history-title" title="Lịch sử phiên bản" description="Xem và khôi phục các phiên bản đã xuất bản." size="medium" onClose={() => setHistoryOpen(false)} footer={
      <button className="secondary-button" onClick={() => setHistoryOpen(false)}>Đóng</button>
    }>
      {/* ADR-044 Task SV-2: the list itself now lives in `TemplateVersionHistory`, shared with the builder's "Lịch sử" rail destination. The modal, the loading call and `restore` stay here -- restore writes through this screen's own draft revision. */}
      <TemplateVersionHistory versions={versions} error={versionsError} busy={busy} readOnly={readOnly} onRestore={setConfirmRestore} />
    </ModalFrame>}
    {confirmRestore && <ModalFrame titleId="restore-version-title" title={`Khôi phục phiên bản ${confirmRestore.version}?`} description="Phiên bản đã xuất bản không thay đổi — chỉ bản nháp được ghi đè." size="small" onClose={() => setConfirmRestore(null)} footer={<>
      <button className="secondary-button" disabled={busy} onClick={() => setConfirmRestore(null)}>Hủy</button>
      <button className="danger-button" data-mc-action="MC-UI-009.create_draft" disabled={busy} onClick={() => void restore(confirmRestore)}>{busy ? 'Đang khôi phục…' : 'Ghi đè bản nháp'}</button>
    </>}>
      <div className="confirmation-copy">
        <b>{state.draft.name}</b>
        <p>Tiêu đề, nội dung HTML và văn bản thuần trong bản nháp hiện tại sẽ bị thay bằng nội dung của phiên bản {confirmRestore.version}. Phần đang sửa dở sẽ mất.</p>
      </div>
    </ModalFrame>}
  </section>;
}
