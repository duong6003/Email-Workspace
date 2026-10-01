import { useState } from 'react';
import { ApiError } from '../api/problem.js';
import { createGlobalVariable, createTemplateVariable, updateGlobalVariable, updateTemplateVariable, type ConfiguredVariable } from '../api/configuredVariables.js';
import type { CustomFieldType } from '../api/customFields.js';
import { VariableFormattingFields, VariableTypeField } from '../components/VariableFormattingFields.js';
import { variableFormattingPayload } from '../api/variable-formatting.js';
import { ModalFrame } from '../components/ModalFrame.js';
import { OverrideChoice, type OverrideMode } from '../components/OverrideChoice.js';
import { configuredVariableDefaultValue, configuredVariableFormError } from './configured-variable-form.js';

/**
 * ADR-036: a typed variable's value is validated on entry now, so the form has
 * to say what a `date` will be checked against. The value box stays plain text
 * on purpose -- a date picker would have to decide which calendar day a stored
 * instant falls on, which is client-side formatting and exactly the divergence
 * the ADR keeps out of the client.
 */
function valueHint(dataType: CustomFieldType): string | null {
  if (dataType === 'date') return 'Nhập ngày theo ISO-8601, ví dụ 2026-09-01 hoặc 2026-09-01T00:00+07:00. Hiển thị trong email theo định dạng và múi giờ đã chọn ở trên.';
  if (dataType === 'number') return 'Chỉ nhận giá trị số.';
  if (dataType === 'boolean') return 'Chỉ nhận true hoặc false.';
  return null;
}

