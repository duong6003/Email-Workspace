import { describe, expect, it } from 'vitest';
import { columnGrow, matchingRowLayouts, ROW_LAYOUT_PRESETS } from './row-layouts.js';

// ADR-044 Task SV-3 (MC-UI-003, `v3-row-layouts`). The prototype's Inspector
// changes an existing row's column ratio to a preset without losing content
// (studio.tsx's `layoutSpecs`, filtered to presets whose column count matches
// the row's current children). Pure logic, per this codebase's own convention
// (structure-tree.ts: "web has no component-render test").

describe('ROW_LAYOUT_PRESETS', () => {
  it('has the prototype\'s six presets, in its order', () => {
    expect(ROW_LAYOUT_PRESETS.map((preset) => preset.id)).toEqual(['layout1', 'layout2', 'layout2left', 'layout2right', 'layout3', 'layout4']);
  });

  it('matches the prototype\'s widths exactly', () => {
    expect(ROW_LAYOUT_PRESETS.map((preset) => [...preset.widths])).toEqual([[100], [50, 50], [35, 65], [65, 35], [33, 34, 33], [25, 25, 25, 25]]);
  });
});

describe('matchingRowLayouts', () => {
  it('offers only the presets whose column count matches the row (a 2-column row cannot switch to a 3-column preset without losing content)', () => {
    expect(matchingRowLayouts(1).map((preset) => preset.id)).toEqual(['layout1']);
    expect(matchingRowLayouts(2).map((preset) => preset.id)).toEqual(['layout2', 'layout2left', 'layout2right']);
    expect(matchingRowLayouts(3).map((preset) => preset.id)).toEqual(['layout3']);
    expect(matchingRowLayouts(4).map((preset) => preset.id)).toEqual(['layout4']);
  });

  it('offers nothing for a column count no preset covers', () => {
    expect(matchingRowLayouts(5)).toEqual([]);
    expect(matchingRowLayouts(0)).toEqual([]);
  });
});

// The canvas half of the same feature. The presets wrote `width` into the
// document and the emitter read it (`emitter.ts:219`, `theme.width * width/100`);
// the canvas never did. Measured on the running builder: a row 535px wide
// holding two columns rendered them at 105px and 107px, and switching the row
// to 35/65 left both at 105px. The Inspector said the ratio had changed, the
// preview agreed, and the surface the author was looking at showed neither.

describe('columnGrow', () => {
  it('is the column\'s own percentage, so 35/65 renders as 35/65', () => {
    expect(columnGrow(35)).toBe(35);
    expect(columnGrow(65)).toBe(65);
  });

  it('treats a column with no stated width as full width -- the same default the emitter uses', () => {
    expect(columnGrow(undefined)).toBe(100);
  });

  it('refuses to collapse a column to nothing: a zero-width column could not be dropped into', () => {
    expect(columnGrow(0)).toBe(100);
    expect(columnGrow(-10)).toBe(100);
  });
});
