import { describe, expect, it } from 'vitest';
import { KINDS, type Node } from './document.js';
import { imageAltMissing, inspectorFieldsForNode } from './inspector-fields.js';

/**
 * Keys no inspector field may ever offer, because the sanitizer really does
 * strip the property behind them and a control whose result vanishes is the
 * defect ADR-037 §1 named.
 *
 * `letterSpacing`/`textTransform`/`boxShadow`/`backgroundImage` were in this
 * list until 2026-09-10 and should not have been past 2026-09-02: ADR-042
 * allowlisted all four, and its Context says outright that removing a control
 * to dodge the sanitizer is the mistake to avoid. This assertion was the FOURTH
 * place repeating that expired reason -- and the only one with teeth, because a
 * test does not merely describe the bug, it holds it in place. Building the
 * controls meant deleting the very guard that forbade them.
 *
 * `opacity` stays: ADR-040 excluded it deliberately (a redundant second way to
 * hide), so it is still a property the emitter must not produce.
 *
 * The two below it are the shapes ADR-042 did NOT open, and they matter as much
 * as the four it did: `boxShadowInset` because ADR-042 §Consequences puts
 * `box-shadow:inset` outside its scope, and `backgroundImageUrl` because the
 * gradient grammar admits no `url(` anywhere.
 */
const BANNED_KEYS = ['opacity', 'float', 'position', 'boxShadowInset', 'backgroundImageUrl'];

