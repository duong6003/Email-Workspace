/**
 * ADR-044 (Task SV-3, MC-UI-003). Ported from `studio.tsx`'s `layoutSpecs`:
 * the six column-ratio presets the Inspector offers for a selected `row`, so
 * the author can switch "50/50" to "35/65" without rebuilding the row and
 * losing whatever is already in its columns.
 */
/** `icon` is the glyph studio.tsx's palette shows for this shape; the Inspector's ratio tiles draw the widths instead and ignore it. */
export type RowLayoutPreset = { id: string; widths: readonly number[]; label: string; icon: string };

export const ROW_LAYOUT_PRESETS: readonly RowLayoutPreset[] = [
  { id: 'layout1', widths: [100], label: 'Một cột', icon: '▭' },
  { id: 'layout2', widths: [50, 50], label: 'Hai cột đều', icon: '▥' },
  { id: 'layout2left', widths: [35, 65], label: 'Trái hẹp · phải rộng', icon: '▯▭' },
  { id: 'layout2right', widths: [65, 35], label: 'Trái rộng · phải hẹp', icon: '▭▯' },
  { id: 'layout3', widths: [33, 34, 33], label: 'Ba cột đều', icon: '▦' },
  { id: 'layout4', widths: [25, 25, 25, 25], label: 'Bốn cột', icon: '▥▥' },
];

/** Only presets that fit the row's current column count -- switching ratio must never add or drop a column, or the content in it would go with it. */
export function matchingRowLayouts(columnCount: number): readonly RowLayoutPreset[] {
  return ROW_LAYOUT_PRESETS.filter((preset) => preset.widths.length === columnCount);
}

/** Whether a row's current column widths already match a preset -- drives the "active" tile in the Inspector. */
export function isActiveRowLayout(preset: RowLayoutPreset, columnWidths: readonly (number | undefined)[]): boolean {
  return preset.widths.length === columnWidths.length && preset.widths.every((width, index) => (columnWidths[index] ?? 0) === width);
}

/**
 * A column's share of its row on the canvas, as a `flex-grow` against a zero
 * basis -- which is what makes the ratio exact instead of content-dependent.
 *
 * Before this the canvas had no share at all. `.v3-row` carries the
 * prototype's `grid-auto-flow:column`, but the columns are not its grid items:
 * `CanvasNodeView` wraps every container's children in `.builder-node-children`,
 * so the grid saw ONE item (that wrapper) and the columns inside it were plain
 * flex children with no basis -- meaning each one shrank to the width of its own
 * content. Measured on the running builder: a 535px row, two columns, 105px and
 * 107px, three fifths of the row left blank. That is the gap in the screenshot.
 *
 * `100` for a column that states no width, matching the emitter's own
 * `n.width ?? 100`; a width of zero or less would collapse the column to a line
 * nothing could be dropped into, so it gets the same treatment.
 */
export function columnGrow(width: number | undefined): number {
  return width === undefined || width <= 0 ? 100 : width;
}
