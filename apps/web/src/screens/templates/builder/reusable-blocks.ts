import type { ReusableBlockSummary } from '../../../api/reusable-blocks.js';

/**
 * The `search` half of MC-UI-004, as a pure function (spec §2.1: web has no
 * component-render test, so anything with a rule in it has to live here).
 *
 * Filtering is local. A tenant's block library is small and already loaded, so
 * a round-trip per keystroke would add latency and a race for nothing -- and
 * the catalog's `search` action says nothing about where it runs.
 */

/**
 * Vietnamese-aware, and diacritic-insensitive on purpose: someone hunting for
 * "chân trang" types "chan trang" far more often than they switch keyboards.
 * `localeCompare(..., 'vi')` (spec §2.6) is the ordering rule; NFD + combining
 * mark strip is the matching rule. Đ/đ does not decompose, so it is mapped by
 * hand -- without that, "dong" would not find "đóng".
 */
export function foldVietnamese(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/**
 * Filter by name, then order by name. One list for the whole tenant -- blocks
 * belong to the tenant, not to whoever saved them (plan §S5 Task 26), so there
 * is deliberately no "mine first" ordering: that would reintroduce personal
 * ownership through the back door of a sort.
 */
export function filterReusableBlocks(blocks: readonly ReusableBlockSummary[], search: string): ReusableBlockSummary[] {
  const needle = foldVietnamese(search);
  const matched = needle.length === 0
    ? [...blocks]
    : blocks.filter((block) => foldVietnamese(block.name).includes(needle));
  return matched.sort((left, right) => left.name.localeCompare(right.name, 'vi'));
}

/** Attribution line for a row. Never a permission hint -- everyone with `content:manage` may rename or delete any of these. */
export function reusableBlockAuthorLabel(block: ReusableBlockSummary): string {
  return block.createdByName?.trim() || 'Không rõ người lưu';
}