describe('inspectorFieldsForNode (S4 Task 18)', () => {
  it('gives Section padding, background, border, and 4-corner radius fields', () => {
    const keys = inspectorFieldsForNode({ id: 's', kind: 'section', visible: true }).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining([
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'background', 'borderColor', 'borderWidth',
      'radiusTopLeft', 'radiusTopRight', 'radiusBottomRight', 'radiusBottomLeft',
    ]));
  });

  /** ADR-052: Column gets exactly one field Section does not -- `width`, COLUMN-only per `document.ts`'s own doc comment on the field (Section has no use for its own share of the row). */
  it('gives Column the same field shape as Section, plus its own width', () => {
    const sectionKeys = inspectorFieldsForNode({ id: 's', kind: 'section', visible: true }).map((f) => f.key).sort();
    const columnKeys = inspectorFieldsForNode({ id: 'c', kind: 'column', visible: true }).map((f) => f.key).sort();
    expect(columnKeys).toEqual([...sectionKeys, 'width'].sort());
  });

  it('gives Heading a level field that Text does not have', () => {
    const headingKeys = inspectorFieldsForNode({ id: 'h', kind: 'heading', visible: true }).map((f) => f.key);
    const textKeys = inspectorFieldsForNode({ id: 't', kind: 'text', visible: true }).map((f) => f.key);
    expect(headingKeys).toContain('headingLevel');
    expect(textKeys).not.toContain('headingLevel');
    expect(textKeys).toContain('content');
  });

  it('gives Button label, URL, and size fields -- variant/shape are the bespoke v3-presets/v3-shapes picker (ADR-044 Task SV-3), not generic fields', () => {
    const keys = inspectorFieldsForNode({ id: 'b', kind: 'button', visible: true }).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['content', 'href', 'align', 'buttonSize', 'accent', 'textColor']));
    expect(keys).not.toContain('buttonVariant');
    expect(keys).not.toContain('radius');
  });

  it('gives Image a URL field typed as url, plus alt/width/link/radius', () => {
    const fields = inspectorFieldsForNode({ id: 'i', kind: 'image', visible: true });
    const src = fields.find((f) => f.key === 'src');
    expect(src?.type).toBe('url');
    expect(fields.map((f) => f.key)).toEqual(expect.arrayContaining(['alt', 'maxWidth', 'align', 'href', 'radius']));
  });

  it('gives Divider thickness, color, and top/bottom spacing', () => {
    const keys = inspectorFieldsForNode({ id: 'd', kind: 'divider', visible: true }).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['height', 'accent', 'paddingTop', 'paddingBottom']));
  });

  it('gives Spacer only a height field', () => {
    const keys = inspectorFieldsForNode({ id: 'sp', kind: 'spacer', visible: true }).map((f) => f.key);
    expect(keys).toEqual(['height']);
  });

  it('never generates a field for a property the sanitizer really does strip', () => {
    const kinds: Array<'section' | 'column' | 'heading' | 'text' | 'button' | 'image' | 'divider' | 'spacer' | 'row' | 'logo' | 'banner' | 'table' | 'social' | 'preheader'> =
      ['section', 'column', 'heading', 'text', 'button', 'image', 'divider', 'spacer', 'row', 'logo', 'banner', 'table', 'social', 'preheader'];
    for (const kind of kinds) {
      const keys = inspectorFieldsForNode({ id: 'x', kind, visible: true }).map((f) => f.key);
      for (const banned of BANNED_KEYS) expect(keys).not.toContain(banned);
    }
  });

  /**
   * The other half of the assertion above, and the one that would have caught
   * the eight-day gap: ADR-042 opened these four so the controls could exist,
   * so their ABSENCE is now the regression. Text and Heading take the two
   * typography ones here; the two surface ones are Section/Column's and live in
   * `SurfacePicker` (BuilderScreen) because the prototype draws them as tiles,
   * which is why they are asserted by `ARCH-MAILCRAFT-DOM` instead.
   */
  it('offers the two ADR-042 typography controls on text and heading', () => {
    for (const kind of ['text', 'heading'] as const) {
      const keys = inspectorFieldsForNode({ id: 'x', kind, visible: true }).map((f) => f.key);
      expect(keys).toContain('letterSpacing');
      expect(keys).toContain('textTransform');
    }
  });

  it('offers only the three case options the prototype draws', () => {
    const field = inspectorFieldsForNode({ id: 'x', kind: 'text', visible: true }).find((f) => f.key === 'textTransform');
    expect(field?.options?.map((option) => option.value)).toEqual(['none', 'uppercase', 'lowercase']);
    // the sanitizer accepts `capitalize`; ADR-044 makes the prototype the source of visual truth
    expect(field?.options?.map((option) => option.value)).not.toContain('capitalize');
  });

  /**
   * This test used to read "returns no fields for a Row (structural only --
   * nothing on it survives to HTML)" and assert `[]`. Its reason expired on
   * 2026-09-11, when `Node.stackMobile` stopped being an inert field and
   * started deciding whether `emitColumn` writes `width:100%` or a fixed pixel
   * width. Something on a Row does survive to HTML now.
   *
   * That is the THIRD time in this file's history that a green test held a gap
   * open by encoding a reason nobody re-read -- see the header comment for the
   * first two. Replacing it with `[]`-plus-an-exception would have kept the
   * habit; asserting what a Row actually offers, and why, does not.
   */
  it('gives a Row exactly one field: the per-row stacking rule that reaches the HTML', () => {
    const fields = inspectorFieldsForNode({ id: 'r', kind: 'row', visible: true });
    expect(fields.map((f) => f.key)).toEqual(['stackMobile']);
    expect(fields[0]?.type).toBe('checkbox');
    // "Nâng cao", beside the document-wide `stackColumns` it overrides -- a
    // responsive rule is neither content nor appearance.
    expect(fields[0]?.tab).toBe('advanced');
  });

  it('still keeps the ratio picker off this list, because RowLayoutPicker draws it', () => {
    expect(inspectorFieldsForNode({ id: 'r', kind: 'row', visible: true }).map((f) => f.key)).not.toContain('children');
  });

  // S4 Task 18: the five kinds added to the launch catalog.
  it('gives Logo a URL, alt, fallback text, height, alignment, and link', () => {
    const keys = inspectorFieldsForNode({ id: 'l', kind: 'logo', visible: true }).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['src', 'alt', 'content', 'height', 'align', 'href']));
  });

  it('gives Banner a URL, alt, link, and radius -- no width control (the emitter always renders it 100%)', () => {
    const keys = inspectorFieldsForNode({ id: 'b', kind: 'banner', visible: true }).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['src', 'alt', 'href', 'radius']));
    expect(keys).not.toContain('maxWidth');
  });

  it('gives Social only the scalar fields -- the link list itself is bespoke UI in BuilderScreen, not a generic field', () => {
    const keys = inspectorFieldsForNode({ id: 's', kind: 'social', visible: true }).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['align', 'accent']));
    expect(keys).not.toContain('social');
  });

  it('gives Table no generic fields -- its whole surface (settings + cell grid) is bespoke UI', () => {
    expect(inspectorFieldsForNode({ id: 't', kind: 'table', visible: true })).toEqual([]);
  });

  it('gives Preheader a single content field', () => {
    const keys = inspectorFieldsForNode({ id: 'p', kind: 'preheader', visible: true }).map((f) => f.key);
    expect(keys).toEqual(['content']);
  });

  // S4 Task 20 (MC-UI-011): the CodeMirror editor + validate/preview controls are bespoke in
  // BuilderScreen (reusing TemplateCodeView), same reason table/social are bespoke -- there is
  // no InspectorFieldType shape for "sanitized-HTML code editor with a validation report".
  it('gives customHtml no generic fields -- its whole surface is bespoke UI', () => {
    expect(inspectorFieldsForNode({ id: 'ch', kind: 'customHtml', visible: true })).toEqual([]);
  });
});

