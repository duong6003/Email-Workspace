export type OverrideMode = 'inherit' | 'override';

export function OverrideChoice({ value, onChange, name = 'override-mode', inheritLabel = 'Kế thừa', overrideLabel = 'Thiết lập riêng', inheritDescription = 'Dùng giá trị từ cấu hình cấp trên.', overrideDescription = 'Lưu giá trị chỉ áp dụng trong phạm vi này.', description }: {
  value: OverrideMode;
  onChange: (value: OverrideMode) => void;
  name?: string;
  inheritLabel?: string;
  overrideLabel?: string;
  inheritDescription?: string;
  overrideDescription?: string;
  description?: string;
}) {
  return <fieldset className="override-choice">
    <legend>Phạm vi giá trị</legend>
    {description && <p>{description}</p>}
    <div>
      <label className={value === 'inherit' ? 'selected' : ''}><input type="radio" name={name} value="inherit" checked={value === 'inherit'} onChange={() => onChange('inherit')} /><span><b>{inheritLabel}</b><small>{inheritDescription}</small></span></label>
      <label className={value === 'override' ? 'selected' : ''}><input type="radio" name={name} value="override" checked={value === 'override'} onChange={() => onChange('override')} /><span><b>{overrideLabel}</b><small>{overrideDescription}</small></span></label>
    </div>
  </fieldset>;
}
