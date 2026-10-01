import type { TemplateVersion } from '../../api/templates.js';

/**
 * Compares two `TemplateVersion` records (api/templates.ts:26) for the
 * revision-conflict / version-history views.
 *
 * Plan Task 48 (docs/superpowers/plans/2026-08-31-mailcraft-builder-vertical-slice.md)
 * said to reuse `templateConflictExcerpt` (template-editor.ts:79) to compare two
 * versions. Measured and rejected: the builder emitter (builder/emitter.ts:299)
 * writes a FIXED preamble -- 367 characters with the default theme
 * (builder/document.ts:172) -- before any node content, and the excerpt cuts at
 * 120 characters. Two versions whose visible content differs everywhere still
 * produce byte-identical excerpts, because the excerpt never reaches past the
 * emitter's own preamble (proven in version-diff.test.ts). `.compose-conflict-diff`
 * (the grid the excerpt used to feed) is still reused elsewhere; the comparison
 * itself is not, and this module is what replaces it. User decision 2026-09-05:
 * a line diff.
 *
 * `TemplateVersion` has no `name` and no `projectData` -- unlike `EmailTemplate`,
 * it is a published snapshot of content only -- so `TEMPLATE_CONFLICT_FIELD_LABEL`
 * (template-editor.ts:70) cannot be reused as-is: two of its five labels name
 * fields a version does not have, and it has nothing for `variableSchema`, which
 * a version does have. `VERSION_DIFF_FIELD_LABEL` below is this module's own
 * table, scoped to exactly what a version carries.
 */

export type VersionDiffField = 'subject' | 'html' | 'textBody' | 'variableSchema';

export const VERSION_DIFF_FIELD_LABEL: Record<VersionDiffField, string> = {
  subject: 'Tiêu đề email',
  html: 'Nội dung HTML',
  textBody: 'Văn bản thuần',
  variableSchema: 'Khai báo biến',
};

/**
 * The exact-equality check the revision-conflict flow never had: `contentHash`
 * is the server's own fingerprint of a version's content (set alongside
 * `publishedAt`), so two versions sharing it are the same content, full stop --
 * no need to diff anything, and the UI should say so instead of rendering an
 * empty-looking diff.
 */
export function versionsAreIdentical(left: TemplateVersion, right: TemplateVersion): boolean {
  return left.contentHash === right.contentHash;
}

/** Structural equality that does not care about key order -- `JSON.stringify` would report two equal `variableSchema` objects as different if their keys were written in a different order. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in (b as Record<string, unknown>) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Which of the four comparable fields differ, in the fixed order the field label table lists them. */
export function changedVersionFields(left: TemplateVersion, right: TemplateVersion): VersionDiffField[] {
  const fields: VersionDiffField[] = [];
  if (left.subject !== right.subject) fields.push('subject');
  if (left.html !== right.html) fields.push('html');
  if (left.textBody !== right.textBody) fields.push('textBody');
  if (!deepEqual(left.variableSchema, right.variableSchema)) fields.push('variableSchema');
  return fields;
}

export type LineDiffOp = 'added' | 'removed' | 'unchanged';
export type LineDiffEntry = { op: LineDiffOp; line: string };

/**
 * Turns raw HTML into the lines a line diff should compare: each tag on its own
 * line, each run of text between tags on its own line, interior whitespace
 * collapsed (so reflowing the emitter's own indentation is not a diff), and
 * lines left empty by that collapse dropped.
 *
 * Splitting right after `>` and right before `<` (rather than on a fixed list of
 * "block" tag names) needs no such list to keep in sync with `document.ts`'s
 * kinds, and degrades the same way for every tag: a one-line change inside a
 * `<td>` shows as one changed line, not the whole surrounding table.
 */
