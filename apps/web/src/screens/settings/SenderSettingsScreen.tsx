import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/problem.js';
import { apiFieldErrors, firstValidationError, type FieldValidationErrors } from '../../api/frontend-validation.js';
import {
  createSenderConfig,
  disableSenderConfig,
  getSendingPolicy,
  listSenderConfigs,
  testSenderConnection,
  updateSenderConfig,
  updateSendingPolicy,
  type SenderConfig,
  type SendingPolicy,
} from '../../api/senderConfigs.js';
import {
  filterSenderConfigs, selectSmtpPort, senderConnectionFailureMessage, senderFormInitial, senderUpdatePayload, smtpPortHint, smtpPortModeFor,
  smtpPortOptionLabel, smtpPortSelectValue, smtpPortSummary, validateSenderForm, SMTP_PORT_CUSTOM, SMTP_PORT_PRESETS,
  type SenderFormState, type SmtpPortMode,
} from './sender-settings.js';
import { timezoneOptions } from '../../api/variable-formatting.js';
import { SettingsTabs } from '../../components/SettingsTabs.js';

const senderSettingsStyles = `
  .sender-settings-screen .default-policy-grid > label,
  .sender-settings-screen .default-policy-grid label > span { min-width: 0; }
  .sender-settings-screen .default-policy-grid label > span { overflow: hidden; }
  .sender-settings-screen .default-policy-grid select,
  .sender-settings-screen .default-policy-grid input:not(.policy-checkbox) {
    box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  }
  .sender-settings-screen .default-policy-grid select { height: 100%; border: 0; background: transparent; padding: 0 9px; white-space: nowrap; }
  .sender-settings-screen .sender-edit-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); }
  .sender-settings-screen .sender-edit-grid label { min-width: 0; min-height: 76px; padding: 12px 13px; border-top: 1px solid var(--line-soft); }
  .sender-settings-screen .sender-edit-grid label:nth-child(-n+2) { border-top: 0; }
  .sender-settings-screen .sender-edit-grid label:nth-child(even) { border-left: 1px solid var(--line-soft); }
  .sender-settings-screen .sender-edit-grid span { display: block; margin-bottom: 6px; color: var(--color-text-subtle); font-size: var(--text-caption); }
  .sender-settings-screen .sender-edit-grid input { width: 100%; height: 36px; padding: 0 10px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface-raised); color: var(--color-text); outline: 0; }
  .sender-settings-screen .sender-edit-grid input:disabled { border-color: transparent; background: transparent; padding-left: 0; color: var(--color-text); opacity: 1; font-weight: 650; cursor: default; }
  .sender-settings-screen .sender-edit-grid input:focus { border-color: color-mix(in srgb,var(--color-primary) 55%,var(--color-border)); box-shadow: 0 0 0 3px color-mix(in srgb,var(--color-primary) 13%,transparent); }
  .sender-settings-screen .sender-edit-grid label.field-invalid input { border-color: var(--color-danger); }
  .sender-settings-screen .sender-edit-grid select { width: 100%; height: 36px; padding: 0 8px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface-raised); color: var(--color-text); outline: 0; }
  .sender-settings-screen .sender-edit-grid select:focus { border-color: color-mix(in srgb,var(--color-primary) 55%,var(--color-border)); box-shadow: 0 0 0 3px color-mix(in srgb,var(--color-primary) 13%,transparent); }
  .sender-settings-screen .sender-edit-grid label.field-invalid select { border-color: var(--color-danger); }
  .sender-settings-screen .sender-port-controls { display: grid; gap: 6px; }
  .sender-settings-screen .sender-edit-grid label > small { display: block; margin-top: 6px; font-size: var(--text-caption); line-height: 1.4; }
  .sender-settings-screen .sender-secret-field { grid-column: 1 / -1; }
  .sender-settings-screen .sender-credential-field { grid-column: 1 / -1; }
  .sender-settings-screen .sender-secret-field small { display: block; margin-top: 6px; color: var(--color-text-muted); font-size: var(--text-caption); line-height: 1.45; }
  .sender-settings-screen .sender-selection-summary { min-width: 0; }
  .sender-settings-screen .sender-policy-error { margin: 0 18px 14px; }
  .sender-settings-screen .policy-current-summary { color: var(--color-text-muted); font-size: var(--text-caption); }
  .sender-settings-screen .config-master-detail,
  .sender-settings-screen .config-detail-panel,
  .sender-settings-screen .config-detail-body { min-height: 0; }
  .sender-settings-screen .config-detail-body { overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; -webkit-overflow-scrolling: touch; }
  .sender-settings-screen .config-detail-body > .detail-section:last-of-type { margin-bottom: 8px; }
  .sender-settings-screen .action-overlay .overlay-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  @media (max-width: 1150px) { .sender-settings-screen .config-detail-actions .connection-state { display: inline-flex; } }
  @media (max-width: 900px) { .sender-settings-screen.settings-workspace > .config-master-detail { height: auto; min-height: 0; max-height: none; overflow: visible; } }
  @media (min-width: 761px) and (max-width: 1000px) { .sender-settings-screen.settings-workspace.workspace-module-frame { height: auto; min-height: 0; max-height: none; overflow: visible; } }
  @media (max-width: 760px) {
    .sender-settings-screen .config-master { height: min(42dvh, 340px); min-height: 220px; max-height: none; overflow: hidden; }
    .sender-settings-screen .config-master-list { min-height: 0; max-height: none; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
    .sender-settings-screen .config-detail-actions { flex-wrap: wrap; }
    .sender-settings-screen .config-detail-actions .connection-state { display: inline-flex; flex: 1 1 220px; justify-content: center; }
    .sender-settings-screen .sender-edit-grid { grid-template-columns: 1fr; }
    .sender-settings-screen .sender-edit-grid label:nth-child(2) { border-top: 1px solid var(--line-soft); }
    .sender-settings-screen .sender-edit-grid label:nth-child(even) { border-left: 0; }
  }
`;

