import { LINT_MESSAGE } from '../lint-messages.js';
import type { TemplateAnalysis } from '../../../api/templates.js';
import { IMAGE_BEARING_KINDS, type Doc, type Node } from './document.js';

/**
 * MC-UI-008 `run_content_review` behind the prototype's review sheet
 * (`v3-review-summary` / `v3-review-filters` / `v3-issues`), ADR-044 Task
 * SV-5.
 *
 * S4 already wired the analysis call and rendered its six lint codes as flat
 * `<p>` rows. What the prototype has and that did not is that every row is a
 * BUTTON reading "Đi tới khối và sửa →", and S8 Task 49's remaining half asks
 * for exactly that ("6 mã lint bấm-để-nhảy", §2.8). The two are the same
 * panel, so per the SV slice's governing rule -- one screen, one pass -- they
 * are done together here rather than drawn now and wired later.
 *
 * **Who decides what.** The server owns the verdict: `analysis.lint` counts
 * the emitted HTML and `analysis.unknownVariables` the merge keys, both after
 * the same sanitizer the send uses. This module owns only the ADDRESS -- which
 * node a row jumps to. Keeping those apart matters more than it looks:
 *
 * - a code this scan cannot place still produces a row, with `nodeId: null`,
 *   because hiding a warning the server raised would make the panel lie;
 * - this scan never adds a row the server did not report, so the client can
 *   never disagree with the count the publish check will use;
 * - the scan is best-effort by construction. The server lints emitted HTML;
 *   this reads the document that HTML came from. When a code fires on
 *   something the tree cannot name (a raw `<img>` inside a `customHtml`
 *   block, say), the row simply stays unlocatable instead of pointing at an
 *   innocent neighbour -- a button that jumps to the wrong block is worse
 *   than a button that is not offered.
 *
 * **Two levels, from two sources.** The contract types every lint row's
 * `severity` as the literal `'warning'`, so the prototype's error/warning
 * split cannot come from there. It comes from spec §2.9 instead: an unknown
 * variable BLOCKS publish, a lint warning does not. That is the real
 * error/warning line in this product, and it is the one the filter tabs draw.
 */

export type ReviewLevel = 'error' | 'warn';
export type ReviewFilter = 'all' | ReviewLevel;

export type ReviewIssue = {
  /** Stable across re-analysis of the same document, so React keys and e2e selectors both hold still. */
  id: string;
  level: ReviewLevel;
  title: string;
  detail: string;
  /** The node "Đi tới khối và sửa" selects. Null when this scan cannot name one -- see the file comment. */
  nodeId: string | null;
};

/** Only the two fields of `TemplateAnalysis` this module reads, so a caller can pass a stub without inventing a sanitized document. */
export type ReviewInput = Pick<TemplateAnalysis, 'lint' | 'unknownVariables'>;

type LintCode = TemplateAnalysis['lint'][number]['code'];

