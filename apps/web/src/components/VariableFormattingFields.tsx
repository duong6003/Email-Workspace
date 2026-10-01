import type { CustomFieldType } from '../api/customFields.js';
import { DATE_FORMAT_PRESETS, DEFAULT_DATE_FORMAT, FORMATTABLE_VARIABLE_TYPES, timezoneOptions } from '../api/variable-formatting.js';

export const VARIABLE_TYPE_LABEL: Record<CustomFieldType, string> = {
  text: 'Văn bản',
  number: 'Số',
  date: 'Ngày',
  boolean: 'Đúng/Sai',
  enum: 'Danh sách lựa chọn',
};

/**
 * ADR-036 scope item 5, the create/edit half. Shared by the recipient
 * custom-field overlay and the configured-variable overlay so the two variable
 * systems -- which had drifted apart, one typed and one not -- present the same
 * controls for the same setting.
 *
 * The samples beside each pattern are static copy, not a client-side renderer:
 * the rendered value always comes from the server, which is what keeps preview
 * and the real send in step.
 */
export function VariableTypeField({ value, disabled, onChange }: { value: CustomFieldType; disabled: boolean; onChange: (value: CustomFieldType) => void }) {
  return <label className="modal-field">
    <span>Kiểu dữ liệu</span>
    <select aria-label="Kiểu dữ liệu của biến" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as CustomFieldType)}>
      {(Object.keys(VARIABLE_TYPE_LABEL) as CustomFieldType[]).map((type) => <option key={type} value={type}>{VARIABLE_TYPE_LABEL[type]}</option>)}
    </select>
    <small className="field-help">{disabled ? 'Kiểu dữ liệu không đổi được sau khi tạo.' : 'Kiểu "Ngày" cho phép chọn cách hiển thị bên dưới.'}</small>
  </label>;
}

export function VariableFormattingFields({ dataType, format, timezone, onFormatChange, onTimezoneChange }: {
  dataType: CustomFieldType;
  format: string;
  timezone: string;
  onFormatChange: (value: string) => void;
  onTimezoneChange: (value: string) => void;
}) {
  if (!FORMATTABLE_VARIABLE_TYPES.includes(dataType)) return null;
  return <>
    <label className="modal-field">
      <span>Định dạng hiển thị</span>
      <select aria-label="Định dạng ngày" value={format} onChange={(event) => onFormatChange(event.target.value)}>
        <option value="">Mặc định ({DEFAULT_DATE_FORMAT})</option>
        {DATE_FORMAT_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.value} — {preset.sample}</option>)}
      </select>
      <small className="field-help">Giá trị được hiển thị theo định dạng này trong email gửi đi và trong bản xem trước.</small>
    </label>
    <label className="modal-field">
      <span>Múi giờ</span>
      <select aria-label="Múi giờ của biến" value={timezone} onChange={(event) => onTimezoneChange(event.target.value)}>
        <option value="">Theo múi giờ mặc định của workspace</option>
        {timezoneOptions().map((zone) => <option key={zone} value={zone}>{zone}</option>)}
      </select>
      <small className="field-help">Quyết định ngày rơi vào hôm nào: một giá trị lưu kèm lệch giờ +07:00 sẽ lùi một ngày nếu đọc theo UTC.</small>
    </label>
  </>;
}
