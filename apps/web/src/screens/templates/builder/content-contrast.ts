import type { Node } from './document.js';

/**
 * ADR-051. WCAG AA colour contrast, checked against the document TREE rather
 * than emitted HTML -- the same reasoning `publish-readiness.ts`'s
 * `hasPostalAddress` gives for ADR-050: a node's effective background is
 * whatever its nearest ancestor declared (`emitColumn`/`emitSection` write
 * `background-color` on the container, `emitText`/`emitContact`/`emitFooter`/
 * `emitList` write only `color` on the leaf), and following that chain
 * through arbitrary HTML with a regex is not reliable the way `href=`/`alt=`
 * matching is for the other lint codes. The tree already has the chain.
 *
 * The relative-luminance/contrast-ratio formula is WCAG's own (2.1 §1.4.3),
 * and it is not new to this repo -- it is duplicated three times already in
 * `apps/web/e2e/mailcraft-contrast-both-themes.spec.ts` and
 * `mailcraft-dark-mode-completion.spec.ts`, to audit the BUILDER APP's own UI
 * chrome in light/dark theme. Those three stay as they are: they run inside
 * Playwright's `page.evaluate()`, a sandbox that cannot import a repo module,
 * and they are answering a different question (does the app's own chrome
 * stay legible) from this one (does an AUTHOR'S colour choice stay legible
 * inside the email). This is a fourth copy of the same public formula, not a
 * refactor of the other three.
 */
function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = match[1]!;
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  const [rl, gl, bl] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/** `null` when either colour is not a plain hex value (e.g. unset, or something a future field shape lets through) -- nothing to compare, so the caller treats it as "not a problem" rather than guessing. */
export function contrastRatio(hexA: string, hexB: string): number | null {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return null;
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * WCAG 2.1 §1.4.3's own threshold split: 3:1 for "large" text (>=24px, or
 * >=18.66px/~14pt when bold), 4.5:1 for everything else. `emitFooter`'s
 * default is 12px -- deliberately small print, and exactly the size a low
 * threshold would let slip through if this used one number for everything.
 */
function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
}

/**
 * The kinds whose emitted `<p>`/`<h*>`/`<ul>` writes `color` on itself and
 * nothing else -- i.e. the kinds `effectiveFontSize`/`effectiveFontWeight`
 * below can answer for from the emitter's own defaulting rules alone.
 *
 * `button` (colour depends on `buttonVariant`, not a plain `color:`
 * declaration), `table` (per-cell colours, header vs. body), `social` (icon
 * colour, not body text) and `logo` (a wordmark, not prose) are deliberately
 * NOT here -- each resolves colour by a different rule than "textColor over
 * inherited background", and folding them in would need that rule modelled
 * too. Left as future work, not silently skipped: see the ADR.
 */
const CONTRAST_TEXT_KINDS: ReadonlySet<Node['kind']> = new Set(['text', 'heading', 'list', 'contact', 'footer']);

function effectiveFontSize(n: Node): number {
  if (n.fontSize) return n.fontSize;
  if (n.kind === 'heading') return 28;
  if (n.kind === 'footer') return 12;
  return 14;
}

function effectiveFontWeight(n: Node): number {
  if (n.fontWeight) return n.fontWeight;
  return n.kind === 'heading' ? 700 : 400;
}

/**
 * `true` when there is nothing to flag -- either the author never overrode
 * the default ink (ADR-047 already vetted that against the palette this
 * product ships), the colour value is not plain hex, or the ratio clears the
 * size-appropriate WCAG threshold.
 */
function meetsContrast(n: Node, background: string): boolean {
  if (!n.textColor) return true;
  const ratio = contrastRatio(n.textColor, background);
  if (ratio === null) return true;
  return ratio >= (isLargeText(effectiveFontSize(n), effectiveFontWeight(n)) ? 3 : 4.5);
}

/** For the inspector's real-time warning (beside the `textColor` field) -- one node, one already-resolved background. */
export function nodeLowContrast(node: Node, background: string): boolean {
  return CONTRAST_TEXT_KINDS.has(node.kind) && !meetsContrast(node, background);
}

/**
 * For the publish-readiness sheet -- every low-contrast node's id, walking
 * the WHOLE tree with the background each node actually inherits.
 * `node.visible === false` is excluded for the same reason `hasPostalAddress`
 * excludes it: a hidden block never reaches the recipient, so it cannot make
 * the email harder to read.
 */
export function lowContrastNodeIds(nodes: readonly Node[], defaultBackground: string, inherited: string = defaultBackground): string[] {
  const found: string[] = [];
  for (const node of nodes) {
    if (node.visible === false) continue;
    const background = node.background ?? inherited;
    if (nodeLowContrast(node, background)) found.push(node.id);
    found.push(...lowContrastNodeIds(node.children ?? [], defaultBackground, background));
  }
  return found;
}
