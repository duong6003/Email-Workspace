import { ApiError } from './problem.js';

export type FieldRequirement = 'required' | 'optional';
export type FieldValidationErrors = Record<string, string>;

const FIELD_ERROR_COPY: Record<string, string> = {
  REQUIRED: 'Trường này là bắt buộc.',
  TOO_SMALL: 'Giá trị chưa đạt độ dài hoặc mức tối thiểu.',
  TOO_BIG: 'Giá trị vượt quá giới hạn cho phép.',
  INVALID_FORMAT: 'Định dạng chưa hợp lệ.',
  INVALID_STRING: 'Định dạng chưa hợp lệ.',
  INVALID_TYPE: 'Kiểu dữ liệu chưa hợp lệ.',
  INVALID_VALUE: 'Giá trị chưa hợp lệ.',
};

export function fieldRequirementLabel(requirement: FieldRequirement): string {
  return requirement === 'required' ? '*' : '';
}

export function fieldRequirementHint(requirement: FieldRequirement, consequence: string): string {
  void requirement;
  return consequence;
}

export function requiredText(value: string, message = 'Vui lòng nhập trường này.'): string | null {
  return value.trim() ? null : message;
}

export function validEmail(value: string, required = false): string | null {
  const normalized = value.trim();
  if (!normalized) return required ? 'Vui lòng nhập địa chỉ email.' : null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? null : 'Địa chỉ email chưa đúng định dạng.';
}

export function validPort(value: number): string | null {
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? null : 'Cổng SMTP phải là số từ 1 đến 65535.';
}

export function apiFieldErrors(cause: unknown): FieldValidationErrors {
  if (!(cause instanceof ApiError) || !cause.problem?.fieldErrors) return {};
  return Object.fromEntries(cause.problem.fieldErrors.map((error: { field: string; code: string; message?: string }) => [
    error.field,
    error.message?.trim() || FIELD_ERROR_COPY[error.code] || 'Giá trị chưa hợp lệ.',
  ]));
}

export function firstValidationError(errors: FieldValidationErrors): string | null {
  return Object.values(errors)[0] ?? null;
}
