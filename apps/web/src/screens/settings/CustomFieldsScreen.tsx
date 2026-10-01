import { useCallback, useEffect, useState } from 'react';
import { deleteCustomField, listCustomFields, type CustomField } from '../../api/customFields.js';
import { ApiError } from '../../api/problem.js';
import { UiIcon } from '../../app/ui-icons.js';
import { EntityActionMenu } from '../../components/EntityActionMenu.js';
import { ManageCustomFieldOverlay } from '../../overlays/ManageCustomFieldOverlay.js';
import { SettingsTabs } from '../../components/SettingsTabs.js';
import { variablePresentationSummary } from '../../api/variable-formatting.js';
import { VARIABLE_TYPE_LABEL } from '../../components/VariableFormattingFields.js';

function CustomFieldsLoadError({ onRetry }: { onRetry: () => void }) {
  return <div className="module-card permission-denied-card">
    <i aria-hidden="true"><UiIcon name="warning" size={22} /></i>
    <span className="status danger" role="status">Không thể tải dữ liệu</span>
    <h2>Không thể tải dữ liệu người nhận</h2>
    <p>Đã xảy ra lỗi khi tải danh sách trường. Vui lòng thử lại.</p>
    <button type="button" className="secondary-button" onClick={onRetry}><UiIcon name="refresh" size={16} /> Thử lại</button>
  </div>;
}

export function CustomFieldsScreen() {
  const [items, setItems] = useState<CustomField[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [overlay, setOverlay] = useState<'create' | { kind: 'edit'; field: CustomField } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setItems((await listCustomFields()).items); }
    catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async (field: CustomField) => {
    try {
      await deleteCustomField(field.id);
      showToast(`Đã xóa trường "${field.label}"`);
      void load();
    } catch (cause) {
      showToast(cause instanceof ApiError ? cause.message : 'Không thể xóa trường người nhận.');
    }
  };

  return <section className="workspace-module-frame standard-module-frame custom-fields-module">
    <header className="settings-topbar workspace-module-topbar">
      <SettingsTabs active="custom-fields" />
      <button className="primary-button" onClick={() => setOverlay('create')}><UiIcon name="plus" size={16} /> Tạo trường người nhận</button>
    </header>
    <div className="module-frame-body">
      <div className="info-banner">Biến riêng cho nội dung được tạo trực tiếp khi chỉnh sửa từng template để không ảnh hưởng template khác.</div>
      {loading && items === null && <div className="module-card" role="status" style={{ padding: 24 }}>Đang tải dữ liệu người nhận…</div>}
      {Boolean(error) && <CustomFieldsLoadError onRetry={() => void load()} />}
      {!error && items !== null && items.length === 0 && <div className="module-card" style={{ padding: 24 }}><h2 style={{ marginTop: 0 }}>Chưa có trường dữ liệu riêng</h2><p>Tạo trường đầu tiên để import dữ liệu người nhận và chèn biến tương ứng trong template.</p></div>}
      {!error && items !== null && items.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>MÃ BIẾN</th><th>TÊN HIỂN THỊ</th><th>KIỂU DỮ LIỆU</th><th>HIỂN THỊ KHI GỬI</th><th>YÊU CẦU GIÁ TRỊ</th><th>NHẠY CẢM</th><th><span className="visually-hidden">Hành động</span></th></tr></thead>
        <tbody>{items.map((field) => <tr key={field.id}>
          <td><code>{`{{${field.key}}}`}</code></td><td><b>{field.label}</b></td><td>{VARIABLE_TYPE_LABEL[field.type]}</td>
          {/* ADR-036: a date renders as a local calendar date, so the pattern and zone that decide it belong in the list. */}
          <td>{variablePresentationSummary({ dataType: field.type, format: field.format, timezone: field.timezone }) ?? '—'}</td>
          <td><span className={`status ${field.required ? 'success' : 'warning'}`}>{field.required ? 'Cần có dữ liệu' : 'Có thể để trống'}</span></td>
          <td><span className={`status ${field.sensitive ? 'warning' : 'success'}`}>{field.sensitive ? 'Có' : 'Không'}</span></td>
          <td><EntityActionMenu label={`Tùy chọn ${field.label}`} items={[
            { label: 'Chỉnh sửa trường', icon: 'edit', onSelect: () => setOverlay({ kind: 'edit', field }) },
            { label: 'Xóa trường', icon: 'trash', tone: 'danger', onSelect: () => void handleDelete(field) },
          ]} /></td>
        </tr>)}</tbody>
      </table></div>}
    </div>
    {overlay === 'create' && <ManageCustomFieldOverlay existing={null} onClose={() => setOverlay(null)} onSaved={() => { setOverlay(null); showToast('Đã tạo trường người nhận'); void load(); }} />}
    {overlay && typeof overlay === 'object' && <ManageCustomFieldOverlay existing={overlay.field} onClose={() => setOverlay(null)} onSaved={() => { setOverlay(null); showToast('Đã lưu thay đổi'); void load(); }} />}
    {toast && <div className="toast" role="status" aria-live="polite"><span>✓</span>{toast}</div>}
  </section>;
}

export default CustomFieldsScreen;
