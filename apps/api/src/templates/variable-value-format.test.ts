import { describe, expect, it } from 'vitest';
import { dateFormatError, formatVariableValue, timezoneError, type VariableFormatDefinition } from './variable-value-format.js';

const dateField = (overrides: Partial<VariableFormatDefinition> = {}): VariableFormatDefinition =>
  ({ dataType: 'date', format: null, timezone: null, ...overrides });

/**
 * ADR-036. The stored form of a `date` custom field is
 * `new Date(value).toISOString()`, so every case below starts from an instant,
 * never from a wall-clock string -- the calendar day it lands on is exactly
 * what the resolved timezone decides.
 */
describe('formatVariableValue (ADR-036)', () => {
  it('renders a date as a local calendar date, never as an ISO instant', () => {
    const rendered = formatVariableValue('2026-08-31T00:00:00.000Z', dateField(), 'Etc/UTC');

    expect(rendered).toBe('31/08/2026');
    expect(rendered).not.toMatch(/[TZ]/);
  });

  it('keeps a value stored with a +07:00 offset on its intended calendar day for a +07:00 tenant', () => {
    // 2026-09-01T00:00+07:00 reaches the database as this instant.
    const stored = new Date('2026-09-01T00:00+07:00').toISOString();
    expect(stored).toBe('2026-08-31T17:00:00.000Z');

    expect(formatVariableValue(stored, dateField(), 'Asia/Bangkok')).toBe('01/09/2026');
    // The previous-day rendering this work exists to remove.
    expect(formatVariableValue(stored, dateField(), 'Etc/UTC')).toBe('31/08/2026');
  });

  it("prefers the variable's own timezone over the tenant default", () => {
    const stored = '2026-08-31T17:00:00.000Z';

    expect(formatVariableValue(stored, dateField({ timezone: 'Asia/Bangkok' }), 'Etc/UTC')).toBe('01/09/2026');
  });

  it("prefers the variable's own format over the default one", () => {
    expect(formatVariableValue('2026-08-31T17:30:00.000Z', dateField({ format: 'yyyy-MM-dd HH:mm', timezone: 'Asia/Bangkok' }), null))
      .toBe('2026-09-01 00:30');
  });

  it('falls back to UTC when neither the variable nor the tenant declares a timezone', () => {
    expect(formatVariableValue('2026-08-31T17:00:00.000Z', dateField(), null)).toBe('31/08/2026');
  });

  it('leaves a value that is not a parsable instant untouched rather than rendering "Invalid Date"', () => {
    expect(formatVariableValue('sắp hết hạn', dateField(), 'Asia/Bangkok')).toBe('sắp hết hạn');
  });

  it('leaves every non-date data type exactly as the renderer already emitted it', () => {
    expect(formatVariableValue('Hà Nội', { dataType: 'text', format: null, timezone: null }, 'Asia/Bangkok')).toBe('Hà Nội');
    expect(formatVariableValue(0, { dataType: 'number', format: null, timezone: null }, 'Asia/Bangkok')).toBe('0');
    expect(formatVariableValue(false, { dataType: 'boolean', format: null, timezone: null }, 'Asia/Bangkok')).toBe('false');
    expect(formatVariableValue('M', { dataType: 'enum', format: null, timezone: null }, 'Asia/Bangkok')).toBe('M');
  });

  it('renders an absent value as the empty string, as an undeclared variable already does', () => {
    expect(formatVariableValue(null, dateField(), 'Asia/Bangkok')).toBe('');
    expect(formatVariableValue(undefined, dateField(), 'Asia/Bangkok')).toBe('');
    expect(formatVariableValue(null, undefined, 'Asia/Bangkok')).toBe('');
  });

  it('renders a variable with no definition exactly as before', () => {
    expect(formatVariableValue('2026-08-31T00:00:00.000Z', undefined, 'Asia/Bangkok')).toBe('2026-08-31T00:00:00.000Z');
  });

  it('accepts a Date, which is what a jsonb round-trip of a timestamp can yield', () => {
    expect(formatVariableValue(new Date('2026-08-31T17:00:00.000Z'), dateField(), 'Asia/Bangkok')).toBe('01/09/2026');
  });
});

describe('dateFormatError', () => {
  it('accepts the patterns an author is expected to write', () => {
    for (const format of ['dd/MM/yyyy', 'yyyy-MM-dd', 'd/M/yy', 'dd.MM.yyyy', 'dd/MM/yyyy HH:mm', 'HH:mm:ss']) {
      expect(dateFormatError(format), format).toBeNull();
    }
  });

  it('rejects surrounding prose, which belongs in the template around the token', () => {
    expect(dateFormatError('ngày dd/MM/yyyy')).not.toBeNull();
  });

  it('rejects the moment.js spellings that silently render as literal text', () => {
    expect(dateFormatError('DD/MM/YYYY')).toContain('DD');
    expect(dateFormatError('dd/MM/YYYY')).toContain('YYYY');
  });

  it('rejects a format that contains no date token at all', () => {
    expect(dateFormatError('---')).not.toBeNull();
  });

  it('rejects an empty format', () => {
    expect(dateFormatError('')).not.toBeNull();
  });
});

describe('timezoneError', () => {
  it('accepts an IANA zone Node can resolve', () => {
    expect(timezoneError('Asia/Ho_Chi_Minh')).toBeNull();
    expect(timezoneError('Etc/UTC')).toBeNull();
  });

  it('rejects a zone Node cannot resolve', () => {
    expect(timezoneError('Asia/Hanoi')).not.toBeNull();
    expect(timezoneError('GMT+7')).not.toBeNull();
  });
});
