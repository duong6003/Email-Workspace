import { describe, expect, it } from 'vitest';
import type { Doc, Node } from './document.js';
import { filterReviewIssues, readinessPercent, reviewCounts, reviewIssues } from './content-review.js';

/**
 * ADR-044 Task SV-5 (MC-UI-008 `run_content_review`), which absorbs S8 Task
 * 49's remaining half -- the plan's own words there are "6 mã lint
 * bấm-để-nhảy (§2.8)", and a lint row cannot be clicked to anywhere until
 * something maps it back to a node.
 *
 * The split of authority is the whole design, so it is asserted rather than
 * described: the SERVER decides what is wrong and how many (`analysis.lint`
 * counts the emitted HTML, `analysis.unknownVariables` the merge keys), and
 * this module only decides WHERE a row points. That is why a code the client
 * cannot locate still produces a row -- with `nodeId: null` -- instead of
 * being dropped, and why the client scan never invents a row the server did
 * not report.
 */

const leaf = (node: Partial<Node> & { id: string; kind: Node['kind'] }): Node => node as Node;

const docOf = (...children: Node[]): Doc => ({
  title: 'Test',
  nodes: [leaf({ id: 'sec', kind: 'section', children: [leaf({ id: 'col', kind: 'column', children })] })],
  variables: [],
});

const analysisOf = (over: Partial<Parameters<typeof reviewIssues>[1] & object> = {}) => ({
  lint: [],
  unknownVariables: [],
  ...over,
});

describe('reviewIssues', () => {
  it('turns each server lint row into one warning, keeping the server copy', () => {
    const issues = reviewIssues(docOf(), analysisOf({ lint: [{ code: 'HTML_SIZE_LARGE', severity: 'warning', count: 1, field: 'html' }] }));

    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe('warn');
    expect(issues[0]?.title).toBe('HTML lớn có thể bị cắt ở một số hộp thư.');
  });

  it('raises an unknown variable as an error, not a warning -- §2.9 makes it block publish', () => {
    const issues = reviewIssues(docOf(), analysisOf({
      unknownVariables: [{ field: 'html', key: 'ten_sep', start: 0, end: 0, classification: 'unknown', source: 'unknown', label: null, suggestedActions: ['CREATE_TEMPLATE_VARIABLE'] }],
    }));

    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe('error');
    expect(issues[0]?.title).toContain('ten_sep');
  });

  it('points IMAGE_ALT_MISSING at the first image-bearing node with no alt', () => {
    const doc = docOf(
      leaf({ id: 'img-ok', kind: 'image', src: 'https://cdn.test/a.png', alt: 'Ảnh A' }),
      leaf({ id: 'img-bad', kind: 'banner', src: 'https://cdn.test/b.png', alt: '' }),
    );

    const issues = reviewIssues(doc, analysisOf({ lint: [{ code: 'IMAGE_ALT_MISSING', severity: 'warning', count: 1, field: 'html' }] }));

    expect(issues[0]?.nodeId).toBe('img-bad');
  });

  it('leaves a row unlocatable rather than guessing when no node matches the code', () => {
    const issues = reviewIssues(docOf(), analysisOf({ lint: [{ code: 'HTML_SIZE_LARGE', severity: 'warning', count: 1, field: 'html' }] }));

    expect(issues[0]?.nodeId).toBeNull();
  });

  /**
   * ADR-051. Neither of the two new codes is a property of any single node
   * (a byte count; a defect in the SEQUENCE of heading nodes), so both stay
   * unlocatable the same way `HTML_SIZE_LARGE` does above -- pinned so the
   * `content-review.ts` switch's two new cases are actually exercised rather
   * than merely added.
   */
  it('leaves HTML_SIZE_GMAIL_CLIP and HEADING_ORDER_INVALID unlocatable too', () => {
    const doc = docOf(leaf({ id: 'h', kind: 'heading', content: 'x' }));
    const issues = reviewIssues(doc, analysisOf({
      lint: [
        { code: 'HTML_SIZE_GMAIL_CLIP', severity: 'warning', count: 1, field: 'html' },
        { code: 'HEADING_ORDER_INVALID', severity: 'warning', count: 1, field: 'html' },
      ],
    }));
    expect(issues.map((issue) => issue.nodeId)).toEqual([null, null]);
  });

  it('points an unknown variable at the node whose own text carries it', () => {
    const doc = docOf(
      leaf({ id: 'greet', kind: 'text', content: 'Chào {{ten_nhan_vien}}' }),
      leaf({ id: 'sign', kind: 'text', content: 'Ký tên: {{ten_sep}}' }),
    );

    const issues = reviewIssues(doc, analysisOf({
      unknownVariables: [{ field: 'html', key: 'ten_sep', start: 0, end: 0, classification: 'unknown', source: 'unknown', label: null, suggestedActions: [] }],
    }));

    expect(issues[0]?.nodeId).toBe('sign');
  });

  it('reports one row per unknown key, not one per occurrence of that key', () => {
    const occurrence = { field: 'html' as const, key: 'ten_sep', start: 0, end: 0, classification: 'unknown' as const, source: 'unknown' as const, label: null, suggestedActions: [] };
    const issues = reviewIssues(docOf(), analysisOf({ unknownVariables: [occurrence, { ...occurrence, start: 40, end: 50 }] }));

    expect(issues).toHaveLength(1);
  });

  it('puts errors before warnings, the order the prototype fixes them in', () => {
    const issues = reviewIssues(docOf(), analysisOf({
      lint: [{ code: 'HTML_SIZE_LARGE', severity: 'warning', count: 1, field: 'html' }],
      unknownVariables: [{ field: 'html', key: 'ten_sep', start: 0, end: 0, classification: 'unknown', source: 'unknown', label: null, suggestedActions: [] }],
    }));

    expect(issues.map((issue) => issue.level)).toEqual(['error', 'warn']);
  });
});

