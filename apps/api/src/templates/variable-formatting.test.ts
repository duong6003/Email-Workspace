import { describe, expect, it } from 'vitest';
import { buildVariableFormatting } from './variable-formatting.js';

const field = (fieldKey: string, overrides = {}) => ({ fieldKey, dataType: 'date' as const, format: null, timezone: null, ...overrides });
const variable = (variableKey: string, overrides = {}) => ({ variableKey, dataType: 'date' as const, format: null, timezone: null, ...overrides });

describe('buildVariableFormatting (ADR-036)', () => {
  it('indexes recipient custom fields and configured variables under one key space', () => {
    const formatting = buildVariableFormatting(
      [field('ngay_het_han', { format: 'dd/MM/yyyy' })],
      [variable('ngay_khai_truong', { timezone: 'Asia/Ho_Chi_Minh' })],
      'Asia/Bangkok',
    );

    expect(formatting).toEqual({
      tenantTimezone: 'Asia/Bangkok',
      definitions: {
        ngay_het_han: { dataType: 'date', format: 'dd/MM/yyyy', timezone: null },
        ngay_khai_truong: { dataType: 'date', format: null, timezone: 'Asia/Ho_Chi_Minh' },
      },
    });
  });

  it('lets a configured variable win a key collision, as analyzeTemplateVariables already does', () => {
    const formatting = buildVariableFormatting(
      [field('gia_tri', { dataType: 'text' })],
      [variable('gia_tri', { dataType: 'date' })],
      null,
    );

    expect(formatting.definitions.gia_tri.dataType).toBe('date');
  });

  it('carries a null tenant timezone through rather than inventing one', () => {
    expect(buildVariableFormatting([], [], null).tenantTimezone).toBeNull();
  });
});
