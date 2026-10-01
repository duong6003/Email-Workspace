import { describe, expect, it } from 'vitest';
import type { TemplateVersion } from '../../api/templates.js';
import {
  changedVersionFields,
  diffLines,
  diffVersionHtml,
  formatHiddenDiffCount,
  normalizeHtmlLines,
  truncateLineDiff,
  versionsAreIdentical,
  VERSION_DIFF_FIELD_LABEL,
  type LineDiffEntry,
  type VersionDiffField,
} from './version-diff.js';

/**
 * Plan Task 48 (docs/superpowers/plans/2026-08-31-mailcraft-builder-vertical-slice.md)
 * says to reuse `templateConflictExcerpt` (template-editor.ts:79) to compare two
 * versions. Measured and rejected: the builder emitter (emitter.ts:299) writes a
 * FIXED 367-character prefix before any node content, and the excerpt cuts at 120
 * characters. Two versions whose visible content differs everywhere still produce
 * byte-identical excerpts, because the excerpt never reaches past the emitter's own
 * preamble. `.compose-conflict-diff` (the presentation) is still reused; the actual
 * comparison below is not, and did not exist before this module. User decision
 * 2026-09-05: line diff.
 *
 * `TemplateVersion` (api/templates.ts:26) has no `name` and no `projectData`, so
 * `TEMPLATE_CONFLICT_FIELD_LABEL` (template-editor.ts:70) cannot be reused as-is --
 * two of its five labels name fields a version doesn't have, and it has nothing for
 * `variableSchema`. `VERSION_DIFF_FIELD_LABEL` below is this module's own table,
 * scoped to what a version actually carries.
 */

/**
 * The builder emitter (emitter.ts:299) writes this fixed 367-character preamble --
 * with the default theme (document.ts:172) -- before any node content. Shared by
 * every test below that needs two versions differing only past it, so the number
 * is pinned once (`toHaveLength(367)` in `diffVersionHtml`'s test) rather than
 * copy-pasted per test.
 */
const EMITTER_PREFIX =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
  '<body style="margin:0;background-color:#f3f1ed;font-family:Arial, Helvetica, sans-serif;font-size:14px">' +
  '<table role="presentation" width="100%"><tr><td align="center">' +
  '<table role="presentation" width="640" style="width:100%;max-width:640px;background-color:#ffffff">';

