import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { read } from './repo.js';

/**
 * ARCH-MAILCRAFT-DOM — Task SV-1, enforcing ADR-044 clause 3.
 *
 * ADR-044 made the Mailcraft prototype the visual source of truth: its CSS is
 * copied verbatim and its DOM and class names are ported rather than reinvented.
 * ARCH-HANDOFF already guards the first half -- every line of `studio.css` must
 * still be present in `globals.css`.
 *
 * Nothing guarded the second half. Measured 2026-09-04, right after the CSS
 * landed: `apps/web` used 7 of the prototype's 113 class names, and the only two
 * `v3-` strings in this whole package were comments. Delete every `v3-` class
 * from the components and the CSS gate stays green -- 321 lines of stylesheet in
 * the repository that nothing is obliged to use. That is the same shape of hole
 * the `contact` block fell through: a rule written down, and no check behind it.
 *
 * So this reads the class names the prototype's own JSX uses, and requires each
 * to be either used in `apps/web/src` or carried in the register below with an
 * ADDRESS -- a slice id the plan actually schedules, or the ADR that rejected it.
 * A prototype class that is neither is a failure, which means a screen cannot be
 * quietly left un-ported, and a class added to the prototype later forces a
 * decision rather than passing unnoticed.
 *
 * The register is deliberately verbose. Its whole purpose is that the debt is
 * legible: at the time of writing, five of the six MC-UI screens are un-ported
 * and every one of them says so here, by name, pointing at the task that will do
 * it. That is the difference between "we know" and "nobody noticed".
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const PROTOTYPE = 'design-reference/mailcraft-ui-handoff-v1/source/app/studio.tsx';
const PLAN_PATH = 'docs/superpowers/plans/2026-08-31-mailcraft-builder-vertical-slice.md';
const WEB_SOURCE = resolve(REPO_ROOT, 'apps/web/src');

/** A prefix rule keeps the register readable: one row per region, not per class. */
type Excuse = { kind: 'slice'; slice: string; reason: string } | { kind: 'rejected'; by: string; reason: string };

