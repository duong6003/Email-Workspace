import { describe, expect, it } from 'vitest';
import { KINDS } from './document.js';
import { BLOCK_CATALOG, INSERT_PANEL } from './blocks.js';
import { ROW_LAYOUT_PRESETS } from './row-layouts.js';

// The hand-written LAUNCH_KINDS list that used to live here is gone (ADR-044). Its
// own comment said "the Mailcraft handoff is the acceptance standard and nothing
// gets cut from it" -- and it listed fifteen kinds where the prototype declares
// sixteen, so `contact` was missing from the product and from this list at the
// same time, and the two agreed with each other perfectly. A list copied by hand
// cannot notice an omission in itself.
//
// The block set is now checked against the vendored prototype directly, in
// ARCH-MAILCRAFT-SOURCE (packages/architecture-tests/src/mailcraft-fidelity.test.ts).
// What remains here are the properties that hold whatever the set contains.

describe('BLOCK_CATALOG (MC-UI-002 + MC-UI-011)', () => {
  it('matches document.ts KINDS exactly -- every kind the model declares is launchable', () => {
    expect(BLOCK_CATALOG.map((entry) => entry.kind).sort()).toEqual([...KINDS].sort());
  });

  it('gives every entry a non-empty Vietnamese label', () => {
    for (const entry of BLOCK_CATALOG) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('gives every entry a default node whose kind matches the catalog entry', () => {
    for (const entry of BLOCK_CATALOG) {
      expect(entry.createNode().kind).toBe(entry.kind);
    }
  });

  it('never defaults a link field to "#" (spec §2.8: LINK_PLACEHOLDER would fire immediately)', () => {
    for (const entry of BLOCK_CATALOG) {
      const node = entry.createNode();
      expect(node.href).not.toBe('#');
    }
  });

  it('gives every entry a fresh id on each call', () => {
    const button = BLOCK_CATALOG.find((entry) => entry.kind === 'button')!;
    expect(button.createNode().id).not.toBe(button.createNode().id);
  });

  it('marks every default node visible', () => {
    for (const entry of BLOCK_CATALOG) {
      expect(entry.createNode().visible).toBe(true);
    }
  });

  it('gives a fresh table 2x2 cells, each an empty string (never undefined)', () => {
    const table = BLOCK_CATALOG.find((entry) => entry.kind === 'table')!.createNode();
    expect(table.table?.cells.length).toBeGreaterThan(0);
    for (const row of table.table?.cells ?? []) {
      for (const cell of row) expect(cell).toBe('');
    }
  });

  it('gives a fresh social block one entry per platform, all disabled until a URL is set', () => {
    const social = BLOCK_CATALOG.find((entry) => entry.kind === 'social')!.createNode();
    const platforms = (social.social ?? []).map((link) => link.platform);
    expect(new Set(platforms).size).toBe(platforms.length); // no duplicate platform
    // ADR-052: three, not "at least four" -- SOCIAL_PLATFORMS opened to nine
    // values, and seeding all nine on every fresh block stopped being
    // reasonable the moment it grew past five (blocks.ts's own comment on
    // DEFAULT_SOCIAL_PLATFORMS). The editor's "+ Thêm mạng xã hội" adds the rest.
    expect(platforms.length).toBe(3);
    for (const link of social.social ?? []) expect(link.url).toBe('');
  });

  it('gives a fresh preheader an empty string content, not undefined (so the field renders controlled)', () => {
    const preheader = BLOCK_CATALOG.find((entry) => entry.kind === 'preheader')!.createNode();
    expect(preheader.content).toBe('');
  });

  it('gives a fresh customHtml an empty string html, not undefined (so the CodeMirror editor renders controlled)', () => {
    const customHtml = BLOCK_CATALOG.find((entry) => entry.kind === 'customHtml')!.createNode();
    expect(customHtml.html).toBe('');
  });
});

// ADR-044 Task SV-3: the Insert panel groups its buttons into five sections
// (studio.tsx's `blocks` array), each with a count -- restored here as data on
// the catalog itself, not a rendering-time guess, so BuilderScreen.tsx has one
// place to read "which group" from and this file can pin the assignment down.
describe('BLOCK_CATALOG groups (MC-UI-002 insert panel, Task SV-3)', () => {
  it('assigns every entry one of the prototype\'s five groups', () => {
    const groups = new Set(['content', 'media', 'action', 'layout', 'email']);
    for (const entry of BLOCK_CATALOG) expect(groups.has(entry.group), `${entry.kind} has group "${entry.group}"`).toBe(true);
  });

  const kindsOf = (group: string) => BLOCK_CATALOG.filter((entry) => entry.group === group).map((entry) => entry.kind).sort();

  it('matches the prototype for media, action and email, and adds only what an ADR names', () => {
    // `list` is EOW's, not the prototype's. ADR-044 clause 4 governs that --
    // a deliberate deviation must carry an address, never be silent -- and the
    // address is ADR-048, registered in `ARCH-MAILCRAFT-SOURCE`'s `ADDED_KINDS`
    // where the gate checks the ADR exists and actually names the kind. The
    // `layout` row below has done the same for `row`/`column` since SV-3.
    expect(kindsOf('content')).toEqual(['heading', 'list', 'text']);
    expect(kindsOf('media')).toEqual(['banner', 'image', 'logo']);
    expect(kindsOf('action')).toEqual(['button', 'social']);
    expect(kindsOf('email')).toEqual(['contact', 'customHtml', 'footer', 'preheader']);
  });

  it('folds row/column into layout alongside the prototype\'s own layout entries -- additions are free (ADR-044 clause 2)', () => {
    expect(kindsOf('layout')).toEqual(['column', 'divider', 'row', 'section', 'spacer', 'table']);
  });
});

/**
 * The six layout presets, which the Insert panel never had.
 *
 * `studio.tsx` builds its palette as `[...block kinds, ...Object.entries(layoutSpecs)]`
 * -- so a Row is never inserted bare there. You pick a shape ("Hai cột đều",
 * "Trái hẹp · phải rộng") and get a Row with those columns already in it.
 * EOW shipped two invented buttons, "Hàng (Row)" and "Cột (Column)", and none
 * of the six shapes, which is the missing half an author actually reaches for.
 */
/**
 * `INSERT_PANEL` is a hand-written ORDER, not a projection of `BLOCK_CATALOG` --
 * the order is the prototype's and cannot be derived. That makes it a second
 * list that can drift from the first, and it did: ADR-048 added the `list` kind
 * to the catalog, every unit test and both architecture gates stayed green, and
 * the block was simply missing from the Insert panel in the running app. Found
 * by clicking, which is the one way it could be found.
 */
describe('INSERT_PANEL covers the catalog', () => {
  /**
   * `row` and `column` are absent on purpose and this names why, rather than
   * loosening the check: ADR-044 Task SV-3 replaced EOW's two invented "Hàng
   * (Row)" / "Cột (Column)" buttons with the prototype's six layout presets,
   * because `studio.tsx` never inserts a bare Row -- you pick a shape and get a
   * Row with its columns already in it. Both kinds stay in BLOCK_CATALOG
   * because the presets build them.
   */
  const NOT_DIRECTLY_INSERTABLE: ReadonlySet<string> = new Set(['row', 'column']);

  it('offers every catalog kind, so a kind cannot be insertable in theory only', () => {
    const offered = new Set(INSERT_PANEL.map((item) => item.id));
    const missing = BLOCK_CATALOG.map((entry) => entry.kind)
      .filter((kind) => !offered.has(kind) && !NOT_DIRECTLY_INSERTABLE.has(kind));
    expect(missing, `kind(s) in BLOCK_CATALOG with no Insert panel button: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps that exclusion honest -- an excluded kind must still be reachable through a preset', () => {
    for (const kind of NOT_DIRECTLY_INSERTABLE) {
      expect(BLOCK_CATALOG.some((entry) => entry.kind === kind), `${kind} is excluded from the panel and absent from the catalog -- it is simply gone`).toBe(true);
    }
    expect(ROW_LAYOUT_PRESETS.length, 'the presets are the only way to insert a row/column; there are none').toBeGreaterThan(0);
  });

  it('offers nothing that is not in the catalog or a layout preset', () => {
    const known = new Set<string>([...BLOCK_CATALOG.map((entry) => entry.kind), ...ROW_LAYOUT_PRESETS.map((preset) => preset.id)]);
    const invented = INSERT_PANEL.map((item) => item.id).filter((id) => !known.has(id));
    expect(invented, `Insert panel button(s) backed by nothing: ${invented.join(', ')}`).toEqual([]);
  });
});

describe('INSERT_PANEL layout presets', () => {
  const presets = INSERT_PANEL.filter((item) => item.widths !== undefined);

  it('offers the prototype\'s six shapes, in its order', () => {
    expect(presets.map((item) => item.id)).toEqual(['layout1', 'layout2', 'layout2left', 'layout2right', 'layout3', 'layout4']);
  });

  it('carries the prototype\'s labels, icons and ratios', () => {
    expect(presets.map((item) => [item.label, item.icon, item.widths?.join('/')])).toEqual([
      ['Một cột', '▭', '100'],
      ['Hai cột đều', '▥', '50/50'],
      ['Trái hẹp · phải rộng', '▯▭', '35/65'],
      ['Trái rộng · phải hẹp', '▭▯', '65/35'],
      ['Ba cột đều', '▦', '33/34/33'],
      ['Bốn cột', '▥▥', '25/25/25/25'],
    ]);
  });

  it('builds a Row with the columns already in it, at the preset\'s widths', () => {
    for (const preset of presets) {
      const node = preset.createNode();
      expect(node.kind, `${preset.id} inserts a row`).toBe('row');
      expect((node.children ?? []).map((child) => child.kind)).toEqual(preset.widths!.map(() => 'column'));
      expect((node.children ?? []).map((child) => child.width)).toEqual([...preset.widths!]);
    }
  });

  it('sits in the layout group, so the panel shows it beside Section', () => {
    expect(presets.every((item) => item.group === 'layout')).toBe(true);
  });

  it('gives every panel item a distinct id, since six of them share the kind `row`', () => {
    const ids = INSERT_PANEL.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * A freshly inserted block arrives styled, not blank.
 *
 * Every EOW block was created with `{id, kind, visible}` and whatever the entry
 * added -- no padding, no ink, no corner. So a new email had `padding:0` on
 * every block and every column, which `emitter.ts` faithfully wrote out: text
 * touching the edge of the sheet, blocks with no air between them. The canvas
 * used to hide it behind 8px of its own chrome; once that chrome went, the
 * document's own emptiness showed.
 *
 * These numbers are `studio.tsx`'s `newLeaf`/`newColumn`, not a set someone
 * picked here. The handoff is where this repo's design decisions live, and a
 * default invented locally is exactly the kind of drift ADR-044 exists to stop.
 * The prototype's demo BRAND is not copied: its logo points at Altasoftware's
 * own asset, which is seed data, not a default.
 */
describe('BLOCK_CATALOG defaults (studio.tsx newLeaf)', () => {
  const made = (kind: string) => BLOCK_CATALOG.find((entry) => entry.kind === kind)!.createNode();

  it('gives every leaf the handoff\'s padding, ink and corner', () => {
    for (const kind of ['heading', 'text', 'button', 'image', 'banner', 'logo', 'social', 'table', 'contact', 'preheader', 'customHtml']) {
      const node = made(kind);
      expect([kind, node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]).toEqual([kind, 14, 14, 14, 14]);
      expect(node.radius, `${kind} corner`).toBe(8);
    }
  });

  it('spends the two exceptions the handoff makes: a divider breathes more, a spacer is the space', () => {
    expect(made('divider').paddingTop).toBe(12);
    expect(made('spacer').paddingTop).toBe(0);
  });

  it('states the typography rather than leaning on the emitter\'s fallback', () => {
    expect(made('heading')).toMatchObject({ fontSize: 28, lineHeight: 1.2, fontWeight: 700 });
    expect(made('text')).toMatchObject({ fontSize: 14, lineHeight: 1.6, fontWeight: 400 });
    expect(made('contact')).toMatchObject({ fontSize: 12, lineHeight: 1.6, align: 'center' });
    expect(made('preheader')).toMatchObject({ fontSize: 11 });
  });

  it('centres a call to action, as the handoff does', () => {
    expect(made('button').align).toBe('center');
  });

  it('gives a Column the handoff\'s own padding, so a row is not flush to its content', () => {
    expect(made('column').paddingTop).toBe(18);
  });
});
