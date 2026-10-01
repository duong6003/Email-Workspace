import { describe, expect, it } from 'vitest';
import { applyCustomFieldDefaults, coerceConfiguredVariableValue, coerceCustomFieldValue, validateCustomData } from './custom-field-values.js';
import type { CustomFieldDefinitionEntity } from '../database/entities/custom-field-definition.entity.js';

function field(overrides: Partial<CustomFieldDefinitionEntity>): CustomFieldDefinitionEntity {
  return {
    id: 'f1',
    tenantId: 't1',
    fieldKey: 'shirt_size',
    label: 'Shirt size',
    dataType: 'text',
    required: false,
    defaultValue: null,
    enumOptions: null,
    sensitive: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CustomFieldDefinitionEntity;
}

// BR-CF-002: "giá trị được lưu theo kiểu, không chỉ chuỗi" / "API từ chối sai kiểu".
describe('coerceCustomFieldValue (BR-CF-002)', () => {
  it('accepts a string for a text field', () => {
    expect(coerceCustomFieldValue(field({ dataType: 'text' }), 'M')).toBe('M');
  });

  it('rejects a number for a text field', () => {
    expect(() => coerceCustomFieldValue(field({ dataType: 'text' }), 42)).toThrow(/expects a text value/);
  });

  it('coerces a numeric string to a number for a number field', () => {
    expect(coerceCustomFieldValue(field({ dataType: 'number' }), '42')).toBe(42);
  });

  it('rejects a non-numeric string for a number field', () => {
    expect(() => coerceCustomFieldValue(field({ dataType: 'number' }), 'abc')).toThrow(/expects a numeric value/);
  });

  it('accepts a real boolean for a boolean field', () => {
    expect(coerceCustomFieldValue(field({ dataType: 'boolean' }), true)).toBe(true);
  });

  it('rejects a truthy non-boolean for a boolean field (no loose coercion)', () => {
    expect(() => coerceCustomFieldValue(field({ dataType: 'boolean' }), 'true')).toThrow(/expects a boolean value/);
  });

  it('normalizes a valid ISO date string for a date field', () => {
    const result = coerceCustomFieldValue(field({ dataType: 'date' }), '2026-01-15');
    expect(result).toBe(new Date('2026-01-15').toISOString());
  });

  it('rejects an invalid date string for a date field', () => {
    expect(() => coerceCustomFieldValue(field({ dataType: 'date' }), 'not-a-date')).toThrow(/expects an ISO-8601 date/);
  });

  it('accepts a value present in enumOptions for an enum field', () => {
    expect(coerceCustomFieldValue(field({ dataType: 'enum', enumOptions: ['S', 'M', 'L'] }), 'M')).toBe('M');
  });

  it('rejects a value absent from enumOptions for an enum field', () => {
    expect(() => coerceCustomFieldValue(field({ dataType: 'enum', enumOptions: ['S', 'M', 'L'] }), 'XL')).toThrow(/expects one of: S, M, L/);
  });

  it('passes null through regardless of declared type', () => {
    expect(coerceCustomFieldValue(field({ dataType: 'number' }), null)).toBeNull();
  });
});

describe('validateCustomData (BR-CF-002/BR-CF-003)', () => {
  const fields = [field({ fieldKey: 'shirt_size', dataType: 'enum', enumOptions: ['S', 'M', 'L'] }), field({ fieldKey: 'age', dataType: 'number' })];

  it('coerces every present key against its field definition', () => {
    expect(validateCustomData(fields, { shirt_size: 'M', age: '30' })).toEqual({ shirt_size: 'M', age: 30 });
  });

  it('rejects a key not in the schema', () => {
    expect(() => validateCustomData(fields, { not_defined: 'x' })).toThrow(/Unknown custom field key/);
  });

  it('rejects a reserved system key with the reserved-key list in the error', () => {
    try {
      validateCustomData(fields, { email: 'x@acme.vn' });
      throw new Error('expected validateCustomData to throw');
    } catch (err) {
      expect((err as { getResponse: () => { reservedKeys: string[] } }).getResponse().reservedKeys).toContain('email');
    }
  });
});

describe('applyCustomFieldDefaults', () => {
  it('fills a required field missing from the patch with its default_value', () => {
    const fields = [field({ fieldKey: 'plan', dataType: 'text', required: true, defaultValue: 'free' })];
    expect(applyCustomFieldDefaults(fields, {})).toEqual({ plan: 'free' });
  });

  it('does not override a value the caller already supplied', () => {
    const fields = [field({ fieldKey: 'plan', dataType: 'text', required: true, defaultValue: 'free' })];
    expect(applyCustomFieldDefaults(fields, { plan: 'pro' })).toEqual({ plan: 'pro' });
  });

  it('leaves a non-required field with no default untouched', () => {
    const fields = [field({ fieldKey: 'nickname', dataType: 'text', required: false, defaultValue: null })];
    expect(applyCustomFieldDefaults(fields, {})).toEqual({});
  });
});

/**
 * ADR-036 scope item 1. Typing a configured variable is what makes "validated
 * on entry" possible for it at all; the same coercion the recipient side has
 * used since BR-CF-002 is reused rather than reimplemented, so a date default
 * reaches the renderer in the one shape the formatter can read.
 */
describe('coerceConfiguredVariableValue (ADR-036)', () => {
  const variable = (dataType: CustomFieldDefinitionEntity['dataType'], enumOptions: string[] | null = null) =>
    ({ variableKey: 'ngay_khai_truong', dataType, enumOptions });

  it('normalises a date default to the stored ISO instant, offset included', () => {
    expect(coerceConfiguredVariableValue(variable('date'), '2026-09-01T00:00+07:00')).toBe('2026-08-31T17:00:00.000Z');
  });

  it('names the variable, not a custom field, when it refuses a value', () => {
    expect(() => coerceConfiguredVariableValue(variable('date'), 'hôm nay')).toThrow(/Variable "ngay_khai_truong"/);
    expect(() => coerceConfiguredVariableValue(variable('number'), 'nhiều')).toThrow(/expects a numeric value/);
    expect(() => coerceConfiguredVariableValue(variable('enum', ['S', 'M']), 'XL')).toThrow(/expects one of: S, M/);
  });

  it('leaves an untyped (text) variable exactly as it was before typing existed', () => {
    expect(coerceConfiguredVariableValue(variable('text'), 'Alta Software')).toBe('Alta Software');
  });

  /**
   * The recipient side receives customData from an API caller or an import
   * mapper and rightly refuses a string where a boolean was declared. A
   * configured variable is authored by hand in a settings form, where every
   * value arrives as text -- so refusing "true" there would make a boolean
   * variable impossible to create at all.
   */
  it('accepts the text a settings form can actually produce for a boolean', () => {
    expect(coerceConfiguredVariableValue(variable('boolean'), 'true')).toBe(true);
    expect(coerceConfiguredVariableValue(variable('boolean'), 'FALSE')).toBe(false);
    expect(coerceConfiguredVariableValue(variable('boolean'), false)).toBe(false);
    expect(() => coerceConfiguredVariableValue(variable('boolean'), 'có')).toThrow(/expects a boolean value/);
  });

  it('still refuses a string for a recipient boolean field, which never comes from a form', () => {
    expect(() => coerceCustomFieldValue(field({ dataType: 'boolean' }), 'true')).toThrow(/expects a boolean value/);
  });
});
