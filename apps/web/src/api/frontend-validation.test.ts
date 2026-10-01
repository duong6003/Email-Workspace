import { describe, expect, it } from 'vitest';
import { ApiError } from './problem.js';
import { apiFieldErrors, fieldRequirementHint, firstValidationError, requiredText, validEmail, validPort } from './frontend-validation.js';

describe('shared frontend validation convention', () => {
  it('labels required and optional fields with the consequence of leaving them empty', () => {
    expect(fieldRequirementHint('required', 'Thiếu trường này sẽ chặn gửi.')).toBe('Thiếu trường này sẽ chặn gửi.');
    expect(fieldRequirementHint('optional', 'Để trống sẽ dùng địa chỉ người gửi.')).toBe('Để trống sẽ dùng địa chỉ người gửi.');
  });

  it('validates text, email and SMTP ports before a request is sent', () => {
    expect(requiredText('  ')).toBeTruthy();
    expect(validEmail('bad', true)).toContain('định dạng');
    expect(validEmail('', false)).toBeNull();
    expect(validPort(0)).toContain('1 đến 65535');
    expect(validPort(1025)).toBeNull();
  });

  it('maps RFC 9457 field errors back to named controls', () => {
    const error = new ApiError(400, {
      type: 'about:blank', title: 'Bad Request', status: 400, detail: 'invalid', code: 'VALIDATION_FAILED',
      category: 'validation', messageKey: 'error.validationFailed', retryable: false, traceId: 'trace-fields',
      fieldErrors: [{ field: 'fromEmail', code: 'INVALID_FORMAT' }],
    });
    const mapped = apiFieldErrors(error);
    expect(mapped).toEqual({ fromEmail: 'Định dạng chưa hợp lệ.' });
    expect(firstValidationError(mapped)).toBe('Định dạng chưa hợp lệ.');
  });
});
