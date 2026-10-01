import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/problem.js';
import { createImportJob, previewImportJob } from '../api/import-jobs.js';
import { parseCsvImport } from '../screens/recipients/csv-import.js';
import { buildImportPreview, buildImportRequest, type ImportDraft, type ImportPreview } from '../screens/recipients/import-preview.js';
import { clearImportCheckpoint, checkpointMatchesFile, fingerprintImportFile, loadImportCheckpoint, saveImportCheckpoint } from '../screens/recipients/import-resume.js';
import { downloadRecipientXlsxSample } from '../screens/recipients/import-samples.js';
import { listCustomFields, type CustomField } from '../api/customFields.js';

type Props = { onClose: () => void; onCreated: () => void; onToast: (message: string) => void };

function updateSingleValueMapping(mapping: Record<string, string>, target: string, source: string): Record<string, string> {
  const next = { ...mapping };
  if (source) {
    for (const [mappedTarget, mappedSource] of Object.entries(next)) {
      if (mappedTarget !== target && mappedSource === source && mappedTarget !== 'list' && mappedTarget !== 'tag') delete next[mappedTarget];
    }
    next[target] = source;
  } else {
    delete next[target];
  }
  return next;
}

function updateMultiValueMapping(mapping: Record<string, string>, target: 'list' | 'tag', source: string): Record<string, string> {
  const next = { ...mapping };
  if (source) next[target] = source;
  else delete next[target];
  return next;
}