describe('filterReviewIssues', () => {
  const issues = reviewIssues(docOf(), analysisOf({
    lint: [{ code: 'HTML_SIZE_LARGE', severity: 'warning', count: 1, field: 'html' }],
    unknownVariables: [{ field: 'html', key: 'ten_sep', start: 0, end: 0, classification: 'unknown', source: 'unknown', label: null, suggestedActions: [] }],
  }));

  it('keeps everything under "all"', () => {
    expect(filterReviewIssues(issues, 'all')).toHaveLength(2);
  });

  it('keeps only the level asked for', () => {
    expect(filterReviewIssues(issues, 'error').map((issue) => issue.level)).toEqual(['error']);
    expect(filterReviewIssues(issues, 'warn').map((issue) => issue.level)).toEqual(['warn']);
  });
});

describe('reviewCounts', () => {
  it('counts each filter tab the way the tab itself filters', () => {
    const issues = reviewIssues(docOf(), analysisOf({
      lint: [{ code: 'HTML_SIZE_LARGE', severity: 'warning', count: 1, field: 'html' }],
      unknownVariables: [{ field: 'html', key: 'ten_sep', start: 0, end: 0, classification: 'unknown', source: 'unknown', label: null, suggestedActions: [] }],
    }));

    expect(reviewCounts(issues)).toEqual({ all: 2, error: 1, warn: 1 });
  });
});

describe('readinessPercent', () => {
  it('is full when there is nothing to fix', () => {
    expect(readinessPercent(0)).toBe(100);
  });

  it('drops 22 points per issue, the prototype\'s own arithmetic', () => {
    expect(readinessPercent(1)).toBe(78);
    expect(readinessPercent(2)).toBe(56);
  });

  it('never falls below the 18% floor, so the bar stays visible', () => {
    expect(readinessPercent(20)).toBe(18);
  });
});
