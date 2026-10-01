export type AnalysisRange = { start: number; end: number; key: string };
export type EditorRange = { from: number; to: number; key: string };

/**
 * The analysis that produced these offsets ran against an earlier snapshot of
 * the document — the user keeps typing while the request is in flight. A stale
 * offset must never throw and must never mark the wrong text: ranges that no
 * longer fit are dropped, ranges that overrun the end are clamped.
 */
export function toEditorRanges(document: string, ranges: readonly AnalysisRange[]): EditorRange[] {
  return ranges
    .filter((range) => range.start >= 0 && range.start < document.length && range.end > range.start)
    .map((range) => ({ from: range.start, to: Math.min(range.end, document.length), key: range.key }))
    .filter((range) => range.to > range.from)
    .sort((left, right) => left.from - right.from);
}