const EXCUSED: ReadonlyArray<{ match: RegExp; excuse: Excuse }> = [
  {
    // Task SV-5 paid this row down and, measuring first, found the register
    // wrong AGAIN -- the fourth and fifth mis-attribution in this slice. The
    // row claimed 26 classes for MC-UI-008/MC-UI-011. Assigning each
    // `className` in `studio.tsx` to the function enclosing it says otherwise:
    //
    //   - `view-note` is on line 944, the TEMPLATES branch of `Sheet` -- the
    //     "N mẫu sẵn sàng" count beside that sheet's search box. The comment
    //     here called it "the preview sheet's caveat line". It is not in the
    //     preview branch at all.
    //   - `scope-tabs`/`context-card`/`var-group` are on line 945, the
    //     VARIABLES branch: a different screen from MC-UI-008, and one whose
    //     destination SV-2 decision 4 had already built as a rail panel.
    //     `context-card` is also not "its per-variable card" -- it is the
    //     single card at the top of that sheet naming the preview recipient.
    //   - `var` is drawn by `renderInline`/`Rich`/`Preview` (the inline chip on
    //     the canvas) and `parameter` by `Studio` itself (a floating
    //     "Tham số hóa" button over a text selection) -- neither is sheet
    //     chrome, and the second is a FEATURE rather than a class.
    //   - the `p-*` group and `table` are `Preview`, the canvas leaf renderer:
    //     MC-UI-001/002, not the preview sheet.
    //   - `social-edit`/`social-row` are `Inspector`.
    //   - `email-fallback` is `SurfaceExtras`, the caption of the very control
    //     group the `widths|surface-presets` row below already rejects.
    //
    // Everything SV-5 then ported is gone from this register, which is what a
    // paid debt looks like. What remains is split into rows that name their
    // real owner, below.
    //
    // RE-READ 2026-09-11, while building ADR-046, because this is exactly the
    // kind of reason this repo has already let expire once: ADR-046 gives the
    // builder inline rich text, which is the closest anything has come to the
    // capability this button implies. The reason still RESOLVES. ADR-046
    // decision 4 keeps text editing in the inspector's `<textarea>` and reads
    // that textarea's own `selectionStart`/`selectionEnd`; it does not make the
    // canvas contenteditable and creates no canvas selection, so there is still
    // nothing here for a floating button over the canvas to read. ADR-046
    // §"Phương án đã loại" item 3 rejects the contenteditable route on this
    // same ground, and on a second one it measured: contenteditable produces
    // browser HTML, which is the attack surface decision 3 exists to avoid.
    match: /^v3-parameter$/,
    excuse: {
      kind: 'rejected', by: 'adr-044-the-mailcraft-prototype-is-the-visual-source-of-truth.md',
      reason: 'a floating "Tham số hóa" button the prototype shows over a text selection ON THE CANVAS, turning the selected words into a new variable. It has no surface to sit on here: EOW\'s canvas is a click-to-select structure (Task 17) and text is edited in the inspector, not in place -- there is no canvas selection for the button to read. Porting it would mean making the canvas contenteditable, which is a rebuild of the editing model, not a visual port, and ADR-044 states it does not touch the model. The capability itself is not lost: the variables panel creates template-scoped variables and inserts them at the caret',
    },
  },
  {
    // Measured while porting SV-5, and the reason is the one ADR-044 itself
    // writes down.
    match: /^v3-custom$/,
    excuse: {
      kind: 'rejected', by: 'adr-044-the-mailcraft-prototype-is-the-visual-source-of-truth.md',
      reason: 'the canvas rendering of a custom-HTML block. The prototype draws it with `dangerouslySetInnerHTML` plus an inline `<style>`; ADR-044 names the `<iframe sandbox="">` preview as one of three places this repo is AHEAD of the prototype and explicitly not a deviation to repair. Painting un-sandboxed author HTML onto the canvas to match a picture would trade that protection away for a thumbnail. The block keeps its summary chip, and the real render stays behind the preview toggle, inside the sandbox',
    },
  },
  {
    // S9 Task 52-53 ported the other three names this row used to carry
    // (`v3-publish-ready`, `v3-resource`, `v3-publish-confirm`), so only the
    // flow strip is left -- and it is not deferred, it is rejected.
    //
    // `v3-flow` draws "Mailcraft -> HTML + metadata -> EOW Provider API": a
    // hop between two systems. There is one system. Mailcraft is a module of
    // EOW under ADR-001's modular monolith, publish writes an immutable row in
    // the same database, and none of the five extraction criteria in the
    // builder spec §3.3 is true today. This is the same ground on which
    // `retry_registration` and `registration_pending` are rejected in
    // ARCH-MAILCRAFT-FIDELITY -- one architecture, three consequences.
    //
    // `v3-resource` kept its four-box layout and lost its contents for the
    // same reason (BuilderScreen, "DEVIATION from studio.tsx"): the box shape
    // is real, "Provider: mailcraft / Resource: email_template" is not.
    match: /^v3-flow$/,
    excuse: {
      kind: 'rejected',
      by: 'adr-001-modular-monolith-with-separate-runtime-profiles.md',
      reason: 'the Mailcraft-to-EOW sync strip. It names a provider API hop between two services; ADR-001 keeps one domain codebase, so publish is a database write in the same process and there is no second system for the arrow to point at. Drawing it would describe an integration the reader could never find. Revisit only if one of the five extraction criteria in the builder spec §3.3 becomes true',
    },
  },
  {
    // The one class ADR-044 rejects outright rather than postpones.
    match: /^v3-import-legend$/,
    excuse: {
      kind: 'rejected', by: 'adr-037-builder-template-allowlist-and-editor-placement.md',
      reason: 'the legend explains the Native-block / Preserved-fallback split, which only exists when importing INTO the builder. ADR-037 §3 forbids reconstructing a component tree from HTML, and the S7 plan fences it off explicitly, so there is nothing for this legend to describe -- this is a rejection, not a postponement, and must not be given a slice id',
    },
  },
  {
    // Task SV-2 ported the shell, and these four rows are what it did NOT
    // port, each with the reason rather than a slice number. Everything else
    // that used to sit in the SV-2 row is now in `apps/web/src`, which is why
    // that row is gone: the register is the debt, and the debt was paid.
    match: /^v3-engine$/,
    excuse: {
      kind: 'rejected', by: 'adr-039-builder-owns-its-document-model-no-grapesjs.md',
      reason: 'an off-screen host element for the third-party editor canvas to mount into. ADR-039 decided the builder owns its own document model and renders its own canvas, so there is no engine to host -- the element would be an empty div named after a dependency this repo deliberately does not have',
    },
  },
  {
    match: /^v3-lang$/,
    excuse: {
      kind: 'rejected', by: 'adr-044-the-mailcraft-prototype-is-the-visual-source-of-truth.md',
      reason: 'the prototype header VI/EN switch. EOW ships one locale and has no runtime i18n, so this control would change nothing that anyone can see -- and ADR-044 makes the prototype the source of VISUAL truth, not a source of features the product has not decided to have. The SV-2 header decision (2026-09-04) settled the pair explicitly: `v3-avatar` is ported onto the account menu EOW already has, and this one is dropped rather than shipped inert',
    },
  },
  {
    // `surface-presets` and `email-fallback` LEFT this row on 2026-09-10 -- both
    // are ported now, so they are no longer excused, they are used.
    //
    // Worth reading the reason they carried, because half of it had expired
    // long before it was removed: "the properties it sets are stripped by the
    // sanitizer, which is why `inspector-fields.ts` refuses to offer a control
    // for any of them". ADR-042 un-stripped all four on 2026-09-02. The register
    // entry, the inspector's doc comment and this row went on repeating a dead
    // reason for eight days, and nothing could catch that: a rejection is
    // checked for HAVING an address, never for whether the address still
    // resolves.
    //
    // That is the gap `ARCH-MAILCRAFT-DOM` cannot close on its own, and it is
    // why the ADR-042 build re-read every rejection reason instead of only the
    // ones it touched.
    match: /^v3-widths$/,
    excuse: {
      kind: 'rejected', by: 'adr-044-the-mailcraft-prototype-is-the-visual-source-of-truth.md',
      reason: 'per-column table widths, which `TableBlock` carries no field for. ADR-044 states in as many words that the decision is purely visual and does not touch the model or the emitter, so porting this would take the ADR past its own scope. This is the ONLY reason left in this row -- the sanitizer half of it belonged to `surface-presets`, which was ported on 2026-09-10 once ADR-042 was built; giving a table per-column widths is still a model change nobody has decided to make',
    },
  },
  {
    // `sheet-toolbar` was in this row and should not have been: it is not part
    // of the second template browser at all, it is the generic search-bar
    // wrapper the templates, variables and assets branches each open with.
    // Task SV-5 ported it around the "Kho mẫu" panel's own search box, where
    // line 944 of `studio.tsx` puts it, and the gate's staleness check caught
    // the row still claiming it.
    match: /^v3-(template-browser|template-hero|template-blank-hero|template-blank-card)$/,
    excuse: {
      kind: 'rejected', by: 'adr-044-the-mailcraft-prototype-is-the-visual-source-of-truth.md',
      reason: 'the prototype opens a second, fuller template browser in a sheet on top of the "Kho mẫu" panel it already draws. SV decision 1 forbids exactly this: a rail destination must reach what EOW has, and EOW has TemplatesScreen. The panel footer (`v3-library-footer`) leads there, so the sheet has nothing left to show -- a rejection, not a postponement',
    },
  },
];