const baseVersion = (over: Partial<TemplateVersion> = {}): TemplateVersion => ({
  id: 'ver-1',
  templateId: 'tpl-1',
  version: 1,
  subject: 'Chào mừng',
  html: '<p>Xin chào</p>',
  textBody: 'Xin chào',
  variableSchema: { required: [], optional: [] },
  contentHash: 'hash-a',
  publishedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('versionsAreIdentical', () => {
  it('is true when both versions carry the same content hash', () => {
    const left = baseVersion({ contentHash: 'h1' });
    const right = baseVersion({ id: 'ver-2', version: 2, contentHash: 'h1' });
    expect(versionsAreIdentical(left, right)).toBe(true);
  });

  it('is false when the content hash differs', () => {
    const left = baseVersion({ contentHash: 'h1' });
    const right = baseVersion({ contentHash: 'h2' });
    expect(versionsAreIdentical(left, right)).toBe(false);
  });
});

describe('changedVersionFields', () => {
  it('is empty for two versions that are otherwise identical', () => {
    const left = baseVersion();
    const right = baseVersion({ id: 'ver-2', version: 2 });
    expect(changedVersionFields(left, right)).toEqual([]);
  });

  it('names only the subject when nothing else changed', () => {
    const left = baseVersion({ subject: 'Chào mừng A' });
    const right = baseVersion({ subject: 'Chào mừng B' });
    expect(changedVersionFields(left, right)).toEqual(['subject']);
  });

  it('names every changed field, in a stable subject/html/textBody/variableSchema order', () => {
    const left = baseVersion({ subject: 'A', html: '<p>1</p>', textBody: '1', variableSchema: { required: [], optional: [] } });
    const right = baseVersion({ subject: 'B', html: '<p>2</p>', textBody: '2', variableSchema: { required: ['x'], optional: [] } });
    expect(changedVersionFields(left, right)).toEqual(['subject', 'html', 'textBody', 'variableSchema']);
  });

  it('names variableSchema when its content differs', () => {
    const left = baseVersion({ variableSchema: { required: ['ten'], optional: [] } });
    const right = baseVersion({ variableSchema: { required: ['ten', 'email'], optional: [] } });
    expect(changedVersionFields(left, right)).toEqual(['variableSchema']);
  });

  it('does not flag variableSchema as changed when it is the same data with keys written in a different order', () => {
    const left = baseVersion({ variableSchema: { required: ['ten'], optional: ['email'], defaults: { a: 1, b: 2 } } });
    const right = baseVersion({ variableSchema: { optional: ['email'], required: ['ten'], defaults: { b: 2, a: 1 } } });
    expect(changedVersionFields(left, right)).toEqual([]);
  });

  it('treats two versions with every text field empty as having no field differences', () => {
    const left = baseVersion({ subject: '', html: '', textBody: '' });
    const right = baseVersion({ id: 'ver-2', subject: '', html: '', textBody: '' });
    expect(changedVersionFields(left, right)).toEqual([]);
  });
});

describe('VERSION_DIFF_FIELD_LABEL', () => {
  it('has a Vietnamese label for every field this module can report', () => {
    const fields: VersionDiffField[] = ['subject', 'html', 'textBody', 'variableSchema'];
    for (const field of fields) {
      expect(typeof VERSION_DIFF_FIELD_LABEL[field]).toBe('string');
      expect(VERSION_DIFF_FIELD_LABEL[field].length).toBeGreaterThan(0);
    }
  });
});

describe('normalizeHtmlLines', () => {
  it('gives each tag and each run of text its own line', () => {
    expect(normalizeHtmlLines('<p>Dòng 1</p><p>Dòng 2</p>')).toEqual(['<p>', 'Dòng 1', '</p>', '<p>', 'Dòng 2', '</p>']);
  });

  it('collapses interior whitespace and drops lines left empty by it', () => {
    expect(normalizeHtmlLines('<p>\n  Dòng 1  \n</p>\n\n<p></p>')).toEqual(['<p>', 'Dòng 1', '</p>', '<p>', '</p>']);
  });

  it('is empty for an empty string', () => {
    expect(normalizeHtmlLines('')).toEqual([]);
  });
});

describe('diffLines', () => {
  it('marks every line unchanged when both sides are equal', () => {
    const lines = ['a', 'b', 'c'];
    expect(diffLines(lines, lines)).toEqual([
      { op: 'unchanged', line: 'a' },
      { op: 'unchanged', line: 'b' },
      { op: 'unchanged', line: 'c' },
    ]);
  });

  it('marks a trailing line only the newer side has as added', () => {
    expect(diffLines(['a', 'b'], ['a', 'b', 'c'])).toEqual([
      { op: 'unchanged', line: 'a' },
      { op: 'unchanged', line: 'b' },
      { op: 'added', line: 'c' },
    ]);
  });

  it('marks a trailing line only the older side has as removed', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'b'])).toEqual([
      { op: 'unchanged', line: 'a' },
      { op: 'unchanged', line: 'b' },
      { op: 'removed', line: 'c' },
    ]);
  });

  it('is empty for two empty sequences', () => {
    expect(diffLines([], [])).toEqual([]);
  });
});

