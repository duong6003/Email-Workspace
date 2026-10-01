import { useEffect, useState } from 'react';
import { createBulkJob, previewBulkJob, type BulkJobPreview } from '../api/bulk-jobs.js';
import { ApiError } from '../api/problem.js';
import { listCustomFields, type CustomField } from '../api/customFields.js';
import { resolveBulkScope, type BulkScope } from '../screens/recipients/bulk-scope.js';
import type { RecipientFilterState } from './RecipientFilterOverlay.js';
import type { RecipientList, Tag } from '../api/segments.js';

type Props = {
  recipientIds: string[];
  filters: RecipientFilterState;
  lists: RecipientList[];
  tags: Tag[];
  onClose: () => void;
  onCreated: (count: number) => void;
  onToast: (message: string) => void;
};

/** M2-S4: creates a durable, frozen-selection bulk job; the worker validates and applies each row. */
export function BulkCustomDataOverlay({ recipientIds, filters, lists, tags, onClose, onCreated, onToast }: Props) {
  const [fields, setFields] = useState<CustomField[]>([]);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BulkJobPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [resolvedScope, setResolvedScope] = useState<{ label: string; recipientIds: string[] } | null>(null);
  const [scopeKind, setScopeKind] = useState<BulkScope['kind']>('selected_recipients');
  const [scopeTarget, setScopeTarget] = useState('');

  const scope: BulkScope = scopeKind === 'selected_recipients'
    ? { kind: scopeKind, recipientIds }
    : scopeKind === 'list'
      ? { kind: scopeKind, listId: scopeTarget }
      : scopeKind === 'tag'
        ? { kind: scopeKind, tagId: scopeTarget }
        : { kind: scopeKind, filters };

  useEffect(() => {
    void listCustomFields().then((result) => setFields(result.items)).catch(() => setError('Không thể tải danh sách trường tùy chỉnh.'));
  }, []);

  useEffect(() => {
    if (!key || ((scope.kind === 'list' || scope.kind === 'tag') && !scopeTarget)) { setPreview(null); setResolvedScope(null); return; }
    let cancelled = false;
    setPreviewing(true);
    void resolveBulkScope(scope)
      .then((resolved) => previewBulkJob({ action: 'set_custom_data', actionPayload: { key, value }, recipientIds: resolved.recipientIds }).then((result) => ({ resolved, result })))
      .then(({ resolved, result }) => { if (!cancelled) { setResolvedScope(resolved); setPreview(result); setError(null); } })
      .catch((cause) => { if (!cancelled) { setPreview(null); setError(cause instanceof ApiError ? cause.message : 'Không thể kiểm tra phạm vi cập nhật.'); } })
      .finally(() => { if (!cancelled) setPreviewing(false); });
    return () => { cancelled = true; };
  }, [key, value, scope.kind, scopeTarget, recipientIds, filters]);

  const submit = async () => {
    if (!key) { setError('Hãy chọn trường cần cập nhật.'); return; }
    setBusy(true);
    setError(null);
    try {
      if (!preview) { setError('Chờ kiểm tra phạm vi trước khi xác nhận.'); return; }
      if (!resolvedScope) { setError('Chờ kiểm tra phạm vi trước khi xác nhận.'); return; }
      const job = await createBulkJob({ action: 'set_custom_data', actionPayload: { key, value }, recipientIds: resolvedScope.recipientIds });
      onToast(job.idempotencyReplayed ? 'Job cập nhật đã tồn tại; đang hiển thị trạng thái mới nhất.' : `Đã tạo job cập nhật cho ${job.resolvedCount.toLocaleString('vi-VN')} người nhận.`);
      onCreated(job.resolvedCount);
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Không thể tạo job cập nhật.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay-backdrop" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="bulk-custom-data-title" className="action-overlay" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2 id="bulk-custom-data-title">Cập nhật dữ liệu hàng loạt</h2><p>Phạm vi được dry-run và đóng băng trước khi tạo job.</p></div><button aria-label="Đóng cửa sổ" onClick={onClose}>×</button></header>
        <div className="overlay-content">
          <p>Danh sách được đóng băng khi tạo job; từng thay đổi được xử lý bất đồng bộ và có thể theo dõi trạng thái.</p>
          <label className="modal-field"><span>Phạm vi cập nhật</span><select value={scopeKind} onChange={(event) => { setScopeKind(event.target.value as BulkScope['kind']); setScopeTarget(''); }}><option value="selected_recipients">Người nhận đã chọn ({recipientIds.length.toLocaleString('vi-VN')})</option>{lists.length > 0 && <option value="list">Theo danh sách</option>}{tags.length > 0 && <option value="tag">Theo tag</option>}{(filters.status.length + filters.listIds.length + filters.tagIds.length) > 0 && <option value="current_filter">Bộ lọc hiện tại</option>}</select></label>
          {scopeKind === 'list' && <label className="modal-field"><span>Danh sách</span><select value={scopeTarget} onChange={(event) => setScopeTarget(event.target.value)}><option value="">Chọn danh sách</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>}
          {scopeKind === 'tag' && <label className="modal-field"><span>Tag</span><select value={scopeTarget} onChange={(event) => setScopeTarget(event.target.value)}><option value="">Chọn tag</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label>}
          <label className="modal-field"><span>Trường tùy chỉnh</span><select value={key} onChange={(event) => setKey(event.target.value)}><option value="">Chọn trường</option>{fields.map((field) => <option key={field.id} value={field.key}>{field.label} ({field.key})</option>)}</select></label>
          <label className="modal-field"><span>Giá trị mới</span><input value={value} onChange={(event) => setValue(event.target.value)} /></label>
          {previewing && <p role="status">Đang kiểm tra phạm vi cập nhật…</p>}
          {preview && <p role="status">Phạm vi: {resolvedScope?.label ?? preview.scope}; ước tính {preview.estimatedCount.toLocaleString('vi-VN')} người nhận. Trường <b>{key}</b> sẽ nhận giá trị <b>{value || '(trống)'}</b>. Giá trị đã được server xác thực.</p>}
          {preview && <p className="cell-subtitle">Cảnh báo: dữ liệu mới không thay đổi campaign đã snapshot. Với campaign đã lên lịch, hãy hủy rồi refresh audience trong luồng campaign trước khi gửi.</p>}
          {fields.length === 0 && !error && <p>Chưa có trường tùy chỉnh để cập nhật.</p>}
          {error && <p className="login-error" role="alert">{error}</p>}
        </div>
        <footer><button className="secondary-button" onClick={onClose}>Hủy</button><button className="primary-button" disabled={busy || previewing || !preview || fields.length === 0} onClick={() => void submit()}>{busy ? 'Đang tạo job…' : 'Tạo job cập nhật'}</button></footer>
      </section>
    </div>
  );
}
