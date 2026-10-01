import { describe, expect, it } from 'vitest';
import { filterChips, removeFilter } from './active-filters.js';

describe('filterChips', () => {
  it('is empty when nothing is filtered', () => {
    expect(filterChips({})).toEqual([]);
  });

  it('labels a status filter with its Vietnamese name', () => {
    expect(filterChips({ status: 'draft' })).toEqual([{ key: 'status', label: 'Trạng thái: Bản nháp' }]);
  });

  it('falls back to the raw status when it has no label', () => {
    expect(filterChips({ status: 'weird' })).toEqual([{ key: 'status', label: 'Trạng thái: weird' }]);
  });

  it('labels both ends of a date range in Vietnamese order', () => {
    expect(filterChips({ dateFrom: '2026-08-01T00:00:00Z', dateTo: '2026-08-31T23:59:59Z' })).toEqual([
      { key: 'dateFrom', label: 'Từ 01/08/2026' },
      { key: 'dateTo', label: 'Đến 31/08/2026' },
    ]);
  });

  it('labels the id-valued filters generically, since the id is not a name', () => {
    expect(filterChips({ senderConfigId: 's-1', createdBy: 'u-1' })).toEqual([
      { key: 'senderConfigId', label: 'Cấu hình gửi đã chọn' },
      { key: 'createdBy', label: 'Người tạo đã chọn' },
    ]);
  });

  it('ignores paging and search, which have their own controls', () => {
    expect(filterChips({ cursor: 'abc', limit: 25, search: 'tháng 8' })).toEqual([]);
  });
});

describe('removeFilter', () => {
  it('drops one filter and keeps the rest', () => {
    expect(removeFilter({ status: 'draft', dateFrom: '2026-08-01T00:00:00Z' }, 'status')).toEqual({ dateFrom: '2026-08-01T00:00:00Z' });
  });

  it('drops the cursor too, because the old page is meaningless under a new filter', () => {
    expect(removeFilter({ status: 'draft', cursor: 'abc' }, 'status')).toEqual({});
  });

  it('does not mutate the input', () => {
    const before = { status: 'draft', cursor: 'abc' };
    removeFilter(before, 'status');
    expect(before).toEqual({ status: 'draft', cursor: 'abc' });
  });
});