export function normalizeHtmlLines(html: string): string[] {
  return html
    .split(/(?<=>)|(?=<)/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
}

/**
 * A textbook LCS-based line diff -- longest common subsequence by dynamic
 * programming, then a backtrack that walks it into added/removed/unchanged runs.
 * No new dependency: the whole thing is the two loops below.
 */
export function diffLines(before: readonly string[], after: readonly string[]): LineDiffEntry[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const entries: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      entries.push({ op: 'unchanged', line: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      entries.push({ op: 'removed', line: before[i]! });
      i++;
    } else {
      entries.push({ op: 'added', line: after[j]! });
      j++;
    }
  }
  while (i < n) entries.push({ op: 'removed', line: before[i++]! });
  while (j < m) entries.push({ op: 'added', line: after[j++]! });
  return entries;
}

/** `html` is the one field long and structured enough to need a line diff rather than a plain not-equal flag; `subject`/`textBody`/`variableSchema` are covered by `changedVersionFields`. */
export function diffVersionHtml(left: TemplateVersion, right: TemplateVersion): LineDiffEntry[] {
  return diffLines(normalizeHtmlLines(left.html), normalizeHtmlLines(right.html));
}

export type TruncatedLineDiff = { entries: LineDiffEntry[]; hiddenCount: number };

/**
 * Bounds a diff to what `.compose-conflict-diff`'s cell can actually show.
 *
 * Measured defect (fixed here): a plain "first `limit` entries" cut is blind to
 * WHERE the changes are. The builder emitter (builder/emitter.ts:299) writes a
 * fixed 367-character preamble before any node content, which normalizes
 * (`normalizeHtmlLines`) to exactly 10 lines that are unchanged between any two
 * versions the builder produces. A cell sized for `limit` 6-10 -- roughly
 * `.compose-conflict-diff`'s real size -- would show nothing but
 * `<!doctype html>`, `<html>`, `<head>`... and never reach the line that
 * actually changed: the same blindness `templateConflictExcerpt` had, produced
 * through a different mechanism.
 *
 * So this prioritizes `added`/`removed` lines, then spends whatever budget is
 * left on the unchanged lines nearest to a change (context, the way `diff -U`
 * shows a hunk) -- rather than nearest to the start of the list. If the changed
 * lines alone exceed `limit`, only the first `limit` of them are kept (no
 * context) and the rest are counted as hidden. Entries that ARE kept are
 * returned in original order, so the shown slice still reads top-to-bottom.
 *
 * `hiddenCount` counts hidden CHANGES (added/removed lines left out), not
 * hidden entries: dropping unchanged context to make room for the budget is not
 * something a user needs a "N more" count for, and `formatHiddenDiffCount`'s
 * message below only makes sense read as a count of changes.
 */
export function truncateLineDiff(entries: readonly LineDiffEntry[], limit: number): TruncatedLineDiff {
  if (entries.length <= limit) return { entries: [...entries], hiddenCount: 0 };

  const changedIndices: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.op !== 'unchanged') changedIndices.push(index);
  });

  if (changedIndices.length >= limit) {
    const kept = new Set(changedIndices.slice(0, limit));
    return {
      entries: entries.filter((_entry, index) => kept.has(index)),
      hiddenCount: changedIndices.length - limit,
    };
  }

  const kept = new Set(changedIndices);
  const distanceToNearestChange = (index: number): number => {
    let best = Infinity;
    for (const changedIndex of changedIndices) {
      const distance = Math.abs(changedIndex - index);
      if (distance < best) best = distance;
    }
    return best;
  };

  const contextBudget = limit - changedIndices.length;
  const contextCandidates = entries
    .map((_entry, index) => index)
    .filter((index) => !kept.has(index))
    .sort((a, b) => distanceToNearestChange(a) - distanceToNearestChange(b) || a - b);
  for (const index of contextCandidates.slice(0, contextBudget)) kept.add(index);

  return {
    entries: entries.filter((_entry, index) => kept.has(index)),
    hiddenCount: 0,
  };
}

/** The "… and N more" line for whatever `truncateLineDiff` left out. Empty when nothing was hidden, so a caller can render it unconditionally. */
export function formatHiddenDiffCount(hiddenCount: number): string {
  return hiddenCount > 0 ? `… và ${hiddenCount} thay đổi khác` : '';
}