/** Every `v3-*` class the prototype's own JSX puts on an element. */
function prototypeClasses(): string[] {
  const source = read(PROTOTYPE);
  const found = new Set<string>();
  for (const attribute of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    for (const name of (attribute[1] ?? attribute[2] ?? '').split(/[\s${}?:]+/)) {
      if (/^v3-[a-z0-9-]+$/.test(name)) found.add(name);
    }
  }
  return [...found].sort();
}

/**
 * Task SV-2, measured by mutation: deleting `className="v3-theme-grid"` from
 * BuilderScreen left this gate GREEN, because the name still appeared in a doc
 * comment above the component and in the title of a test. A gate that a
 * comment can satisfy is the exact failure ADR-044 was written to stop --
 * `studio.css` sat in `globals.css` for a whole slice with nothing obliged to
 * use one line of it, and prose ABOUT a class is not a use OF it.
 *
 * So: test files are not source, and comments are not markup. Block comments
 * (the JSX form included) and whole-line `//` comments are removed before the
 * match. Trailing `//` is deliberately left alone: stripping it would have to
 * guess whether the slashes are inside a string, and cutting a line short at a
 * URL would hide real markup that follows on the same line. A false negative
 * here fails the gate loudly and gets fixed; a false positive is the silence
 * this check exists to break.
 */
function webSourceText(): string {
  const parts: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) parts.push(readFileSync(full, 'utf8'));
    }
  };
  walk(WEB_SOURCE);
  return parts.join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

function excuseFor(className: string): Excuse | undefined {
  return EXCUSED.find((entry) => entry.match.test(className))?.excuse;
}