/**
 * Every checkbox states its own unwritten value. Hardcoding one default in the
 * renderer shipped `ordered` inverted -- a new list showed a ticked box and
 * clicking it wrote `false`, so the control appeared dead. Unit tests were all
 * green; it was found by clicking in the running app.
 */
describe('checkbox defaults (InspectorField.defaultOn)', () => {
  const fieldFor = (kind: Node['kind'], key: string) =>
    inspectorFieldsForNode({ id: 'x', kind, visible: true }).find((f) => f.key === key);

  it('defaults an unset stackMobile to ON, because unset has always meant "stack"', () => {
    expect(fieldFor('row', 'stackMobile')?.defaultOn).toBe(true);
  });

  it('defaults an unset ordered to OFF, because a new list is bulleted', () => {
    const field = fieldFor('list', 'ordered');
    expect(field).toBeDefined();
    expect(field?.defaultOn ?? false).toBe(false);
  });

  it('leaves every checkbox with an explicit answer, so no field inherits a guess', () => {
    for (const kind of KINDS) {
      for (const field of inspectorFieldsForNode({ id: 'x', kind, visible: true })) {
        if (field.type !== 'checkbox') continue;
        expect(
          field.defaultOn === true || field.defaultOn === false || field.defaultOn === undefined,
          `${kind}.${field.key} must state defaultOn (undefined reads as off -- say so on purpose)`,
        ).toBe(true);
      }
    }
  });
});

describe('imageAltMissing (S4 Task 18: IMAGE_ALT_MISSING warning)', () => {
  it('flags an image with no alt text', () => {
    expect(imageAltMissing({ id: 'i', kind: 'image', visible: true, alt: '' })).toBe(true);
    expect(imageAltMissing({ id: 'i', kind: 'image', visible: true })).toBe(true);
  });

  it('does not flag an image that has alt text', () => {
    expect(imageAltMissing({ id: 'i', kind: 'image', visible: true, alt: 'Ảnh minh hoạ' })).toBe(false);
  });

  /** S6 Task 39 (ADR-043 §8). A decorative image has an empty alt on purpose, and the emitter says so with `role="presentation"`. Warning here would tell someone to undo what they just deliberately did -- and would disagree with the server lint Task 40 teaches the same rule. */
  it('does not flag a decorative image, whose alt is empty on purpose', () => {
    expect(imageAltMissing({ id: 'i', kind: 'image', visible: true, alt: '', decorative: true })).toBe(false);
    expect(imageAltMissing({ id: 'i', kind: 'image', visible: true, decorative: true })).toBe(false);
  });

  it('flags it again the moment the decorative mark comes off', () => {
    expect(imageAltMissing({ id: 'i', kind: 'image', visible: true, alt: '', decorative: false })).toBe(true);
  });

  /**
   * Measured 2026-09-10, fixed 2026-09-11. The check used to be
   * `kind === 'image'`, while the server lint scans every `<img>` the emitter
   * produces -- so these two kinds failed the lint without ever showing the
   * warning that exists to prevent it.
   */
  it('flags a banner and a logo too, because the server lint scans every <img>', () => {
    expect(imageAltMissing({ id: 'b', kind: 'banner', visible: true, src: 'https://cdn.test/b.png' })).toBe(true);
    expect(imageAltMissing({ id: 'l', kind: 'logo', visible: true, src: 'https://cdn.test/l.png' })).toBe(true);
  });

  it('leaves a banner and a logo alone once they are described, or marked decorative', () => {
    expect(imageAltMissing({ id: 'b', kind: 'banner', visible: true, alt: 'Banner khuyến mãi' })).toBe(false);
    expect(imageAltMissing({ id: 'l', kind: 'logo', visible: true, decorative: true })).toBe(false);
  });

  it('does not flag a non-image node', () => {
    expect(imageAltMissing({ id: 't', kind: 'text', visible: true })).toBe(false);
  });
});