export function ManageConfiguredVariableOverlay({ scope, templateId, existing, initialKey = '', onClose, onSaved }: {
  scope: 'global' | 'template';
  templateId?: string;
  existing: ConfiguredVariable | null;
  initialKey?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState(existing?.key ?? initialKey);
  const [label, setLabel] = useState(existing?.label ?? '');
  const [defaultValue, setDefaultValue] = useState(existing?.defaultValue == null ? '' : String(existing.defaultValue));
  const [required, setRequired] = useState(existing?.required ?? false);
  const [allowCampaignOverride, setAllowCampaignOverride] = useState(existing?.allowCampaignOverride ?? false);
  const [defaultMode, setDefaultMode] = useState<OverrideMode>(existing?.defaultValue == null ? 'inherit' : 'override');
  // ADR-036 scope item 1: a configured variable carried no type at all, so
  // {{ngay_khai_truong}} could be neither validated on entry nor formatted.
  const [dataType, setDataType] = useState<CustomFieldType>(existing?.dataType ?? 'text');
  const [enumOptionsInput, setEnumOptionsInput] = useState((existing?.enumOptions ?? []).join(', '));
  const [format, setFormat] = useState(existing?.format ?? '');
  const [timezone, setTimezone] = useState(existing?.timezone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = existing !== null;

  const save = async () => {
    setError(null);
    const invalid = configuredVariableFormError({ scope, defaultMode, defaultValue, key, label, isEdit });
    if (invalid) { setError(invalid); return; }
    const enumOptions = dataType === 'enum' ? enumOptionsInput.split(',').map((option) => option.trim()).filter(Boolean) : undefined;
    if (dataType === 'enum' && (enumOptions?.length ?? 0) === 0) { setError('Biến kiểu danh sách lựa chọn cần ít nhất một giá trị.'); return; }
    setBusy(true);
    try {
      const value = configuredVariableDefaultValue({ scope, defaultMode, defaultValue });
      const typed = { enumOptions, ...variableFormattingPayload({ dataType, format, timezone }) };
      if (scope === 'global') {
        if (isEdit) await updateGlobalVariable(existing.id, { label: label.trim(), defaultValue: value, allowCampaignOverride, ...typed });
        else await createGlobalVariable({ key: key.trim(), label: label.trim(), dataType, defaultValue: value, allowCampaignOverride, ...typed });
      } else {
        if (!templateId) throw new Error('Missing template id.');
        if (isEdit) await updateTemplateVariable(existing.id, { label: label.trim(), defaultValue: value, required, allowCampaignOverride, ...typed });
        else await createTemplateVariable(templateId, { key: key.trim(), label: label.trim(), dataType, defaultValue: value, required, allowCampaignOverride, ...typed });
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Không thể lưu cấu hình biến.');
    } finally { setBusy(false); }
  };

  return <ModalFrame titleId="configured-variable-title" title={isEdit ? 'Cập nhật biến' : scope === 'global' ? 'Tạo biến toàn hệ thống' : 'Tạo biến cho template'} description={scope === 'global' ? 'Dùng chung cho nhiều template; giá trị được chốt khi xác nhận gửi.' : 'Chỉ thuộc template này và được đóng băng trong từng phiên bản xuất bản.'} size="medium" onClose={onClose} footer={<><button className="secondary-button" onClick={onClose}>Hủy</button><button className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Xác nhận'}</button></>}>
      <div className="modal-form-grid">
        <label className="modal-field"><span>Mã biến {!isEdit && <i className="required-mark">*</i>}</span><input autoFocus={!isEdit} disabled={isEdit} value={key} onChange={(event) => setKey(event.target.value)} placeholder="company_name" /></label>
        <label className="modal-field"><span>Tên hiển thị <i className="required-mark">*</i></span><input autoFocus={isEdit} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Tên công ty" /></label>
        {/* The type is immutable after creation, exactly as a custom field's is: stored values and published versions were written against it. */}
        <VariableTypeField value={dataType} disabled={isEdit} onChange={setDataType} />
        {dataType === 'enum' && <label className="modal-field full"><span>Các lựa chọn (phân tách bằng dấu phẩy)</span><input value={enumOptionsInput} onChange={(event) => setEnumOptionsInput(event.target.value)} placeholder="S, M, L" /></label>}
        <VariableFormattingFields dataType={dataType} format={format} timezone={timezone} onFormatChange={setFormat} onTimezoneChange={setTimezone} />
        {scope === 'global' && <label className="modal-field full"><span>Giá trị dùng chung <i className="required-mark">*</i></span><input value={defaultValue} onChange={(event) => setDefaultValue(event.target.value)} placeholder="Alta Software" /><small className="field-help">{valueHint(dataType) ?? 'Template dùng giá trị hiện tại cho tới khi chiến dịch được xác nhận.'}</small></label>}
      </div>
      {scope === 'template' && <><OverrideChoice value={defaultMode} onChange={setDefaultMode} inheritLabel="Không đặt mặc định" overrideLabel="Đặt mặc định cho template" inheritDescription="Giá trị phải đến từ dữ liệu gửi hoặc ghi đè được cho phép." overrideDescription="Dùng giá trị riêng này khi lượt gửi không cung cấp giá trị khác." description="Chọn nguồn giá trị mặc định của biến trong template này." />{defaultMode === 'override' && <label className="modal-field full"><span>Giá trị mặc định</span><input value={defaultValue} onChange={(event) => setDefaultValue(event.target.value)} placeholder="Nhập giá trị mặc định" /><small className="field-help">{valueHint(dataType) ?? 'Giá trị được lưu bất biến theo phiên bản template khi xuất bản.'}</small></label>}</>}
      {scope === 'template' && <label className="recipient-permission"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} /><span><b>Yêu cầu có giá trị</b><small>Nếu không có mặc định hoặc ghi đè, hệ thống chặn gửi.</small></span></label>}
      <label className="recipient-permission"><input type="checkbox" checked={allowCampaignOverride} onChange={(event) => setAllowCampaignOverride(event.target.checked)} /><span><b>Cho phép đổi ở từng lượt gửi</b><small>Trình soạn email sẽ hiển thị ô nhập giá trị riêng cho chiến dịch.</small></span></label>
      {error && <p className="login-error" role="alert">{error}</p>}
  </ModalFrame>;
}
