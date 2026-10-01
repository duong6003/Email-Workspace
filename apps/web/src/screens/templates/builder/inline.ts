import type { InlineMark, InlineMarkKind } from './document.js';

/**
 * ADR-046 -- inline rich text for `text` and `heading`, as MARKED RANGES over
 * `Node.content` rather than a second copy of the author's words.
 *
 * The whole file is pure (spec §2.1: web has no component-render tests, so
 * anything that is not a pure function is not testable), and it is deliberately
 * the ONE place that knows how a mark becomes markup. `emitter.ts` renders these
 * segments as HTML for the email and `BuilderScreen` renders the same segments
 * as React elements for the canvas -- the drift that commit `2c23073` shipped,
 * where a capability was added to the emitter and the canvas was left behind,
 * is only preventable if both sides read one function.
 *
 * Why ranges and not the prototype's `InlineNode[]` tree (ADR-046 decision 1):
 * `content` is a string that seven other places already read -- variable
 * insertion by caret offset, the preheader's 110-character meter,
 * `content-review.ts`, `publish-readiness.ts`, the canvas variable chips, the
 * plain-text body, the structure tree. A tree makes a second copy of the text
 * beside `content`, and the prototype demonstrates the cost: its `parameterize`
 * (studio.tsx:636) rewrites `content` and leaves `inline` stale, so
 * `inlineHtml` -- which prefers `inline` -- renders the words the user just
 * replaced. Marks annotate the one string instead of duplicating it.
 */

/**
 * Fixed nesting order, so the same set of marks always produces the same tags
 * regardless of which button the author pressed first.
 *
 * Determinism is not tidiness here: the sanitizer REORDERS crossed tags
 * (measured, ADR-046 §Context -- `<b>a<em>b</b>c</em>` comes back as
 * `<b>a<em>b</em></b>c`), so an emitter that produced unbalanced nesting would
 * have its stored output differ from the string it wrote, and the canvas would
 * disagree with the mail for reasons no one could see.
 */
export const INLINE_MARK_ORDER: readonly InlineMarkKind[] = ['link', 'strong', 'em', 'underline'];

/** One run of characters carrying exactly one set of marks. Adjacent runs with the same set are already merged. */
export type InlineSegment = { text: string; marks: InlineMarkKind[]; href?: string };

/**
 * The ONE mapping from a mark to the element that carries it -- ADR-046
 * decision 2's closed set of four, in the one place both renderers read.
 *
 * `emitter.ts` writes these as tag strings for the mail and `BuilderScreen`
 * passes them to `createElement` for the canvas. Two copies of this map is
 * precisely how commit `2c23073` shipped a capability that changed the email
 * and left the canvas identical, and `canvas-style.test.ts` asserts the two
 * sides agree element for element.
 */
export const INLINE_TAG_NAME: Record<InlineMarkKind, 'strong' | 'em' | 'u' | 'a'> = {
  strong: 'strong',
  em: 'em',
  underline: 'u',
  link: 'a',
};

/** The element names a segment is wrapped in, outermost first. Pure, so the emitter and the canvas can be compared without rendering either. */
export function segmentTagNames(segment: InlineSegment): string[] {
  return segment.marks.map((kind) => INLINE_TAG_NAME[kind]);
}

const orderOf = (kind: InlineMarkKind): number => INLINE_MARK_ORDER.indexOf(kind);

/**
 * Drops what can never render and clamps what can: a mark outside the text, a
 * zero-width mark, a `link` with no destination.
 *
 * Rejecting here rather than at emit time is ADR-046 decision 5: the emitter
 * should never be handed a range it has to decide about, and the canvas must
 * make the same decision without repeating the rule.
 */