/** Depth-first, parents before children -- "the first offending node" then means the first one an author reading down the canvas would reach. */
function flatten(nodes: Node[]): Node[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

const LINK_BEARING_KINDS: ReadonlyArray<Node['kind']> = ['button', 'image', 'banner', 'logo'];

/** Every string on a node that can carry `{{key}}` into the emitted HTML, table cells and contact fields included. */
function textOf(node: Node): string {
  return [
    node.content, node.href, node.alt, node.caption, node.linkTitle, node.html,
    ...(node.table?.cells.flat() ?? []),
    ...(node.contact ? [node.contact.name, node.contact.role, node.contact.email, node.contact.phone, node.contact.address] : []),
    ...(node.social ?? []).flatMap((link) => [link.url, link.label ?? '']),
  ].filter((value): value is string => typeof value === 'string').join('\n');
}

/**
 * `LINK_INVALID` is the one code with no single field to look at, so the test
 * is stated positively: a target the emitter can safely turn into an `href` is
 * absolute http(s) or mailto, or is still a variable the merge will replace.
 * Anything else non-blank is what the server flagged.
 */
function isUsableTarget(href: string): boolean {
  const value = href.trim();
  if (value.startsWith('{{')) return true;
  return /^(https?:\/\/|mailto:)/i.test(value);
}

const isPlaceholder = (href: string | undefined): boolean => href?.trim() === '#';

/** Where each lint code points, or null when the document cannot name a node for it. */
function locate(code: LintCode, nodes: Node[]): string | null {
  const found = ((): Node | undefined => {
    switch (code) {
      case 'IMAGE_ALT_MISSING':
        return nodes.find((node) => IMAGE_BEARING_KINDS.includes(node.kind as (typeof IMAGE_BEARING_KINDS)[number]) && !node.decorative && Boolean(node.src) && !node.alt?.trim());
      case 'LINK_TARGET_MISSING':
        return nodes.find((node) => (LINK_BEARING_KINDS.includes(node.kind) && node.kind === 'button' && !node.href?.trim())
          || (node.social ?? []).some((link) => link.enabled && !link.url.trim()));
      case 'LINK_PLACEHOLDER':
        return nodes.find((node) => isPlaceholder(node.href) || (node.social ?? []).some((link) => link.enabled && isPlaceholder(link.url)));
      case 'LINK_INVALID':
        return nodes.find((node) => (Boolean(node.href?.trim()) && !isPlaceholder(node.href) && !isUsableTarget(node.href ?? ''))
          || (node.social ?? []).some((link) => link.enabled && Boolean(link.url.trim()) && !isPlaceholder(link.url) && !isUsableTarget(link.url)));
      // Neither is a property of any one block: the first is the whole
      // document's byte count, the second is the plain-text field beside the
      // canvas. Both stay unlocatable on purpose.
      case 'HTML_SIZE_LARGE':
      case 'TEXT_BODY_EMPTY':
      // ADR-051. Same reason: a byte count is not a node's property, and
      // Gmail's clip is the same fact as HTML_SIZE_LARGE at a lower
      // threshold.
      case 'HTML_SIZE_GMAIL_CLIP':
      // ADR-051. A heading-order defect is a property of the SEQUENCE of
      // heading nodes, not of any single one -- pointing at "the first
      // heading" would blame a node that may be entirely correct on its own
      // (e.g. the H1 that exists is fine; the H4 three blocks later that
      // skipped H2/H3 is the actual problem, and there is no single "the"
      // offending node to name).
      case 'HEADING_ORDER_INVALID':
        return undefined;
    }
  })();
  return found?.id ?? null;
}

/**
 * Errors first, then warnings -- the prototype's "Sửa mục tiếp theo" walks the
 * list from the top and reaches for `issues.find(x => x.level === "error")`
 * before falling back, so the order is the fix order, not decoration.
 */
export function reviewIssues(doc: Doc, analysis: ReviewInput | null): ReviewIssue[] {
  if (!analysis) return [];
  const nodes = flatten(doc.nodes);

  // One row per KEY, not per occurrence: the same undeclared `{{ten_sep}}`
  // written in four blocks is one thing to decide about, and four identical
  // rows would bury the other issues under it.
  const unknownKeys = [...new Set(analysis.unknownVariables.map((occurrence) => occurrence.key))];
  const errors: ReviewIssue[] = unknownKeys.map((key) => ({
    id: `unknown:${key}`,
    level: 'error',
    title: `Biến {{${key}}} chưa được khai báo.`,
    detail: 'Khai báo biến này hoặc sửa lại tên trước khi xuất bản — biến lạ chặn xuất bản (§2.9), nhưng không chặn lưu nháp.',
    nodeId: nodes.find((node) => textOf(node).includes(`{{${key}}}`))?.id ?? null,
  }));

  const warnings: ReviewIssue[] = analysis.lint.map((issue) => ({
    id: `lint:${issue.code}:${issue.field}`,
    level: 'warn',
    title: LINT_MESSAGE[issue.code](issue.count),
    detail: issue.field === 'textBody' ? 'Nằm ở ô “Văn bản thuần” bên dưới tên template.' : 'Nằm trong nội dung HTML của email.',
    nodeId: locate(issue.code, nodes),
  }));

  return [...errors, ...warnings];
}

export function filterReviewIssues(issues: ReviewIssue[], filter: ReviewFilter): ReviewIssue[] {
  return filter === 'all' ? issues : issues.filter((issue) => issue.level === filter);
}

export function reviewCounts(issues: ReviewIssue[]): Record<ReviewFilter, number> {
  return {
    all: issues.length,
    error: issues.filter((issue) => issue.level === 'error').length,
    warn: issues.filter((issue) => issue.level === 'warn').length,
  };
}

/**
 * The readiness bar's width, `Math.max(18, 100 - issues.length * 22)` in the
 * prototype. The 18% floor is deliberate there: a bar that reaches zero reads
 * as "no data" rather than "a lot to fix", so the worst case still shows a
 * stub of colour.
 */
export function readinessPercent(issueCount: number): number {
  return Math.max(18, 100 - issueCount * 22);
}