/** M2-S4: handoff-aligned import step 1, wired to the durable job API. */
export function ImportRecipientsOverlay({ onClose, onCreated, onToast }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [step, setStep] = useState<'file' | 'mapping' | 'preview'>('file');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);

  const selectFile = (next: File | null) => {
    setFile(next);
    setDraft(null);
    setMapping({});
    setPreview(null);
    setStep('file');
    setError(null);
    setResumeNotice(null);
  };

  useEffect(() => {
    void listCustomFields().then((response) => setCustomFields(response.items)).catch(() => setCustomFields([]));
    const checkpoint = loadImportCheckpoint(window.localStorage);
    if (checkpoint) setResumeNotice(`Có mapping chưa hoàn tất cho ${checkpoint.fileName}. Chọn lại đúng file để tiếp tục.`);
  }, []);

  const submit = async () => {
    if (!file) {
      setError('Chọn một tệp CSV để tiếp tục.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fileFingerprint = draft?.fileFingerprint ?? await fingerprintImportFile(file);
      const parsed: ImportDraft = draft ?? {
        ...(/.xlsx$/i.test(file.name)
          ? await import('../screens/recipients/spreadsheet-import.js').then(({ parseSpreadsheetImport }) => parseSpreadsheetImport(file))
          : await parseCsvImport(file)),
        fileFingerprint,
      };
      if (!draft) {
        setDraft(parsed);
        const email = parsed.columns.find((column) => ['email', 'e-mail', 'email address'].includes(column.trim().toLowerCase()));
        const firstName = parsed.columns.find((column) => ['first_name', 'first name', 'firstname'].includes(column.trim().toLowerCase()));
        const lastName = parsed.columns.find((column) => ['last_name', 'last name', 'lastname'].includes(column.trim().toLowerCase()));
        const checkpoint = loadImportCheckpoint(window.localStorage);
        const resumed = checkpoint && checkpointMatchesFile(checkpoint, file, fileFingerprint) ? checkpoint : null;
        const nextMapping = resumed?.mapping ?? { ...(email ? { email } : {}), ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}) };
        setMapping(nextMapping);
        idempotencyKeyRef.current = resumed?.idempotencyKey ?? crypto.randomUUID();
        setStep(resumed?.step ?? 'mapping');
        saveImportCheckpoint(window.localStorage, {
          fileName: parsed.fileName,
          fileSizeBytes: parsed.fileSizeBytes,
          fileFingerprint,
          mapping: nextMapping,
          step: resumed?.step ?? 'mapping',
          idempotencyKey: idempotencyKeyRef.current,
        });
        setResumeNotice(resumed ? 'Đã khôi phục mapping theo đúng dấu vân tay SHA-256 của file.' : null);
        return;
      }
      const request = buildImportRequest(parsed, mapping);
      if (step === 'mapping') {
        const localPreview = buildImportPreview(request, customFields);
        const serverPreview = await previewImportJob(request);
        setPreview(serverPreview.errors.length ? serverPreview : localPreview);
        setStep('preview');
        saveImportCheckpoint(window.localStorage, {
          fileName: parsed.fileName,
          fileSizeBytes: parsed.fileSizeBytes,
          fileFingerprint,
          mapping,
          step: 'preview',
          idempotencyKey: idempotencyKeyRef.current,
        });
        return;
      }
      const job = await createImportJob(request, idempotencyKeyRef.current);
      clearImportCheckpoint(window.localStorage);
      onToast(job.idempotencyReplayed ? 'Job import đã tồn tại; đang hiển thị trạng thái mới nhất.' : `Đã tạo job import cho ${job.totalRows.toLocaleString('vi-VN')} dòng.`);
      onCreated();
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Không thể tạo job import.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay-backdrop" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="import-overlay-title" className="action-overlay modal-large" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="import-overlay-title">Import người nhận từ Excel</h2>
            <p>Hỗ trợ CSV và XLSX tối đa 50 MB, 100.000 dòng. Dữ liệu được kiểm tra trước khi tạo job.</p>
          </div>
          <button type="button" aria-label="Đóng cửa sổ" onClick={onClose}>×</button>
        </header>
        <div className="overlay-content recipient-import-flow">
          <div className="import-steps"><span className={step === 'file' ? 'active' : ''}><i>1</i>Chọn file</span><em /><span className={step === 'mapping' ? 'active' : ''}><i>2</i>Mapping dữ liệu</span><em /><span className={step === 'preview' ? 'active' : ''}><i>3</i>Kiểm tra &amp; import</span></div>
          <input ref={inputRef} hidden type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => selectFile(event.target.files?.[0] ?? null)} />
          <button type="button" className="upload-zone" onClick={() => inputRef.current?.click()}>
            <span>↑</span><b>{file ? file.name : 'Kéo thả file CSV hoặc XLSX vào đây'}</b>
            <small>{file ? `${Math.ceil(file.size / 1024).toLocaleString('vi-VN')} KB · sẵn sàng kiểm tra` : 'hoặc bấm để chọn file từ máy tính'}</small>
          </button>
          <div className="import-supported-fields">
            <header><div><b>File mẫu chuẩn</b><small>Excel gồm sheet dữ liệu, sheet hướng dẫn và đúng tên cột để tự động mapping.</small></div><div className="download-sample"><button type="button" className="sample-primary-button" onClick={() => void downloadRecipientXlsxSample()}>↓ Tải file Excel mẫu chuẩn</button><a href="/samples/recipients-import-sample.csv" download>Tải CSV</a><a href="/samples/import-guide.txt" download>Hướng dẫn TXT</a></div></header>
            <div><span><b>Email *</b><code>email</code></span><span><b>Họ và tên</b><code>first_name, last_name</code></span><span><b>Phân nhóm</b><code>list, tag</code></span><span><b>Chế độ</b><code>upsert</code></span></div>
            <p className="import-sample-guidance">Giữ nguyên hàng tiêu đề. Mỗi ô chỉ chứa một list hoặc tag đã tồn tại; trường tùy chỉnh phải được tạo trước khi mapping.</p>
          </div>
          {draft && step === 'mapping' && <div className="import-supported-fields"><header><div><b>Mapping dữ liệu</b><small>Chọn cột nguồn cho các trường hệ thống, trường tùy chỉnh, danh sách và tag.</small></div></header><div><label className="modal-field"><span>Email *</span><select value={mapping.email ?? ''} onChange={(event) => setMapping((current) => updateSingleValueMapping(current, 'email', event.target.value))}><option value="">Chọn cột</option>{draft.columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label><label className="modal-field"><span>Tên</span><select value={mapping.firstName ?? ''} onChange={(event) => setMapping((current) => updateSingleValueMapping(current, 'firstName', event.target.value))}><option value="">Không map</option>{draft.columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label><label className="modal-field"><span>Họ</span><select value={mapping.lastName ?? ''} onChange={(event) => setMapping((current) => updateSingleValueMapping(current, 'lastName', event.target.value))}><option value="">Không map</option>{draft.columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label><label className="modal-field"><span>Danh sách</span><select value={mapping.list ?? ''} onChange={(event) => setMapping((current) => updateMultiValueMapping(current, 'list', event.target.value))}><option value="">Không map</option>{draft.columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label><label className="modal-field"><span>Tag</span><select value={mapping.tag ?? ''} onChange={(event) => setMapping((current) => updateMultiValueMapping(current, 'tag', event.target.value))}><option value="">Không map</option>{draft.columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label>{customFields.map((field) => <label className="modal-field" key={field.id}><span>{field.label}</span><select value={mapping[`custom_${field.key}`] ?? ''} onChange={(event) => setMapping((current) => updateSingleValueMapping(current, `custom_${field.key}`, event.target.value))}><option value="">Không map</option>{draft.columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label>)}</div></div>}
          {draft && step === 'preview' && preview && <div className="validation-list"><p><span>✓</span>{draft.rows.length.toLocaleString('vi-VN')} dòng đã đọc; hiển thị {preview.rows.length} dòng preview.</p>{preview.errors.slice(0, 5).map((issue) => <p key={`${issue.rowNumber}-${issue.column}`}><i>!</i>Dòng {issue.rowNumber}, cột {issue.column}: {issue.reason}</p>)}</div>}
          {resumeNotice && <p className="import-resume-notice" role="status">{resumeNotice}</p>}
          {error && <p className="login-error" role="alert">{error}</p>}
        </div>
        <footer><button type="button" className="secondary-button" onClick={step === 'preview' ? () => setStep('mapping') : onClose}>{step === 'preview' ? 'Quay lại mapping' : 'Hủy'}</button><button type="button" className="primary-button" disabled={busy || (step === 'preview' && !!preview?.errors.length)} onClick={() => void submit()}>{busy ? 'Đang tạo job…' : step === 'file' ? 'Tiếp tục mapping' : step === 'mapping' ? 'Xem kiểm tra' : 'Xác nhận import'}</button></footer>
      </section>
    </div>
  );
}
