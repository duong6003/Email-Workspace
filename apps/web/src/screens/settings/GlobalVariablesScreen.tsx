import { useCallback, useEffect, useState } from 'react';
import { deleteGlobalVariable, listGlobalVariables, type ConfiguredVariable } from '../../api/configuredVariables.js';
import { ApiError } from '../../api/problem.js';
import { UiIcon } from '../../app/ui-icons.js';
import { EntityActionMenu } from '../../components/EntityActionMenu.js';
import { ManageConfiguredVariableOverlay } from '../../overlays/ManageConfiguredVariableOverlay.js';
import { SettingsTabs } from '../../components/SettingsTabs.js';
import { variablePresentationSummary } from '../../api/variable-formatting.js';
import { VARIABLE_TYPE_LABEL } from '../../components/VariableFormattingFields.js';

/** ADR-033: tenant-wide values keep their own surface, separate from recipient schema and template authoring. */
export function GlobalVariablesScreen() {
  const [items, setItems] = useState<ConfiguredVariable[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [overlay, setOverlay] = useState<'create' | { kind: 'edit'; variable: ConfiguredVariable } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setItems((await listGlobalVariables()).items); }
    catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async (variable: ConfiguredVariable) => {
    try {
      await deleteGlobalVariable(variable.id);
      showToast(`Đã xóa biến "${variable.label}"`);
      void load();
    } catch (cause) {
      showToast(cause instanceof ApiError ? cause.message : 'Không thể xóa biến dùng chung.');
    }
  };

  return <section className="workspace-module-frame standard-module-frame custom-fields-module">
    <header className="settings-topbar workspace-module-topbar">
      <SettingsTabs active="global-variables" />
      <button className="primary-button" onClick={() => setOverlay('create')}><UiIcon name="plus" size={16} /> Tạo biến dùng chung</button>
    </header>
    <div className="module-frame-body">
      <div className="info-banner">Biến riêng của từng template được tạo trong màn hình chỉnh sửa template; biến ở đây dùng chung cho cả hệ thống.</div>
      {loading && items === null && <div className="module-card" role="status" style={{ padding: 24 }}>Đang tải biến dùng chung…</div>}
      {Boolean(error) && <div className="module-card permission-denied-card">
        <i aria-hidden="true"><UiIcon name="warning" size={22} /></i>
        <span className="status danger" role="status">Không thể tải dữ liệu</span>
        <h2>Không thể tải biến dùng chung</h2>
        <p>Đã xảy ra lỗi khi tải danh sách. Vui lòng thử lại.</p>
        <button type="button" className="secondary-button" onClick={() => void load()}><UiIcon name="refresh" size={16} /> Thử lại</button>
      </div>}
      {!error && items !== null && items.length === 0 && <div className="module-card" style={{ padding: 24 }}><h2 style={{ marginTop: 0 }}>Chưa có biến dùng chung</h2><p>Tạo biến đầu tiên để dùng lại một giá trị cố định trong nhiều template.</p></div>}
      {!error && items !== null && items.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>MÃ BIẾN</th><th>TÊN HIỂN THỊ</th><th>KIỂU DỮ LIỆU</th><th>HIỂN THỊ KHI GỬI</th><th>GIÁ TRỊ DÙNG CHUNG</th><th>ĐỔI KHI GỬI</th><th><span className="visually-hidden">Hành động</span></th></tr></thead>
        <tbody>{items.map((variable) => <tr key={variable.id}>
          <td><code>{`{{${variable.key}}}`}</code></td><td><b>{variable.label}</b></td>
          <td>{VARIABLE_TYPE_LABEL[variable.dataType]}</td>
          <td>{variablePresentationSummary(variable) ?? '—'}</td>
          <td>{variable.defaultValue == null ? '—' : String(variable.defaultValue)}</td>
          <td><span className={`status ${variable.allowCampaignOverride ? 'warning' : 'success'}`}>{variable.allowCampaignOverride ? 'Cho phép' : 'Giữ cố định'}</span></td>
          <td><EntityActionMenu label={`Tùy chọn ${variable.label}`} items={[
            { label: 'Cập nhật biến', icon: 'edit', onSelect: () => setOverlay({ kind: 'edit', variable }) },
            { label: 'Xóa biến', icon: 'trash', tone: 'danger', onSelect: () => void handleDelete(variable) },
          ]} /></td>
        </tr>)}</tbody>
      </table></div>}
    </div>
    {overlay === 'create' && <ManageConfiguredVariableOverlay scope="global" existing={null} onClose={() => setOverlay(null)} onSaved={() => { setOverlay(null); showToast('Đã tạo biến dùng chung'); void load(); }} />}
    {overlay && typeof overlay === 'object' && <ManageConfiguredVariableOverlay scope="global" existing={overlay.variable} onClose={() => setOverlay(null)} onSaved={() => { setOverlay(null); showToast('Đã lưu thay đổi'); void load(); }} />}
    {toast && <div className="toast" role="status" aria-live="polite"><span>✓</span>{toast}</div>}
  </section>;
}

export default GlobalVariablesScreen;