function ErrorCard({ retry }: { retry: () => void }) {
  return <div className="module-card permission-denied-card"><span className="status danger">Không thể tải dữ liệu</span><h2>Không thể tải cấu hình gửi</h2><p>Đã xảy ra lỗi khi tải dữ liệu. Vui lòng thử lại.</p><button className="secondary-button" onClick={retry}>Thử lại</button></div>;
}

function SmtpPortControls({ port, mode, invalid, onPick, onType }: { port: number; mode: SmtpPortMode; invalid: boolean; onPick: (option: string) => void; onType: (port: number) => void }) {
  return <>
    <select aria-label="Cổng SMTP" aria-invalid={invalid} value={smtpPortSelectValue(port, mode)} onChange={(event) => onPick(event.target.value)}>
      {SMTP_PORT_PRESETS.map((preset) => <option key={preset.port} value={preset.port}>{smtpPortOptionLabel(preset)}</option>)}
      <option value={SMTP_PORT_CUSTOM}>Khác…</option>
    </select>
    {mode === 'custom' && <input aria-label="Cổng SMTP tùy chỉnh" aria-invalid={invalid} type="number" min={1} max={65535} value={port} onChange={(event) => onType(Number(event.target.value))} />}
  </>;
}

function SenderCreateForm({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [form, setForm] = useState(senderFormInitial());
  const [portMode, setPortMode] = useState<SmtpPortMode>(() => smtpPortModeFor(form.port));
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldValidationErrors>({});
  const [saving, setSaving] = useState(false);
  const set = (key: keyof SenderFormState, value: string | number) => {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => { const next = { ...current }; delete next[key]; return next; });
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const clientErrors = validateSenderForm(form, { requireSecret: true });
    if (Object.keys(clientErrors).length > 0) { setFieldErrors(clientErrors); setError(firstValidationError(clientErrors)); return; }
    setSaving(true); setError(null); setFieldErrors({});
    try { await createSenderConfig({ ...form, replyTo: form.replyTo.trim() || null }); onSaved(); }
    catch (cause) { const serverErrors = apiFieldErrors(cause); setFieldErrors(serverErrors); setError(firstValidationError(serverErrors) ?? (cause instanceof ApiError ? cause.message : 'Không thể lưu cấu hình.')); }
    finally { setSaving(false); }
  };
  const choosePort = (option: string) => { const next = selectSmtpPort(option, form.port); setPortMode(next.mode); set('port', next.port); };
  const field = (key: keyof SenderFormState, label: React.ReactNode, hint: string, input: React.ReactNode) => <label className={`modal-field ${fieldErrors[key] ? 'field-invalid' : ''}`}><span>{label}</span>{input}<small className={fieldErrors[key] ? 'field-error' : 'field-help'}>{fieldErrors[key] ?? hint}</small></label>;
  return <div className="overlay-backdrop" onMouseDown={onClose}><form className="action-overlay modal-medium" onSubmit={submit} noValidate onMouseDown={(event) => event.stopPropagation()}><header><div><h2>Thêm cấu hình gửi</h2><p>Đây là tài khoản người gửi. Người nhận chỉ được chọn khi tạo chiến dịch, không cấu hình tại đây.</p></div><button type="button" aria-label="Đóng" onClick={onClose}>×</button></header><div className="overlay-content modal-form-grid">
    {field('name', <>Tên cấu hình <i className="required-mark">*</i></>, 'Thiếu tên sẽ không thể lưu cấu hình.', <input autoFocus aria-invalid={Boolean(fieldErrors.name)} value={form.name} onChange={(event) => set('name', event.target.value)} />)}
    {field('fromName', 'Tên người gửi', 'Để trống, hộp thư có thể chỉ hiển thị địa chỉ email.', <input value={form.fromName} onChange={(event) => set('fromName', event.target.value)} />)}
    {field('fromEmail', <>Email người gửi <i className="required-mark">*</i></>, 'Địa chỉ này được dùng làm SMTP MAIL FROM.', <input aria-invalid={Boolean(fieldErrors.fromEmail)} type="email" value={form.fromEmail} onChange={(event) => set('fromEmail', event.target.value)} />)}
    {field('replyTo', 'Reply-To', 'Để trống, phản hồi sẽ gửi về email người gửi.', <input aria-invalid={Boolean(fieldErrors.replyTo)} type="email" value={form.replyTo} onChange={(event) => set('replyTo', event.target.value)} />)}
    {field('host', <>Máy chủ SMTP <i className="required-mark">*</i></>, 'Thiếu host sẽ không thể kiểm tra hoặc gửi email.', <input aria-invalid={Boolean(fieldErrors.host)} value={form.host} onChange={(event) => set('host', event.target.value)} />)}
    {field('port', <>Cổng SMTP <i className="required-mark">*</i></>, smtpPortHint(form.port, portMode), <SmtpPortControls port={form.port} mode={portMode} invalid={Boolean(fieldErrors.port)} onPick={choosePort} onType={(port) => set('port', port)} />)}
    {field('username', 'Tên đăng nhập SMTP', 'Chỉ nhập khi máy chủ SMTP yêu cầu xác thực; khi đó cần mật khẩu/token tương ứng.', <input value={form.username} onChange={(event) => set('username', event.target.value)} />)}
    {field('secret', <>{'Mật khẩu / token'} {form.username.trim() && <i className="required-mark">*</i>}</>, 'Credential được mã hóa, lưu bền vững và không hiển thị lại.', <input aria-invalid={Boolean(fieldErrors.secret)} type="password" autoComplete="new-password" value={form.secret} onChange={(event) => set('secret', event.target.value)} />)}
    {error && <p className="login-error full" role="alert">{error}</p>}
  </div><footer><button type="button" className="secondary-button" onClick={onClose}>Hủy</button><button className="primary-button" disabled={saving}>{saving ? 'Đang lưu…' : 'Lưu cấu hình'}</button></footer></form></div>;
}

