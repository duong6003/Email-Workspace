import { defaultTheme, type EmailTheme } from './document.js';

/**
 * The numbers behind MC-UI-007's theme sheet (ADR-044 Task SV-2, decision 2).
 *
 * S4 put the theme in the inspector as six generic fields. `studio.tsx` puts
 * it in `v3-sheet` with widgets chosen per field: a Segment for the three
 * widths, a 12..18 slider for the base size, a four-option select for the
 * font, and a live `v3-theme-preview` swatch beside them. Decision 2 chose the
 * prototype's version, so the values those widgets are built from move here --
 * `BuilderScreen.tsx` has no render test (spec §2.1), and a hard-coded `720`
 * in JSX is a number nothing can check.
 *
 * `defaultTheme` itself is untouched: it already matches the prototype's
 * byte for byte (measured 2026-09-04), which is why the sheet can be swapped
 * in without migrating a single stored document.
 */

/** The Segment's three values. Same triple as `EmailTheme['width']`, which is what makes the Segment total. */
export const THEME_WIDTHS: ReadonlyArray<EmailTheme['width']> = [600, 640, 720];

/**
 * The prototype's four `<option>`s, stacks verbatim. The stack is the part
 * that reaches the email -- a client that lacks Georgia falls through to
 * Times New Roman -- so shortening it to the display name would change what
 * recipients see, not just what the select reads.
 */
export const THEME_FONT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { value: "Georgia, 'Times New Roman', serif", label: 'Georgia' },
  { value: 'Tahoma, Arial, sans-serif', label: 'Tahoma' },
  { value: "'Courier New', monospace", label: 'Courier New' },
];

/** `<input type="range" min="12" max="18">` in the prototype. */
export const THEME_FONT_SIZE_RANGE = { min: 12, max: 18 } as const;

/**
 * S4's inspector used an unbounded number input, so a stored theme can hold a
 * size the slider cannot represent. Showing 12 while the document keeps 9
 * would be a control that lies about the email -- clamp instead, and let the
 * next edit write the clamped value back.
 */
export function clampBaseFontSize(size: number): number {
  if (!Number.isFinite(size)) return defaultTheme.baseFontSize;
  return Math.min(THEME_FONT_SIZE_RANGE.max, Math.max(THEME_FONT_SIZE_RANGE.min, Math.round(size)));
}

export type ThemePreview = {
  widthLabel: string;
  /** Width of the inner content swatch in `v3-theme-preview`: the email width at 1/8 scale, as the prototype draws it. */
  swatchWidth: number;
  /** The "Aa" glyph size: 4px under the base, never below 8. */
  sampleFontSize: number;
  summary: string;
};

/** What `v3-theme-preview` shows: a scaled swatch of the email plus one line naming the width, family and size. */
export function themePreview(theme: EmailTheme): ThemePreview {
  const size = clampBaseFontSize(theme.baseFontSize);
  return {
    widthLabel: `${theme.width}px`,
    swatchWidth: theme.width / 8,
    sampleFontSize: Math.max(8, size - 4),
    // Only the first family: "Arial, Helvetica, sans-serif · 14px" does not
    // fit the sheet's preview line, and the fallbacks say nothing a reader
    // choosing a font needs.
    summary: `${theme.fontFamily.split(',')[0]!.trim()} · ${size}px`,
  };
}