/**
 * ADR-044 Task SV-2. The prototype's inspector is three tabs (`v3-tabs`:
 * Nội dung · Thiết kế · Nâng cao); EOW's was one flat list. Which tab a
 * field belongs to has to be data on the field, not a `key.startsWith`
 * guess in the JSX -- that is the same reason `type` and `numeric` live here.
 */
describe('inspector field tabs (ADR-044 Task SV-2)', () => {
  const ALL_KINDS = ['section', 'column', 'heading', 'text', 'button', 'image', 'divider', 'spacer', 'logo', 'banner', 'social', 'contact', 'table', 'preheader', 'customHtml'] as const;

  it('puts every field on exactly one of the three prototype tabs', () => {
    for (const kind of ALL_KINDS) {
      for (const field of inspectorFieldsForNode({ id: 'n', kind, visible: true })) {
        expect(['content', 'design', 'advanced'], `${kind}.${field.key} has no tab`).toContain(field.tab);
      }
    }
  });

  it(`calls what the block says "content" -- text, link, image source and description`, () => {
    const tabOf = (kind: (typeof ALL_KINDS)[number], key: string): string | undefined =>
      inspectorFieldsForNode({ id: 'n', kind, visible: true }).find((f) => f.key === key)?.tab;
    expect(tabOf('heading', 'content')).toBe('content');
    expect(tabOf('heading', 'headingLevel')).toBe('content');
    expect(tabOf('button', 'href')).toBe('content');
    expect(tabOf('image', 'src')).toBe('content');
    expect(tabOf('image', 'alt')).toBe('content');
    expect(tabOf('preheader', 'content')).toBe('content');
  });

  it(`calls how it looks "design" -- typography, colour, spacing, borders`, () => {
    const tabOf = (kind: (typeof ALL_KINDS)[number], key: string): string | undefined =>
      inspectorFieldsForNode({ id: 'n', kind, visible: true }).find((f) => f.key === key)?.tab;
    expect(tabOf('text', 'fontSize')).toBe('design');
    expect(tabOf('text', 'textColor')).toBe('design');
    expect(tabOf('text', 'align')).toBe('design');
    expect(tabOf('section', 'paddingTop')).toBe('design');
    expect(tabOf('section', 'borderWidth')).toBe('design');
    expect(tabOf('button', 'accent')).toBe('design');
  });

  it('leaves no kind with a tab that would render nothing at all', () => {
    // A tab is allowed to be empty of *fields* -- `advanced` usually is, and
    // BuilderScreen fills it with the decorative switch, the custom-HTML
    // editor and the deliverability warnings. What must not happen is a kind
    // whose fields exist but land on no tab, which would drop them from the
    // inspector entirely: the S4 regression this whole port risks.
    for (const kind of ALL_KINDS) {
      const fields = inspectorFieldsForNode({ id: 'n', kind, visible: true });
      const placed = fields.filter((f) => f.tab === 'content' || f.tab === 'design' || f.tab === 'advanced');
      expect(placed.length, `${kind} loses fields between the tabs`).toBe(fields.length);
    }
  });

});