describe('diffVersionHtml', () => {
  it('is empty when both versions have empty html', () => {
    const left = baseVersion({ html: '' });
    const right = baseVersion({ id: 'ver-2', html: '' });
    expect(diffVersionHtml(left, right)).toEqual([]);
  });

  it('reports an added line for a new paragraph appended at the end', () => {
    const left = baseVersion({ html: '<p>Dòng 1</p><p>Dòng 2</p>' });
    const right = baseVersion({ html: '<p>Dòng 1</p><p>Dòng 2</p><p>Dòng 3</p>' });
    const added = diffVersionHtml(left, right).filter((entry) => entry.op === 'added');
    expect(added.map((entry) => entry.line)).toEqual(['<p>', 'Dòng 3', '</p>']);
  });

  it('reports a removed line for a paragraph dropped from the end', () => {
    const left = baseVersion({ html: '<p>Dòng 1</p><p>Dòng 2</p><p>Dòng 3</p>' });
    const right = baseVersion({ html: '<p>Dòng 1</p><p>Dòng 2</p>' });
    const removed = diffVersionHtml(left, right).filter((entry) => entry.op === 'removed');
    expect(removed.map((entry) => entry.line)).toEqual(['<p>', 'Dòng 3', '</p>']);
  });

  /**
   * The excerpt this module replaces cuts at 120 characters. The builder emitter
   * (emitter.ts:299) writes a fixed preamble before any node content -- with the
   * default theme (document.ts:172) that preamble is exactly 367 characters, well
   * past the excerpt's cutoff. Pin that number below so this test fails loudly,
   * rather than silently passing for the wrong reason, if the emitter's preamble
   * ever changes shape. Two versions differing only after that preamble -- i.e. in
   * the middle of the document, never on line one -- are exactly the case where a
   * 120-char excerpt of the two would read identical while the actual content does
   * not. This is the defect the plan's Task 48 approach has and this module fixes.
   */
  it('tells apart two versions that differ only past the emitter\'s 367-char preamble, which a 120-char excerpt cannot', () => {
    expect(EMITTER_PREFIX).toHaveLength(367);

    const left = baseVersion({ contentHash: 'hash-a', html: `${EMITTER_PREFIX}<table><tr><td>Giá gốc: 199.000đ</td></tr></table></body></html>` });
    const right = baseVersion({ contentHash: 'hash-b', html: `${EMITTER_PREFIX}<table><tr><td>Giá gốc: 149.000đ</td></tr></table></body></html>` });

    // Prove the excerpt really is blind here -- otherwise the rest of this test proves nothing.
    const excerptOf = (html: string) => html.replace(/\s+/g, ' ').trim().slice(0, 120);
    expect(excerptOf(left.html)).toBe(excerptOf(right.html));

    const changed = diffVersionHtml(left, right).filter((entry) => entry.op !== 'unchanged');
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.some((entry) => entry.line.includes('199.000đ'))).toBe(true);
    expect(changed.some((entry) => entry.line.includes('149.000đ'))).toBe(true);
  });
});

