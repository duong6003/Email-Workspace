import type { OverrideMode } from '../components/OverrideChoice.js';

export type ConfiguredVariableFormState = {
  scope: 'global' | 'template';
  defaultMode: OverrideMode;
  defaultValue: string;
};

/**
 * A tenant-global variable is *defined* by its shared value, so the
 * inherit/override choice never applies to it — the form does not even render
 * that control. Only a template variable may deliberately carry no default and
 * demand the value from send data or an allowed campaign override.
 */
export function configuredVariableDefaultValue({ scope, defaultMode, defaultValue }: ConfiguredVariableFormState): string | null {
  const filled = defaultValue.trim().length > 0;
  if (scope === 'global') return filled ? defaultValue : null;
  return defaultMode === 'override' && filled ? defaultValue : null;
}

export function configuredVariableFormError(state: ConfiguredVariableFormState & { key: string; label: string; isEdit: boolean }): string | null {
  if (!state.isEdit && !/^[a-z][a-z0-9_]*$/.test(state.key.trim())) return 'Mã biến phải bắt đầu bằng chữ thường và chỉ gồm chữ, số hoặc dấu gạch dưới.';
  if (!state.label.trim()) return 'Nhập tên hiển thị để người dùng nhận biết biến.';
  if (state.scope === 'global' && !state.defaultValue.trim()) return 'Biến toàn hệ thống cần có giá trị dùng chung.';
  if (state.scope === 'template' && state.defaultMode === 'override' && !state.defaultValue.trim()) return 'Nhập giá trị mặc định hoặc chọn không đặt mặc định.';
  return null;
}
