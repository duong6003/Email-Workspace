import { describe, expect, it } from 'vitest';
import { availableBulkActions, toggleSelection, selectAll } from './campaign-selection.js';

const rows = [
  { id: 'a', status: 'draft' },
  { id: 'b', status: 'draft' },
  { id: 'c', status: 'sending' },
  { id: 'd', status: 'completed' },
];

describe('toggleSelection', () => {
  it('adds an unselected id', () => {
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('removes a selected id', () => {
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('does not mutate the input', () => {
    const before = ['a'];
    toggleSelection(before, 'b');
    expect(before).toEqual(['a']);
  });
});

describe('selectAll', () => {
  it('selects every row when not all are selected', () => {
    expect(selectAll(rows, ['a'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clears the selection when every row is already selected', () => {
    expect(selectAll(rows, ['a', 'b', 'c', 'd'])).toEqual([]);
  });

  it('selects nothing when there are no rows', () => {
    expect(selectAll([], [])).toEqual([]);
  });
});

describe('availableBulkActions', () => {
  it('enables nothing for an empty selection', () => {
    expect(availableBulkActions(rows, [])).toEqual({ delete: false, duplicate: false, cancel: false });
  });

  it('enables delete only when every selected row is a draft', () => {
    expect(availableBulkActions(rows, ['a', 'b']).delete).toBe(true);
    expect(availableBulkActions(rows, ['a', 'c']).delete).toBe(false);
  });

  it('enables cancel only when every selected row is in flight', () => {
    expect(availableBulkActions(rows, ['c']).cancel).toBe(true);
    expect(availableBulkActions(rows, ['c', 'd']).cancel).toBe(false);
    expect(availableBulkActions(rows, ['a']).cancel).toBe(false);
  });

  it('enables duplicate for any non-empty selection', () => {
    expect(availableBulkActions(rows, ['a', 'c', 'd']).duplicate).toBe(true);
  });

  it('ignores selected ids that are no longer on the page', () => {
    expect(availableBulkActions(rows, ['a', 'gone']).delete).toBe(true);
  });

  it('enables nothing when every selected id is gone', () => {
    expect(availableBulkActions(rows, ['gone'])).toEqual({ delete: false, duplicate: false, cancel: false });
  });
});
