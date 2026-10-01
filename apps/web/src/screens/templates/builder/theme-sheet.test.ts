import { describe, expect, it } from 'vitest';
import { defaultTheme } from './document.js';
import { clampBaseFontSize, THEME_FONT_OPTIONS, THEME_FONT_SIZE_RANGE, THEME_WIDTHS, themePreview } from './theme-sheet.js';

/**
 * ADR-044 Task SV-2, decision 2: the theme moved out of the inspector's flat
 * field list into the prototype's own sheet (`v3-sheet` + `v3-theme-work` +
 * `v3-theme-preview`), and with it three widget swaps -- a Segment for width,
 * a 12..18 slider for base size, a four-option select for the font. The
 * numbers those widgets are built from live here so they are testable, the
 * same discipline as `workspace-shell.ts`.
 */
describe('theme-sheet (ADR-044 Task SV-2)', () => {
  it('offers exactly the three widths the prototype Segment offers', () => {
    expect(THEME_WIDTHS).toEqual([600, 640, 720]);
  });

  it('offers the prototype four font stacks, verbatim -- the stack is what reaches the email, not the name', () => {
    expect(THEME_FONT_OPTIONS.map((option) => option.value)).toEqual([
      'Arial, Helvetica, sans-serif',
      "Georgia, 'Times New Roman', serif",
      'Tahoma, Arial, sans-serif',
      "'Courier New', monospace",
    ]);
    expect(THEME_FONT_OPTIONS.map((option) => option.label)).toEqual(['Arial', 'Georgia', 'Tahoma', 'Courier New']);
  });

  it('bounds the base size slider at 12..18, like the prototype range input', () => {
    expect(THEME_FONT_SIZE_RANGE).toEqual({ min: 12, max: 18 });
  });

  it('clamps a size from outside the slider back into it rather than emitting it', () => {
    // A stored theme can hold anything the old number input accepted -- the
    // flat inspector had no bounds at all. The slider must not silently show
    // 12 while the document keeps 9.
    expect(clampBaseFontSize(9)).toBe(12);
    expect(clampBaseFontSize(40)).toBe(18);
    expect(clampBaseFontSize(14)).toBe(14);
    expect(clampBaseFontSize(13.7)).toBe(14);
    expect(clampBaseFontSize(Number.NaN)).toBe(defaultTheme.baseFontSize);
  });

  it('describes the live preview the way `v3-theme-preview` draws it', () => {
    const preview = themePreview(defaultTheme);
    expect(preview.widthLabel).toBe('640px');
    // studio.tsx: `width: theme.width / 8` px for the inner swatch, and the
    // sample glyph is 4px smaller than the base, floored at 8.
    expect(preview.swatchWidth).toBe(80);
    expect(preview.sampleFontSize).toBe(10);
    // Only the first family of the stack is shown -- "Arial, Helvetica,
    // sans-serif · 14px" would not fit the 320px panel.
    expect(preview.summary).toBe('Arial · 14px');
  });

  it('never floors the sample glyph below 8px, however small the base gets', () => {
    expect(themePreview({ ...defaultTheme, baseFontSize: 12 }).sampleFontSize).toBe(8);
  });

  it('falls back to the whole stack when it has no comma to split on', () => {
    expect(themePreview({ ...defaultTheme, fontFamily: 'Inter' }).summary).toBe('Inter · 14px');
  });
});
