import { describe, expect, it } from 'vitest';
import { toEditorRanges } from './lint-positions.js';

describe('toEditorRanges', () => {
  it('passes through ranges that fit the current document', () => {
    expect(toEditorRanges('<p>{{first_name}}</p>', [{ start: 3, end: 17, key: 'first_name' }]))
      .toEqual([{ from: 3, to: 17, key: 'first_name' }]);
  });

  it('drops ranges that start past the end of the document', () => {
    expect(toEditorRanges('<p>hi</p>', [{ start: 40, end: 55, key: 'stale' }])).toEqual([]);
  });

  it('clamps a range whose end runs past the document', () => {
    expect(toEditorRanges('<p>hi</p>', [{ start: 3, end: 99, key: 'clamped' }]))
      .toEqual([{ from: 3, to: 9, key: 'clamped' }]);
  });

  it('drops empty and inverted ranges', () => {
    expect(toEditorRanges('<p>hi</p>', [
      { start: 4, end: 4, key: 'empty' },
      { start: 6, end: 2, key: 'inverted' },
    ])).toEqual([]);
  });

  it('keeps ranges sorted by start position', () => {
    expect(toEditorRanges('0123456789', [
      { start: 6, end: 8, key: 'later' },
      { start: 1, end: 3, key: 'earlier' },
    ])).toEqual([
      { from: 1, to: 3, key: 'earlier' },
      { from: 6, to: 8, key: 'later' },
    ]);
  });
});
