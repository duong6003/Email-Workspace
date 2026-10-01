import { describe, expect, it } from 'vitest';
import {
  DATE_FORMAT_PRESETS,
  dateFormatPresetFor,
  timezoneOptions,
  variableFormattingPayload,
  variablePresentationSummary,
} from './variable-formatting.js';

describe('variableFormattingPayload (ADR-036)', () => {
  it('sends the chosen format and timezone for a date variable', () => {
    expect(variableFormattingPayload({ dataType: 'date', format: 'yyyy-MM-dd', timezone: 'Asia/Ho_Chi_Minh' }))
      .toEqual({ format: 'yyyy-MM-dd', timezone: 'Asia/Ho_Chi_Minh' });
  });

  it('sends null rather than an empty string, so "use the default" clears the stored value', () => {
    expect(variableFormattingPayload({ dataType: 'date', format: '', timezone: '' }))
      .toEqual({ format: null, timezone: null });
  });

  /**
   * The API refuses a format on a type that has no presentation, so a form that
   * kept a stale value after the author switched the type back to text would
   * fail to save with an error about a control no longer on screen.
   */
  it('drops formatting entirely for a type that has no presentation of its own', () => {
    expect(variableFormattingPayload({ dataType: 'text', format: 'dd/MM/yyyy', timezone: 'Etc/UTC' }))
      .toEqual({ format: null, timezone: null });
  });
});

describe('variablePresentationSummary (ADR-036)', () => {
  it('names the effective pattern and zone a reader would otherwise have to infer', () => {
    expect(variablePresentationSummary({ dataType: 'date', format: 'yyyy-MM-dd', timezone: 'Asia/Ho_Chi_Minh' }))
      .toBe('yyyy-MM-dd · Asia/Ho_Chi_Minh');
  });

  it('says which half is inherited when only one is set', () => {
    expect(variablePresentationSummary({ dataType: 'date', format: null, timezone: 'Asia/Ho_Chi_Minh' }))
      .toBe('dd/MM/yyyy · Asia/Ho_Chi_Minh');
    expect(variablePresentationSummary({ dataType: 'date', format: 'yyyy-MM-dd', timezone: null }))
      .toBe('yyyy-MM-dd · múi giờ mặc định');
  });

  it('has nothing to say about a type with no presentation', () => {
    expect(variablePresentationSummary({ dataType: 'text', format: null, timezone: null })).toBeNull();
  });
});

describe('date format presets', () => {
  it('matches a stored format back to its preset so an edit form reopens on it', () => {
    expect(dateFormatPresetFor('dd/MM/yyyy')?.sample).toBe('01/09/2026');
    expect(dateFormatPresetFor('không-phải-preset')).toBeNull();
  });

  it('offers every preset a distinct pattern', () => {
    expect(new Set(DATE_FORMAT_PRESETS.map((preset) => preset.value)).size).toBe(DATE_FORMAT_PRESETS.length);
  });
});

describe('timezoneOptions', () => {
  it('offers IANA zones including the one this product is built for', () => {
    expect(timezoneOptions()).toContain('Asia/Ho_Chi_Minh');
  });

  it('is sorted, so a long list stays navigable', () => {
    const options = timezoneOptions();
    expect(options).toEqual([...options].sort());
  });
});
