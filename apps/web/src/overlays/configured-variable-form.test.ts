import { describe, expect, it } from 'vitest';
import { configuredVariableDefaultValue, configuredVariableFormError } from './configured-variable-form.js';

describe('configured variable form', () => {
  it('keeps the shared value of a global variable', () => {
    expect(configuredVariableDefaultValue({ scope: 'global', defaultMode: 'inherit', defaultValue: 'Alta Software' })).toBe('Alta Software');
  });

  it('sends no default when a template variable inherits', () => {
    expect(configuredVariableDefaultValue({ scope: 'template', defaultMode: 'inherit', defaultValue: 'bỏ qua' })).toBeNull();
  });

  it('sends the typed default when a template variable overrides', () => {
    expect(configuredVariableDefaultValue({ scope: 'template', defaultMode: 'override', defaultValue: 'Quý 3' })).toBe('Quý 3');
  });

  it('reports each blocking field in form order', () => {
    expect(configuredVariableFormError({ scope: 'template', defaultMode: 'inherit', defaultValue: '', key: 'Bad Key', label: 'Nhãn', isEdit: false }))
      .toBe('Mã biến phải bắt đầu bằng chữ thường và chỉ gồm chữ, số hoặc dấu gạch dưới.');
    expect(configuredVariableFormError({ scope: 'template', defaultMode: 'inherit', defaultValue: '', key: 'quarter', label: '  ', isEdit: false }))
      .toBe('Nhập tên hiển thị để người dùng nhận biết biến.');
    expect(configuredVariableFormError({ scope: 'global', defaultMode: 'inherit', defaultValue: '  ', key: 'company_name', label: 'Tên công ty', isEdit: false }))
      .toBe('Biến toàn hệ thống cần có giá trị dùng chung.');
    expect(configuredVariableFormError({ scope: 'template', defaultMode: 'override', defaultValue: '', key: 'quarter', label: 'Quý', isEdit: false }))
      .toBe('Nhập giá trị mặc định hoặc chọn không đặt mặc định.');
  });

  it('does not re-validate the immutable key when editing', () => {
    expect(configuredVariableFormError({ scope: 'global', defaultMode: 'override', defaultValue: 'Alta', key: 'Legacy Key', label: 'Tên công ty', isEdit: true })).toBeNull();
  });
});