/**
 * Task SV-3, measured while porting: `\bv3-row\b` matches inside the string
 * "v3-row-layouts" too, because JS `\b` treats `-` as a word boundary the same
 * as a space -- so shipping `v3-row-layouts` alone made the *separate*
 * `v3-row` class (CanvasNode's section/row/column chrome, still un-ported)
 * read as "used" by coincidence. A class name is `[a-z0-9-]+`, so `-` has to
 * count as a name character for this check, not a boundary -- lookaround on
 * "not a name character" either side is the fix, same idea `\b` uses for word
 * characters.
 */
function usedInWeb(className: string, web: string): boolean {
  return new RegExp(`(?<![a-z0-9-])${className}(?![a-z0-9-])`).test(web);
}

describe('ARCH-MAILCRAFT-DOM: every prototype class is used, or excused with an address', () => {
  const classes = prototypeClasses();
  const web = webSourceText();

  it('reads a real class list out of the prototype rather than a copy of one', () => {
    // A hand-copied list is how `contact` disappeared: blocks.test.ts held one
    // that agreed with the product and disagreed with the design. If this parse
    // ever silently returns nothing, the gate would pass by knowing nothing.
    expect(classes.length).toBeGreaterThan(80);
    expect(classes).toContain('v3-import-report');
  });

  it('leaves no prototype class both unused and unexcused', () => {
    const orphans = classes.filter((name) => !usedInWeb(name, web) && !excuseFor(name));
    expect(
      orphans,
      `${orphans.length} class(es) from the prototype are neither used in apps/web nor listed in EXCUSED. ` +
        'Port the markup, or add a row naming the slice that will -- ADR-044 clause 4 forbids a silent divergence:\n  ' +
        orphans.join('\n  '),
    ).toEqual([]);
  });

  it('points every excuse at a slice the plan actually schedules', () => {
    const plan = read(PLAN_PATH);
    for (const entry of EXCUSED) {
      const excuse = entry.excuse;
      if (excuse.kind === 'rejected') {
        expect(plan + read('docs/adr/' + excuse.by), `${excuse.by} does not exist to reject anything`).toContain('ADR');
        continue;
      }
      expect(plan, `an exclusion points at ${excuse.slice}, but the plan's slice map has no row for it`)
        .toMatch(new RegExp(`\\|\\s*\\*\\*${excuse.slice}\\*\\*\\s*\\|`));
      expect(excuse.reason.length, 'an exclusion needs a reason a reader can act on').toBeGreaterThan(40);
    }
  });

  it('keeps the register honest: every name in every row is a class the prototype actually has', () => {
    // Measured while porting SV-2: the SV-2 row named `v3-library-intro`,
    // `v3-new-draft` and `v3-danger`, and the prototype has none of the three.
    // A row for a class that does not exist excuses nothing and reads as debt
    // that will never clear -- the register describing itself rather than the
    // code. Nothing caught it, because every other check here starts from the
    // class list and never asks whether a row was reached.
    //
    // Task SV-4 found the hole in the first version of this check, which only
    // asked whether a ROW matched something: `v3-asset-tools` sat inside a
    // thirteen-name row and was invisible, because the twelve real names beside
    // it kept the row reachable. A dead name hides better in company. So the
    // alternation is taken apart and every branch is asked separately.
    const namesIn = (pattern: RegExp): string[] => {
      const source = pattern.source;
      const body = /^\^v3-\((.+)\)\$$/.exec(source)?.[1] ?? /^\^(v3-[a-z0-9-]+)\$$/.exec(source)?.[1];
      // A row written in some other shape is not silently skipped: it fails
      // here rather than passing unexamined, which is how the first version of
      // this check would have handled one.
      expect(body, `EXCUSED row ${source} is not the '^v3-(a|b|c)$' shape this check can read`).toBeDefined();
      return body!.split('|').map((name) => (name.startsWith('v3-') ? name : `v3-${name}`));
    };

    const known = new Set(classes);
    const dead = EXCUSED.flatMap((entry) => namesIn(entry.match)).filter((name) => !known.has(name));
    expect(
      dead,
      'these names are excused but do not exist in the prototype -- delete them from their row:\n  ' + dead.join('\n  '),
    ).toEqual([]);
  });

  it('keeps the register honest: nothing is excused that is already ported', () => {
    // An excuse left behind after the work is done is how a register rots into
    // scenery. If a class is in use, its row has to go.
    const stale = classes.filter((name) => usedInWeb(name, web) && excuseFor(name));
    expect(stale, `these classes are used in apps/web but still carry an exclusion; delete the row:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
