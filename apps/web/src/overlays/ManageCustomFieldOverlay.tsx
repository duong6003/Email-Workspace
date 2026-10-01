import { useState } from 'react';
import { ApiError } from '../api/problem.js';
import { createCustomField, updateCustomField, type CustomField, type CustomFieldType } from '../api/customFields.js';
import { VARIABLE_TYPE_LABEL, VariableFormattingFields } from '../components/VariableFormattingFields.js';
import { variableFormattingPayload } from '../api/variable-formatting.js';

/**
 * Admin create/edit overlay for BR-CF-001/002/003/009. Uses the same
 * overlay-backdrop / action-overlay / overlay-content / modal-field
 * structure AddRecipientOverlay/RecipientFilterOverlay already established
 * (M2-S1) rather than inventing new overlay chrome -- the handoff has no
 * dedicated "manage custom fields" overlay of its own (see EXECPLAN
 * Decision Log DEC-034), so this reuses the existing action-overlay
 * vocabulary the way M1-S2's PermissionDeniedScreen reused module-card/
 * status-pill tokens for a state absent from the handoff (DEC-011).
 */
const typeOptions = (Object.keys(VARIABLE_TYPE_LABEL) as CustomFieldType[]).map((value) => ({ value, label: VARIABLE_TYPE_LABEL[value] }));

export function ManageCustomFieldOverlay({ existing, onClose, onSaved }: { existing: CustomField | null; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState(existing?.key ?? '');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [type, setType] = useState<CustomFieldType>(existing?.type ?? 'text');
  const [required, setRequired] = useState(existing?.required ?? false);
  const [sensitive, setSensitive] = useState(existing?.sensitive ?? false);
  const [enumOptionsInput, setEnumOptionsInput] = useState((existing?.enumOptions ?? []).join(', '));
  const [defaultValue, setDefaultValue] = useState(existing?.defaultValue != null ? String(existing.defaultValue) : '');
  // ADR-036: presentation is declared here, on the definition, because the
  // {{...}} token deliberately carries none.
  const [format, setFormat] = useState(existing?.format ?? '');
  const [timezone, setTimezone] = useState(existing?.timezone ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const isEdit = existing !== null;

  const submit = async () => {
    setFieldError(null);
    if (!isEdit && !/^[a-z][a-z0-9_]*$/.test(key.trim())) {
      setFieldError('Mã biến chỉ gồm chữ thường, số, dấu gạch dưới và phải bắt đầu bằng chữ.');
      return;
    }
    if (!label.trim()) {
      setFieldError('Tên hiển thị là bắt buộc.');
      return;
    }
    const enumOptions = type === 'enum' ? enumOptionsInput.split(',').map((option) => option.trim()).filter(Boolean) : undefined;
    if (type === 'enum' && (!enumOptions || enumOptions.length === 0)) {
      setFieldError('Trường kiểu danh sách lựa chọn cần ít nhất một giá trị.');
      return;
    }

    setSubmitting(true);
    try {
      const formatting = variableFormattingPayload({ dataType: type, format, timezone });
      if (isEdit) {
        await updateCustomField(existing.id, { label: label.trim(), required, sensitive, enumOptions, defaultValue: defaultValue || undefined, ...formatting });
      } else {
        await createCustomField({ key: key.trim(), label: label.trim(), type, required, sensitive, enumOptions, defaultValue: defaultValue || undefined, ...formatting });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const reservedKeys = (err.problem as { reservedKeys?: string[] } | null)?.reservedKeys;
        setFieldError(reservedKeys ? `"${key}" là biến hệ thống và không thể dùng làm mã biến tùy chỉnh. Các mã bị bảo lưu: ${reservedKeys.join(', ')}.` : err.message);
      } else if (err instanceof ApiError && err.status === 409) {
        setFieldError('Mã biến này đã tồn tại.');
      } else if (err instanceof ApiError) {
        setFieldError(err.message);
      } else {
        setFieldError('Không thể lưu trường tùy chỉnh. Vui lòng thử lại.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="overlay-backdrop" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="custom-field-overlay-title" className="action-overlay modal-large" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="custom-field-overlay-title">{isEdit ? 'Sửa trường tùy chỉnh' : 'Tạo trường tùy chỉnh'}</h2>
            <p>Trường tùy chỉnh xuất hiện trong biểu mẫu người nhận và bảng biến khi soạn email.</p>
          </div>
          <button aria-label="Đóng cửa sổ" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="overlay-content">
          <div className="modal-form-grid">
            <label className="modal-field full">
              <span>Mã biến {!isEdit && <i className="required-mark">*</i>}</span>
              <input value={key} onChange={(event) => setKey(event.target.value)} placeholder="shirt_size" disabled={isEdit} required={!isEdit} />
            </label>
            <label className="modal-field full">
              <span>Tên hiển thị <i className="required-mark">*</i></span>
              <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Kích cỡ áo" required />
            </label>
            <label className="modal-field">
              <span>Kiểu dữ liệu</span>
              <select value={type} onChange={(event) => setType(event.target.value as CustomFieldType)} disabled={isEdit}>
                {typeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="modal-field">
              <span>Giá trị mặc định</span>
              <input value={defaultValue} onChange={(event) => setDefaultValue(event.target.value)} placeholder="(tùy chọn)" />
            </label>
            {type === 'enum' && (
              <label className="modal-field full">
                <span>Các lựa chọn (phân tách bằng dấu phẩy)</span>
                <input value={enumOptionsInput} onChange={(event) => setEnumOptionsInput(event.target.value)} placeholder="S, M, L" />
              </label>
            )}
            <VariableFormattingFields dataType={type} format={format} timezone={timezone} onFormatChange={setFormat} onTimezoneChange={setTimezone} />
          </div>
          <label className="recipient-permission">
            <input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />
            <span>
              <b>Yêu cầu có giá trị</b>
              <small>Người nhận mới phải có giá trị cho trường này (hoặc dùng giá trị mặc định).</small>
            </span>
          </label>
          <label className="recipient-permission">
            <input type="checkbox" checked={sensitive} onChange={(event) => setSensitive(event.target.checked)} />
            <span>
              <b>Dữ liệu nhạy cảm</b>
              <small>Giá trị của trường này sẽ được che ("***") trong nhật ký thay đổi (audit log).</small>
            </span>
          </label>
          {fieldError && (
            <p className="login-error" role="alert">
              {fieldError}
            </p>
          )}
        </div>
        <footer>
          <button className="secondary-button" onClick={onClose}>
            Hủy
          </button>
          <button className="primary-button" onClick={() => void submit()} disabled={submitting}>
            {submitting ? 'Đang lưu…' : isEdit ? 'Lưu thay đổi' : 'Tạo trường'}
          </button>
        </footer>
      </section>
    </div>
  );
}