function PolicyLoading() {
  return <div className="default-policy-panel sender-policy-loading" role="status" aria-live="polite"><div className="module-card">Đang tải…</div></div>;
}

function SenderEditField({ editing, error, label, hint, className, children }: { editing: boolean; error?: string; label: React.ReactNode; hint: string; className?: string; children: React.ReactNode }) {
  return <label className={[className, error ? 'field-invalid' : ''].filter(Boolean).join(' ') || undefined}><span>{label}</span>{children}{editing && <small className={error ? 'field-error' : 'field-help'}>{error ?? hint}</small>}</label>;
}

const SENDER_STATUS_LABEL: Record<SenderConfig['status'], string> = {
  pending: 'Chờ kiểm tra kết nối',
  verified: 'Sẵn sàng gửi',
  failed: 'Cần kiểm tra lại',
  disabled: 'Đã tắt',
};

export default function SenderSettingsScreen({ policyOnly = false }: { policyOnly?: boolean }) {
  const [items, setItems] = useState<SenderConfig[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [policy, setPolicy] = useState<SendingPolicy | null>(null);
  const [savedPolicy, setSavedPolicy] = useState<SendingPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<SenderFormState | null>(null);
  const [portMode, setPortMode] = useState<SmtpPortMode>('preset');
  const [savingSender, setSavingSender] = useState(false);
  const [senderError, setSenderError] = useState<string | null>(null);
  const [senderFieldErrors, setSenderFieldErrors] = useState<FieldValidationErrors>({});
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const selected = useMemo(() => (items ?? []).find((item) => item.id === selectedId) ?? null, [items, selectedId]);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [senders, currentPolicy] = await Promise.all([listSenderConfigs(), getSendingPolicy()]);
      setItems(senders.items);
      setSelectedId((old) => senders.items.some((item) => item.id === old) ? old : senders.items[0]?.id ?? null);
      setPolicy(currentPolicy); setSavedPolicy(currentPolicy);
    } catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!selected || editing) return;
    setEditForm(senderFormInitial(selected));
    setPortMode(smtpPortModeFor(selected.port));
    setSenderError(null);
  }, [editing, selected]);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 2800); };
  const visibleItems = filterSenderConfigs(items ?? [], query);
  const policyDirty = JSON.stringify(policy) !== JSON.stringify(savedPolicy);
  const beginEdit = () => { if (selected) { setEditForm(senderFormInitial(selected)); setPortMode(smtpPortModeFor(selected.port)); setSenderError(null); setSenderFieldErrors({}); setEditing(true); } };
  const cancelEdit = () => { setEditForm(selected ? senderFormInitial(selected) : null); if (selected) setPortMode(smtpPortModeFor(selected.port)); setSenderError(null); setSenderFieldErrors({}); setEditing(false); };
  const setEditValue = (key: keyof SenderFormState, value: string | number) => { setEditForm((current) => current ? { ...current, [key]: value } : current); setSenderFieldErrors((current) => { const next = { ...current }; delete next[key]; return next; }); };
  const chooseEditPort = (option: string) => { const next = selectSmtpPort(option, editForm?.port ?? 0); setPortMode(next.mode); setEditValue('port', next.port); };
  const saveSender = async () => {
    if (!selected || !editForm) return;
    const clientErrors = validateSenderForm(editForm, { requireSecret: !selected.credentialConfigured });
    if (Object.keys(clientErrors).length > 0) { setSenderFieldErrors(clientErrors); setSenderError(firstValidationError(clientErrors)); return; }
    const initial = senderFormInitial(selected);
    const changes = senderUpdatePayload(initial, editForm);
    if (Object.keys(changes).length === 0) { cancelEdit(); return; }
    setSavingSender(true); setSenderError(null); setSenderFieldErrors({});
    try {
      const updated = await updateSenderConfig(selected.id, changes);
      setItems((current) => (current ?? []).map((item) => item.id === updated.id ? updated : item));
      setEditForm(senderFormInitial(updated)); setPortMode(smtpPortModeFor(updated.port)); setEditing(false); notify('Đã cập nhật cấu hình gửi');
    } catch (cause) { const serverErrors = apiFieldErrors(cause); setSenderFieldErrors(serverErrors); setSenderError(firstValidationError(serverErrors) ?? (cause instanceof ApiError ? cause.message : 'Không thể cập nhật cấu hình gửi.')); }
    finally { setSavingSender(false); }
  };
  const disableSelected = async () => {
    if (!selected || !window.confirm(`Tắt "${selected.name}"? Cấu hình này sẽ không dùng được cho lượt gửi mới; lịch sử vẫn giữ sender snapshot.`)) return;
    await disableSenderConfig(selected.id); notify('Đã tắt cấu hình gửi'); await load();
  };
  const savePolicy = async () => {
    if (!policy) return;
    setSavingPolicy(true); setPolicyError(null);
    try {
      const updated = await updateSendingPolicy({ ...policy, replyTo: policy.replyTo?.trim() || null });
      setPolicy(updated); setSavedPolicy(updated); notify('Đã lưu chính sách gửi mặc định');
    } catch (cause) { setPolicyError(cause instanceof ApiError ? cause.message : 'Không thể lưu chính sách gửi mặc định.'); }
    finally { setSavingPolicy(false); }
  };
  const cancelPolicy = () => { setPolicy(savedPolicy); setPolicyError(null); };

  if (error && !loading) return <ErrorCard retry={() => void load()} />;

  if (policyOnly) {
    const inheritedSenders = (items ?? []).filter((item) => item.status === 'verified');
    const defaultSender = inheritedSenders.find((item) => item.id === policy?.defaultSenderConfigId) ?? null;
    return <section className="settings-workspace workspace-module-frame sender-settings-screen"><style>{senderSettingsStyles}</style><header className="settings-topbar workspace-module-topbar"><SettingsTabs active="policy" /></header>{loading && policy === null ? <PolicyLoading /> : <div className="default-policy-panel"><header><div><h3>Chính sách gửi mặc định</h3><p>Áp dụng khi tạo bản nháp mới và tại thời điểm worker tạo execution gửi.</p></div><span><i />{inheritedSenders.length} cấu hình khả dụng</span></header><div className="policy-notice"><span>i</span><p><b>Thay đổi có hiệu lực với các lượt gửi tiếp theo</b><small>Chỉ sender đã xác thực mới được chọn; batch, retry và tốc độ được lưu bền vững.</small></p></div><div className="default-policy-grid"><label><div><b>Cấu hình mặc định</b><small>Sender được sao chép vào bản nháp mới.</small></div><span><select aria-label="Cấu hình gửi mặc định" value={policy?.defaultSenderConfigId ?? ''} onChange={(event) => setPolicy((current) => ({ ...(current ?? { replyTo: null, batchSize: 100, maxAttempts: 5, tenantRateLimitPerMinute: 600, defaultTimezone: null }), defaultSenderConfigId: event.target.value || null }))}><option value="">Chưa chọn</option>{(items ?? []).filter((item) => item.status === 'verified').map((item) => <option key={item.id} value={item.id}>{item.name} · {item.fromEmail}</option>)}</select></span></label><label><div><b>Reply-To mặc định</b><small>Dùng khi sender không khai báo Reply-To riêng.</small></div><span><input aria-label="Reply-To mặc định" type="email" placeholder="reply@example.com" value={policy?.replyTo ?? ''} onChange={(event) => setPolicy((current) => ({ ...(current ?? { defaultSenderConfigId: null, batchSize: 100, maxAttempts: 5, tenantRateLimitPerMinute: 600, defaultTimezone: null }), replyTo: event.target.value }))} /></span></label><label><div><b>Email mỗi lượt</b><small>Số người nhận tối đa được worker xử lý trong một batch.</small></div><span><input aria-label="Email mỗi lượt" type="number" min={1} max={5000} value={policy?.batchSize ?? 100} onChange={(event) => setPolicy((current) => ({ ...(current ?? { defaultSenderConfigId: null, replyTo: null, maxAttempts: 5, tenantRateLimitPerMinute: 600, defaultTimezone: null }), batchSize: Number(event.target.value) }))} /><em>email</em></span></label><label><div><b>Số lần gửi tối đa</b><small>Gồm lần đầu và các lần thử lại lỗi tạm thời.</small></div><span><input aria-label="Số lần gửi tối đa" type="number" min={1} max={20} value={policy?.maxAttempts ?? 5} onChange={(event) => setPolicy((current) => ({ ...(current ?? { defaultSenderConfigId: null, replyTo: null, batchSize: 100, tenantRateLimitPerMinute: 600, defaultTimezone: null }), maxAttempts: Number(event.target.value) }))} /><em>lần</em></span></label><label><div><b>Tốc độ tenant</b><small>Giới hạn tổng số email gửi trong một phút.</small></div><span><input aria-label="Tốc độ tenant" type="number" min={1} max={1000000} value={policy?.tenantRateLimitPerMinute ?? 600} onChange={(event) => setPolicy((current) => ({ ...(current ?? { defaultSenderConfigId: null, replyTo: null, batchSize: 100, maxAttempts: 5, defaultTimezone: null }), tenantRateLimitPerMinute: Number(event.target.value) }))} /><em>email/phút</em></span></label><label><div><b>Múi giờ mặc định</b><small>Ngày trong email hiển thị theo múi giờ này khi biến không khai báo riêng.</small></div><span><select aria-label="Múi giờ mặc định" value={policy?.defaultTimezone ?? ''} onChange={(event) => setPolicy((current) => ({ ...(current ?? { defaultSenderConfigId: null, replyTo: null, batchSize: 100, maxAttempts: 5, tenantRateLimitPerMinute: 600, defaultTimezone: null }), defaultTimezone: event.target.value || null }))}><option value="">UTC (mặc định)</option>{timezoneOptions().map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></span></label></div><div className="policy-scope"><header><b>Phạm vi áp dụng</b><span>{defaultSender ? 'Đã chọn sender mặc định' : 'Chưa chọn sender mặc định'}</span></header>{defaultSender ? <div><span className="config-avatar">{defaultSender.fromName?.[0] ?? defaultSender.fromEmail[0]}</span><p><b>{defaultSender.name}</b><small>{defaultSender.fromEmail}</small></p><em>Mặc định</em></div> : <div><span className="config-avatar">!</span><p><b>Chưa có cấu hình mặc định</b><small>Bản nháp mới sẽ yêu cầu chọn sender trước khi gửi.</small></p><em>Cần chọn</em></div>}</div>{policyError && <p className="login-error sender-policy-error" role="alert">{policyError}</p>}<footer><span className="policy-current-summary">{policyDirty ? 'Có thay đổi chưa lưu' : `Hiện tại: ${policy?.batchSize ?? 100} email/lượt · tối đa ${policy?.maxAttempts ?? 5} lần · ${policy?.tenantRateLimitPerMinute ?? 600} email/phút`}</span><div>{policyDirty && <button className="secondary-button" disabled={savingPolicy} onClick={cancelPolicy}>Hủy thay đổi</button>}<button className="primary-button" disabled={!policy || loading || savingPolicy || !policyDirty} onClick={() => void savePolicy()}>{savingPolicy ? 'Đang lưu…' : 'Lưu chính sách mặc định'}</button></div></footer></div>}{toast && <div className="toast" role="status" aria-live="polite">✓ {toast}</div>}</section>;
  }

  return <section className="settings-workspace workspace-module-frame sender-settings-screen"><style>{senderSettingsStyles}</style><header className="settings-topbar workspace-module-topbar"><SettingsTabs active="senders" counts={{ senders: items?.length ?? 0 }} /><button className="primary-button" onClick={() => setCreateOpen(true)}>＋ Thêm cấu hình</button></header><section className="config-master-detail"><aside className="config-master"><div className="config-master-toolbar"><div className="search-box">⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm cấu hình gửi" /></div></div><div className="config-master-list">{loading && !items ? <div className="module-card">Đang tải…</div> : visibleItems.length ? visibleItems.map((item) => <button key={item.id} className={selected?.id === item.id ? 'selected' : ''} onClick={() => { if (editing && !window.confirm('Hủy thay đổi chưa lưu và chuyển cấu hình?')) return; setEditing(false); setSelectedId(item.id); }}><span className="config-avatar">{item.fromName?.[0] ?? item.fromEmail[0]}</span><span className="config-master-copy"><span><b>{item.name}</b>{policy?.defaultSenderConfigId === item.id && <em>Mặc định</em>}</span><small>{item.fromEmail}</small><span className="config-row-meta"><i className={item.status === 'verified' ? 'online' : 'warning'} />{SENDER_STATUS_LABEL[item.status]}</span></span><i className="master-chevron">›</i></button>) : <div className="module-card"><h3>{query ? 'Không tìm thấy cấu hình' : 'Chưa có cấu hình gửi'}</h3><p>{query ? 'Thử từ khóa khác.' : 'Thêm cấu hình SMTP đầu tiên để bắt đầu.'}</p></div>}</div></aside><article className="config-detail-panel">{selected && editForm ? <><header><div className="config-detail-title sender-selection-summary"><span className="config-avatar large">{selected.fromName?.[0] ?? selected.fromEmail[0]}</span><div><h3>{selected.name}</h3><p>{selected.fromName || 'Chưa đặt tên người gửi'} · {selected.fromEmail}</p></div></div><div className="config-detail-actions"><button className={selected.status === 'verified' ? 'connection-state connected' : 'connection-state attention'} disabled={editing} onClick={() => void testSenderConnection(selected.id).then((result) => { notify(result.ok ? 'Xác thực SMTP và địa chỉ gửi thành công' : senderConnectionFailureMessage(result)); void load(); }).catch((cause) => notify(cause instanceof ApiError ? cause.message : 'Không thể kiểm tra kết nối.'))}><i />{selected.status === 'verified' ? 'Đã kết nối' : 'Kiểm tra kết nối'}</button>{!editing && <button className="secondary-button" onClick={beginEdit}>Chỉnh sửa</button>}<button className="text-button danger-text" disabled={editing || selected.status === 'disabled'} onClick={() => void disableSelected().catch((cause) => notify(cause instanceof ApiError ? cause.message : 'Không thể tắt cấu hình.'))}>Tắt cấu hình</button></div></header><div className="config-detail-body"><section className="detail-section"><header><div><h4>Người gửi và phản hồi</h4><p>{editing ? 'Các ô đã được mở khóa. Xác nhận hoặc hủy ở thanh hành động bên dưới.' : 'Thông tin đang khóa để tránh thay đổi ngoài ý muốn.'}</p></div></header><div className="sender-edit-grid"><SenderEditField editing={editing} error={senderFieldErrors.name} label={<>Tên cấu hình <i className="required-mark">*</i></>} hint="Thiếu tên sẽ không thể lưu cấu hình."><input aria-invalid={Boolean(senderFieldErrors.name)} disabled={!editing} value={editForm.name} onChange={(event) => setEditValue('name', event.target.value)} /></SenderEditField><SenderEditField editing={editing} label="Tên người gửi" hint="Để trống, hộp thư có thể chỉ hiển thị địa chỉ email."><input disabled={!editing} value={editForm.fromName} onChange={(event) => setEditValue('fromName', event.target.value)} /></SenderEditField><SenderEditField editing={editing} error={senderFieldErrors.fromEmail} label={<>Email người gửi <i className="required-mark">*</i></>} hint="Địa chỉ này được dùng làm SMTP MAIL FROM."><input aria-invalid={Boolean(senderFieldErrors.fromEmail)} disabled={!editing} type="email" value={editForm.fromEmail} onChange={(event) => setEditValue('fromEmail', event.target.value)} /></SenderEditField><SenderEditField editing={editing} error={senderFieldErrors.replyTo} label="Reply-To" hint="Để trống, phản hồi sẽ gửi về email người gửi."><input aria-invalid={Boolean(senderFieldErrors.replyTo)} disabled={!editing} type="email" value={editForm.replyTo} placeholder={editing ? 'Không đặt' : '—'} onChange={(event) => setEditValue('replyTo', event.target.value)} /></SenderEditField><SenderEditField editing={editing} className="sender-credential-field" label="Tên đăng nhập SMTP" hint="Chỉ nhập khi máy chủ SMTP yêu cầu xác thực; khi đó cần mật khẩu/token tương ứng."><input disabled={!editing} value={editForm.username} placeholder={editing ? 'Không dùng xác thực' : '—'} onChange={(event) => setEditValue('username', event.target.value)} /></SenderEditField></div></section><section className="detail-section"><header><div><h4>Kết nối SMTP</h4><p>{editing ? 'Đổi host, cổng hoặc credential; cấu hình cần kiểm tra lại sau khi lưu.' : 'Kiểm tra kết nối sẽ gửi một email thử tới chính địa chỉ người gửi; không cần cấu hình người nhận chiến dịch tại đây.'}</p></div></header><div className="sender-edit-grid"><SenderEditField editing={editing} error={senderFieldErrors.host} label={<>Máy chủ <i className="required-mark">*</i></>} hint="Thiếu host sẽ không thể kiểm tra hoặc gửi mail."><input aria-invalid={Boolean(senderFieldErrors.host)} disabled={!editing} value={editForm.host} onChange={(event) => setEditValue('host', event.target.value)} /></SenderEditField><SenderEditField editing={editing} error={senderFieldErrors.port} label={<>Cổng <i className="required-mark">*</i></>} hint={smtpPortHint(editForm.port, portMode)}>{editing ? <div className="sender-port-controls"><SmtpPortControls port={editForm.port} mode={portMode} invalid={Boolean(senderFieldErrors.port)} onPick={chooseEditPort} onType={(port) => setEditValue('port', port)} /></div> : <input disabled value={smtpPortSummary(editForm.port)} />}</SenderEditField><label><span>Credential SMTP</span><input disabled value={!editForm.username.trim() ? 'Không dùng xác thực' : selected.credentialConfigured ? 'Đã lưu an toàn · không hiển thị lại' : 'Chưa có · cần cập nhật'} /></label><label><span>Trạng thái</span><input disabled value={SENDER_STATUS_LABEL[selected.status]} /></label>{editing && <label className={`sender-secret-field ${senderFieldErrors.secret ? 'field-invalid' : ''}`}><span>Mật khẩu / token mới {editForm.username.trim() && !selected.credentialConfigured && <i className="required-mark">*</i>}</span><input aria-invalid={Boolean(senderFieldErrors.secret)} type="password" autoComplete="new-password" value={editForm.secret} placeholder={selected.credentialConfigured ? 'Để trống để giữ credential đã lưu' : editForm.username.trim() ? 'Nhập credential SMTP' : 'Không cần nếu SMTP không xác thực'} onChange={(event) => setEditValue('secret', event.target.value)} /><small className={senderFieldErrors.secret ? 'field-error' : 'field-help'}>{senderFieldErrors.secret ?? (selected.credentialConfigured ? 'Credential hiện tại được giữ nguyên nếu để trống.' : 'Credential cũ không còn khả dụng; nhập lại rồi lưu và kiểm tra kết nối.')}</small></label>}</div></section>{senderError && <p className="login-error" role="alert">{senderError}</p>}</div><footer className={`detail-savebar ${editing ? 'visible' : ''}`}><span><i />Có thay đổi chưa xác nhận</span><div><button className="secondary-button" disabled={savingSender} onClick={cancelEdit}>Hủy thay đổi</button><button className="primary-button" disabled={savingSender} onClick={() => void saveSender()}>{savingSender ? 'Đang lưu…' : 'Xác nhận cập nhật'}</button></div></footer></> : <div className="module-card"><h3>Chọn cấu hình gửi</h3><p>Chọn một cấu hình hoặc thêm cấu hình mới.</p></div>}</article></section>{createOpen && <SenderCreateForm onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); notify('Đã thêm cấu hình gửi'); void load(); }} />}{toast && <div className="toast" role="status" aria-live="polite">✓ {toast}</div>}</section>;
}
