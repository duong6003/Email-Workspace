import { describe, expect, it } from 'vitest';
import { customFieldCreateRequestSchema, customFieldUpdateRequestSchema } from './custom-field.dto.js';

const base = { key: 'ngay_het_han', label: 'Hạn dùng', type: 'date' as const };

/**
 * ADR-036. Presentation is declared on the definition, so the definition is
 * where a bad pattern has to be refused -- a `DD/MM/YYYY` accepted here would
 * reach a customer as the literal text "DD/MM/YYYY".
 */
describe('customFieldCreateRequestSchema formatting fields (ADR-036)', () => {
  it('accepts a date field with a format and an IANA timezone', () => {
    const parsed = customFieldCreateRequestSchema.parse({ ...base, format: 'dd/MM/yyyy', timezone: 'Asia/Ho_Chi_Minh' });

    expect(parsed).toMatchObject({ format: 'dd/MM/yyyy', timezone: 'Asia/Ho_Chi_Minh' });
  });

  it('defaults both to undefined so an existing client keeps working unchanged', () => {
    const parsed = customFieldCreateRequestSchema.parse({ key: 'ghi_chu', label: 'Ghi chú', type: 'text' });

    expect(parsed.format).toBeUndefined();
    expect(parsed.timezone).toBeUndefined();
  });

  it('rejects a moment.js format spelling', () => {
    expect(customFieldCreateRequestSchema.safeParse({ ...base, format: 'DD/MM/YYYY' }).success).toBe(false);
  });

  it('rejects a timezone Node cannot resolve', () => {
    expect(customFieldCreateRequestSchema.safeParse({ ...base, timezone: 'Asia/Hanoi' }).success).toBe(false);
  });

  it('rejects formatting on a type that has no presentation of its own yet', () => {
    expect(customFieldCreateRequestSchema.safeParse({ key: 'ghi_chu', label: 'Ghi chú', type: 'text', format: 'dd/MM/yyyy' }).success).toBe(false);
    expect(customFieldCreateRequestSchema.safeParse({ key: 'ghi_chu', label: 'Ghi chú', type: 'text', timezone: 'Etc/UTC' }).success).toBe(false);
  });
});

describe('customFieldUpdateRequestSchema formatting fields (ADR-036)', () => {
  it('accepts a format and a timezone', () => {
    expect(customFieldUpdateRequestSchema.parse({ format: 'yyyy-MM-dd', timezone: 'Etc/UTC' }))
      .toMatchObject({ format: 'yyyy-MM-dd', timezone: 'Etc/UTC' });
  });

  it('accepts null to clear one back to the tenant default', () => {
    expect(customFieldUpdateRequestSchema.parse({ format: null, timezone: null })).toEqual({ format: null, timezone: null });
  });

  it('still rejects an unusable format', () => {
    expect(customFieldUpdateRequestSchema.safeParse({ format: 'YYYY' }).success).toBe(false);
  });
});
