import { describe, expect, it } from 'vitest';
import type { ReusableBlockSummary } from '../../../api/reusable-blocks.js';
import { filterReusableBlocks, foldVietnamese, reusableBlockAuthorLabel } from './reusable-blocks.js';

const block = (name: string, createdByName: string | null = 'Minh An'): ReusableBlockSummary => ({
  id: `id-${name}`,
  name,
  createdBy: createdByName ? 'user-1' : null,
  createdByName,
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
  // ADR-044 Task SV-4: the row preview's numbers. Not what these tests are
  // about -- they filter and label by name -- but the type carries them now.
  columns: 2,
  elements: 3,
});

describe('foldVietnamese', () => {
  it('strips diacritics so an unaccented query still matches', () => {
    expect(foldVietnamese('Chân trang')).toBe('chan trang');
    expect(foldVietnamese('  TIÊU ĐỀ  ')).toBe('tieu de');
  });

  it('maps đ/Đ by hand -- it does not decompose, so NFD alone would leave it', () => {
    expect(foldVietnamese('Đóng góp')).toBe('dong gop');
    expect(foldVietnamese('đường')).toBe('duong');
  });
});

describe('filterReusableBlocks', () => {
  const library = [block('Chân trang'), block('Banner đầu thư'), block('Ảnh bìa'), block('Nút kêu gọi')];

  it('returns everything, sorted, for an empty query', () => {
    expect(filterReusableBlocks(library, '').map((item) => item.name)).toEqual(['Ảnh bìa', 'Banner đầu thư', 'Chân trang', 'Nút kêu gọi']);
  });

  it('ignores surrounding whitespace and case', () => {
    expect(filterReusableBlocks(library, '  CHÂN  ').map((item) => item.name)).toEqual(['Chân trang']);
  });

  it('matches an unaccented query against accented names', () => {
    expect(filterReusableBlocks(library, 'chan').map((item) => item.name)).toEqual(['Chân trang']);
    expect(filterReusableBlocks(library, 'dau thu').map((item) => item.name)).toEqual(['Banner đầu thư']);
  });

  it('orders by Vietnamese collation, not by code point', () => {
    // 'Ả' sorts right after 'A' in vi, but far after 'Z' by code point -- the
    // difference is the whole reason spec §2.6 names localeCompare(..., 'vi').
    const ordered = filterReusableBlocks([block('Zulu'), block('Ảnh bìa'), block('An toàn')], '');
    expect(ordered.map((item) => item.name)).toEqual(['An toàn', 'Ảnh bìa', 'Zulu']);
  });

  it('does not reorder by author -- blocks belong to the tenant, so there is no "mine first"', () => {
    const mixed = [block('Beta', 'Người khác'), block('Alpha', 'Tôi')];
    expect(filterReusableBlocks(mixed, '').map((item) => item.name)).toEqual(['Alpha', 'Beta']);
  });

  it('returns an empty list rather than everything when nothing matches', () => {
    expect(filterReusableBlocks(library, 'khong-co-gi')).toEqual([]);
  });

  it('leaves the caller\'s array untouched', () => {
    const original = [block('Beta'), block('Alpha')];
    filterReusableBlocks(original, '');
    expect(original.map((item) => item.name)).toEqual(['Beta', 'Alpha']);
  });
});

describe('reusableBlockAuthorLabel', () => {
  it('shows the display name', () => {
    expect(reusableBlockAuthorLabel(block('Chân trang', 'Minh An'))).toBe('Minh An');
  });

  it('says so plainly when the account is gone, rather than showing a raw id or an empty cell', () => {
    expect(reusableBlockAuthorLabel(block('Chân trang', null))).toBe('Không rõ người lưu');
    expect(reusableBlockAuthorLabel(block('Chân trang', '   '))).toBe('Không rõ người lưu');
  });
});