describe('truncateLineDiff', () => {
  it('keeps everything and reports no hidden entries when the diff already fits', () => {
    const entries: LineDiffEntry[] = [{ op: 'unchanged', line: 'a' }];
    expect(truncateLineDiff(entries, 5)).toEqual({ entries, hiddenCount: 0 });
  });

  it('cuts to the limit and counts what was left out, for content longer than a display cell can hold', () => {
    const entries: LineDiffEntry[] = Array.from({ length: 250 }, (_, i) => ({ op: 'added' as const, line: `dòng ${i}` }));
    const result = truncateLineDiff(entries, 50);
    expect(result.entries).toHaveLength(50);
    expect(result.entries).toEqual(entries.slice(0, 50));
    expect(result.hiddenCount).toBe(200);
  });

  it('handles an empty diff', () => {
    expect(truncateLineDiff([], 50)).toEqual({ entries: [], hiddenCount: 0 });
  });

  /**
   * Measured bug: a naive "first N entries" cut is blind to WHERE the changes
   * are. The builder emitter's fixed 367-char preamble (see EMITTER_PREFIX
   * above) normalizes to exactly 10 lines, and every one of them is unchanged
   * between any two versions the builder produces. A display cell sized for
   * `limit` 6, 8, or 10 -- `.compose-conflict-diff`'s actual size -- would
   * therefore show nothing but `<!doctype html>`, `<html>`, `<head>`... and
   * never reach the line that actually changed. That is exactly the failure
   * of `templateConflictExcerpt` this module exists to replace, reproduced
   * through a different mechanism. This test goes through the same path the
   * UI takes (`diffVersionHtml` then `truncateLineDiff`) and must find the
   * real change inside what gets shown, not just inside the full diff.
   */
  it('keeps the real change visible when a small display cell truncates a diff that differs only past the emitter preamble', () => {
    const left = baseVersion({ contentHash: 'hash-a', html: `${EMITTER_PREFIX}<table><tr><td>Giá gốc: 199.000đ</td></tr></table></body></html>` });
    const right = baseVersion({ contentHash: 'hash-b', html: `${EMITTER_PREFIX}<table><tr><td>Giá gốc: 149.000đ</td></tr></table></body></html>` });
    const fullDiff = diffVersionHtml(left, right);

    for (const limit of [6, 8, 10]) {
      const { entries } = truncateLineDiff(fullDiff, limit);
      const shownText = entries.map((entry) => entry.line).join('\n');
      expect(shownText, `limit=${limit} should still show the old price`).toContain('199.000đ');
      expect(shownText, `limit=${limit} should still show the new price`).toContain('149.000đ');
    }
  });

  /**
   * `hiddenCount` feeds `formatHiddenDiffCount`'s "... and N more changes" line.
   * It must count hidden CHANGES, not hidden entries -- otherwise that line
   * lies whenever context lines are folded in around a change that still fits.
   */
  it('reports zero hidden when every changed line fits, even though unchanged entries were dropped to make room', () => {
    const entries: LineDiffEntry[] = [
      { op: 'unchanged', line: 'a' },
      { op: 'unchanged', line: 'b' },
      { op: 'unchanged', line: 'c' },
      { op: 'removed', line: 'old' },
      { op: 'added', line: 'new' },
      { op: 'unchanged', line: 'd' },
      { op: 'unchanged', line: 'e' },
      { op: 'unchanged', line: 'f' },
    ];
    const result = truncateLineDiff(entries, 4);
    expect(result.entries).toHaveLength(4);
    expect(result.entries.some((entry) => entry.op === 'removed')).toBe(true);
    expect(result.entries.some((entry) => entry.op === 'added')).toBe(true);
    expect(result.hiddenCount).toBe(0);
  });
});

describe('formatHiddenDiffCount', () => {
  it('names how many more changes are not shown', () => {
    expect(formatHiddenDiffCount(12)).toBe('… và 12 thay đổi khác');
  });

  it('says nothing when there is nothing left out', () => {
    expect(formatHiddenDiffCount(0)).toBe('');
  });
});

describe('end to end: two long versions through diffVersionHtml + truncateLineDiff', () => {
  /**
   * A "every single line differs" fixture never has to skip an unchanged line
   * to reach a real one, so it cannot tell a context-aware truncation apart
   * from a naive first-N cut -- exactly the gap that let the naive cut ship.
   * Real edits look like this instead: a long common head and tail, with the
   * actual change confined to a run in the middle (paragraphs 120-139 here).
   */
  it('produces a diff a small display cell can show, with the shown slice still containing a real change and the rest counted rather than dropped silently', () => {
    const leftParagraphs = Array.from({ length: 300 }, (_, i) => `<p>Dòng ${i}</p>`);
    const rightParagraphs = [...leftParagraphs];
    for (let i = 120; i < 140; i++) rightParagraphs[i] = `<p>Dòng đổi ${i}</p>`;

    const left = baseVersion({ html: leftParagraphs.join('') });
    const right = baseVersion({ id: 'ver-2', html: rightParagraphs.join('') });

    const { entries, hiddenCount } = truncateLineDiff(diffVersionHtml(left, right), 20);
    expect(entries).toHaveLength(20);
    expect(hiddenCount).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.op !== 'unchanged' && entry.line.includes('Dòng đổi'))).toBe(true);
  });
});
