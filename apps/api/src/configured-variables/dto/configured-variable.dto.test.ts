import { describe, expect, it } from 'vitest';
import {
  createGlobalVariableSchema,
  createTemplateVariableSchema,
  updateGlobalVariableSchema,
  updateTemplateVariableSchema,
} from './configured-variable.dto.js';

const globalBase = { key: 'ngay_khai_truong', label: 'Ngày khai trương', defaultValue: '2026-09-01T00:00:00.000Z' };

/**
 * ADR-036 scope item 1. A configured variable was untyped free text, which is
 * why it could be neither validated on entry nor formatted later.
 */
describe('configured variable typing (ADR-036)', () => {
  it('defaults an untyped variable to text, exactly what it already was', () => {
    expect(createGlobalVariableSchema.parse(globalBase).dataType).toBe('text');
    expect(createTemplateVariableSchema.parse({ key: 'ghi_chu', label: 'Ghi chú' }).dataType).toBe('text');
  });

  it('accepts a date variable with a format and a timezone', () => {
    expect(createGlobalVariableSchema.parse({ ...globalBase, dataType: 'date', format: 'dd/MM/yyyy', timezone: 'Asia/Ho_Chi_Minh' }))
      .toMatchObject({ dataType: 'date', format: 'dd/MM/yyyy', timezone: 'Asia/Ho_Chi_Minh' });
  });

  it('rejects an unusable format or timezone on either scope', () => {
    expect(createGlobalVariableSchema.safeParse({ ...globalBase, dataType: 'date', format: 'DD/MM/YYYY' }).success).toBe(false);
    expect(createTemplateVariableSchema.safeParse({ key: 'ngay', label: 'Ngày', dataType: 'date', timezone: 'GMT+7' }).success).toBe(false);
  });

  it('rejects formatting on a type that has no presentation of its own yet', () => {
    expect(createGlobalVariableSchema.safeParse({ ...globalBase, format: 'dd/MM/yyyy' }).success).toBe(false);
  });

  /**
   * ADR-036 scope item 6, the half of the asymmetry that has a coherent
   * meaning here: an enum-typed variable constrains what an operator may type.
   */
  it('requires enum options for an enum variable and refuses them otherwise', () => {
    expect(createGlobalVariableSchema.safeParse({ ...globalBase, dataType: 'enum' }).success).toBe(false);
    expect(createGlobalVariableSchema.safeParse({ ...globalBase, defaultValue: 'M', dataType: 'enum', enumOptions: ['S', 'M'] }).success).toBe(true);
    expect(createGlobalVariableSchema.safeParse({ ...globalBase, enumOptions: ['S', 'M'] }).success).toBe(false);
  });

  it('lets an update change presentation without touching the value', () => {
    expect(updateGlobalVariableSchema.parse({ format: 'yyyy-MM-dd' })).toEqual({ format: 'yyyy-MM-dd' });
    expect(updateTemplateVariableSchema.parse({ timezone: null })).toEqual({ timezone: null });
  });

  it('refuses a data type change after creation, as a custom field already does', () => {
    expect(updateGlobalVariableSchema.safeParse({ dataType: 'date' }).success).toBe(false);
    expect(updateTemplateVariableSchema.safeParse({ dataType: 'date' }).success).toBe(false);
  });
});