export function normalizeInlineMarks(marks: readonly InlineMark[] | undefined, textLength: number): InlineMark[] {
  if (!marks?.length || textLength <= 0) return [];
  const cleaned: InlineMark[] = [];
  for (const mark of marks) {
    if (!INLINE_MARK_ORDER.includes(mark.kind)) continue;
    const start = Math.max(0, Math.min(Math.trunc(mark.start), textLength));
    const end = Math.max(0, Math.min(Math.trunc(mark.end), textLength));
    if (!(end > start)) continue;
    // A `link` whose href did not survive `safeUrl` is not a link. It is dropped
    // as a MARK, which leaves the words in place -- the same trade `emitButton`
    // makes when a button's href is rejected: lose the destination, keep the
    // sentence.
    if (mark.kind === 'link' && !mark.href?.trim()) continue;
    cleaned.push(mark.kind === 'link' ? { start, end, kind: 'link', href: mark.href } : { start, end, kind: mark.kind });
  }
  return cleaned.sort((left, right) => left.start - right.start || left.end - right.end || orderOf(left.kind) - orderOf(right.kind));
}

/**
 * `content` + marks -> non-overlapping runs, in document order.
 *
 * Overlap is normal author behaviour (bold "abc", then italic "bcd") and HTML
 * has no way to express crossed tags, so the ranges are cut at every boundary
 * and each resulting run carries the SET of marks covering it. That turns an
 * arbitrary overlap into properly nested tags without asking the author to care.
 *
 * Runs with an identical signature are merged back together, so a document that
 * happens to have two abutting ranges of the same kind emits one pair of tags
 * rather than two. Gmail clips at 102KB; a redundant `</strong><strong>` is
 * bytes spent to say nothing.
 */
export function inlineSegments(content: string, marks: readonly InlineMark[] | undefined): InlineSegment[] {
  const text = content ?? '';
  const normalized = normalizeInlineMarks(marks, text.length);
  if (!text) return [];
  if (normalized.length === 0) return [{ text, marks: [] }];

  const boundaries = new Set<number>([0, text.length]);
  for (const mark of normalized) { boundaries.add(mark.start); boundaries.add(mark.end); }
  const cuts = [...boundaries].sort((left, right) => left - right);

  const runs: InlineSegment[] = [];
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const from = cuts[index]!;
    const to = cuts[index + 1]!;
    if (to <= from) continue;
    const covering = normalized.filter((mark) => mark.start <= from && mark.end >= to);
    const kinds = [...new Set(covering.map((mark) => mark.kind))].sort((left, right) => orderOf(left) - orderOf(right));
    // The innermost link wins when two overlap -- last one applied, which is
    // what an author who just clicked the button expects to see.
    const href = covering.filter((mark) => mark.kind === 'link').at(-1)?.href;
    runs.push(href ? { text: text.slice(from, to), marks: kinds, href } : { text: text.slice(from, to), marks: kinds });
  }

  const signature = (segment: InlineSegment): string => `${segment.marks.join(',')}|${segment.href ?? ''}`;
  const merged: InlineSegment[] = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (previous && signature(previous) === signature(run)) previous.text += run.text;
    else merged.push({ ...run });
  }
  return merged;
}

/** Whether every character of `[start, end)` already carries `kind` -- the question a toggle button has to answer before it knows which way it points. */
export function inlineMarkCovers(marks: readonly InlineMark[] | undefined, textLength: number, start: number, end: number, kind: InlineMarkKind): boolean {
  if (!(end > start)) return false;
  const covering = normalizeInlineMarks(marks, textLength).filter((mark) => mark.kind === kind);
  if (covering.length === 0) return false;
  let reached = start;
  for (const mark of covering.sort((left, right) => left.start - right.start)) {
    if (mark.start > reached) break;
    reached = Math.max(reached, mark.end);
    if (reached >= end) return true;
  }
  return false;
}

/** Removes `kind` from `[start, end)`, splitting any mark that straddles a boundary. */
function withoutMarkIn(marks: readonly InlineMark[], start: number, end: number, kind: InlineMarkKind): InlineMark[] {
  const out: InlineMark[] = [];
  for (const mark of marks) {
    if (mark.kind !== kind || mark.end <= start || mark.start >= end) { out.push(mark); continue; }
    if (mark.start < start) out.push({ ...mark, end: start });
    if (mark.end > end) out.push({ ...mark, start: end });
  }
  return out;
}

