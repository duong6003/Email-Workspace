import { describe, expect, it } from 'vitest';
import { recipientCreateRequestSchema } from './recipient.dto.js';

// BR-REC-002: "Recipient hỗ trợ họ, tên, điện thoại, phòng ban, chức danh,
// địa điểm và trạng thái nhận email." / "API validate độ dài/định dạng;
// trường không bắt buộc có thể để trống."
describe('recipientCreateRequestSchema (BR-REC-002)', () => {
  it('accepts a request with only the required email field', () => {
    const result = recipientCreateRequestSchema.safeParse({ email: 'person@acme.vn' });
    expect(result.success).toBe(true);
  });

  it('rejects a missing email', () => {
    const result = recipientCreateRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a malformed email', () => {
    const result = recipientCreateRequestSchema.safeParse({ email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('rejects a department exceeding the max length', () => {
    const result = recipientCreateRequestSchema.safeParse({ email: 'a@acme.vn', department: 'x'.repeat(121) });
    expect(result.success).toBe(false);
  });

  it('accepts a full set of optional profile fields', () => {
    const result = recipientCreateRequestSchema.safeParse({
      email: 'a@acme.vn',
      firstName: 'An',
      lastName: 'Nguyễn',
      phone: '+84901234567',
      department: 'Marketing',
      title: 'Specialist',
      location: 'Hà Nội',
      subscriptionStatus: 'paused',
    });
    expect(result.success).toBe(true);
    expect(result.data?.subscriptionStatus).toBe('paused');
  });

  it('defaults subscriptionStatus to active when omitted', () => {
    const result = recipientCreateRequestSchema.safeParse({ email: 'a@acme.vn' });
    expect(result.data?.subscriptionStatus).toBe('active');
  });

  it('rejects an invalid subscriptionStatus value', () => {
    const result = recipientCreateRequestSchema.safeParse({ email: 'a@acme.vn', subscriptionStatus: 'deleted' });
    expect(result.success).toBe(false);
  });
});