/**
 * The one write path: apply or remove `kind` over the selection.
 *
 * Applying when the selection is already fully covered REMOVES instead -- the
 * behaviour of every editor's bold button, and the reason the same button can
 * report state and change it.
 */
export function toggleInlineMark(
  marks: readonly InlineMark[] | undefined,
  textLength: number,
  start: number,
  end: number,
  kind: InlineMarkKind,
  href?: string,
): InlineMark[] {
  const current = normalizeInlineMarks(marks, textLength);
  const from = Math.max(0, Math.min(start, textLength));
  const to = Math.max(0, Math.min(end, textLength));
  if (!(to > from)) return current;

  if (kind === 'link') {
    // A link always replaces whatever destination was there: two overlapping
    // hrefs over one word is a state the author cannot see or resolve.
    const stripped = withoutMarkIn(current, from, to, 'link');
    if (!href?.trim()) return normalizeInlineMarks(stripped, textLength);
    return normalizeInlineMarks([...stripped, { start: from, end: to, kind: 'link', href }], textLength);
  }

  if (inlineMarkCovers(current, textLength, from, to, kind)) {
    return normalizeInlineMarks(withoutMarkIn(current, from, to, kind), textLength);
  }
  return normalizeInlineMarks([...current, { start: from, end: to, kind }], textLength);
}

/**
 * Moves marks when `content` changes, so formatting stays on the words it was
 * put on.
 *
 * ADR-046 §Consequences calls this the most fragile part of the decision, and
 * it is: get it wrong and the bold slides onto a different word, silently, and
 * only the canvas shows it. `[start, end)` is the replaced span and `inserted`
 * is the length of what replaced it -- the same shape `insertTemplateVariable`
 * produces when it drops `{{key}}` over a selection.
 *
 * Text typed at EITHER boundary stays outside the mark; only text typed
 * strictly inside grows it. Formatting then covers exactly the characters the
 * author selected, and never spreads on its own.
 *
 * The asymmetric convention (a mark grows at one edge) is what a caret-based
 * editor uses, because a caret inherits the formatting of the character before
 * it. There is no such caret here: ADR-046 decision 4 keeps editing in the
 * inspector's `<textarea>`, where the author cannot see the formatting they
 * would be inheriting. Inheriting invisibly is worse than not inheriting -- and
 * this was measured the hard way, by a test that composed `diffEdit` with this
 * function and found a bold range eating the word typed in front of it.
 */
export function shiftInlineMarks(marks: readonly InlineMark[] | undefined, start: number, end: number, inserted: number, nextTextLength: number): InlineMark[] {
  if (!marks?.length) return [];
  const delta = inserted - (end - start);
  // A mark's start is pushed past anything inserted at it; its end is not.
  const moveStart = (offset: number): number => (offset < start ? offset : offset >= end ? offset + delta : start + inserted);
  const moveEnd = (offset: number): number => (offset <= start ? offset : offset >= end ? offset + delta : start);
  return normalizeInlineMarks(marks.map((mark) => ({ ...mark, start: moveStart(mark.start), end: moveEnd(mark.end) })), nextTextLength);
}

/**
 * The single edit that turns `before` into `after`, as the span it replaced and
 * the length of what replaced it.
 *
 * A `<textarea>` reports its new value, not what changed, so this recovers the
 * edit by matching the common prefix and suffix. That is exact for the way
 * people actually edit -- type, delete, paste, insert a `{{variable}}` over a
 * selection -- and for anything stranger it degrades to "the whole middle was
 * replaced", which moves marks conservatively rather than wrongly.
 */
export function diffEdit(before: string, after: string): { start: number; end: number; inserted: number } {
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return { start: prefix, end: before.length - suffix, inserted: after.length - suffix - prefix };
}
