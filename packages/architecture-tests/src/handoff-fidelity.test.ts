import { describe, expect, it } from 'vitest';
import { read } from './repo.js';

/**
 * ARCH-HANDOFF: protects DEC-009, the strategy the entire visual-acceptance
 * plan rests on — "port the DOM and class names verbatim and copy globals.css
 * unchanged, so visual equivalence holds by construction and any diff is a
 * genuine defect rather than a re-implementation artefact".
 *
 * The invariant is NOT byte-equality. EXECPLAN §12 requires adding the four
 * required states the handoff never shipped (loading, empty, permission_denied,
 * reconnecting), which legitimately grows these files — M1-S2 added
 * `.permission-denied-card`, M2-S2 added the segment palette. A byte-equality
 * check would fail on that legitimate growth (a `diff -q` does exactly this and
 * has already produced a false alarm), so agents would learn to ignore it.
 *
 * The real invariant is subtractive: every line the handoff shipped must still
 * be present, unmodified, in its original relative order. Additions are free;
 * edits and deletions are not. That permits the required-state work while
 * making silent corruption of an approved screen's styling impossible.
 */
const HANDOFF_FILES: ReadonlyArray<{ handoff: string; production: string }> = [
  { handoff: 'design-reference/ui-handoff-v2/source/app/globals.css', production: 'apps/web/src/app/globals.css' },
  { handoff: 'design-reference/ui-handoff-v2/source/app/ui-icons.tsx', production: 'apps/web/src/app/ui-icons.tsx' },
  // ADR-044. Until 2026-09-04 this list held only the EOW handoff, because ADR-039 read
  // "not copied" for the Mailcraft prototype and nothing could compare against it anyway --
  // it lived outside the repository. Both halves of that are now fixed: the prototype is
  // vendored at design-reference/mailcraft-ui-handoff-v1/, and DEC-009's verbatim rule
  // applies to it too.
  //
  // What the omission cost, measured across MC-UI-001..011 on 2026-09-04: `grep -rn "v3-"
  // apps/web/src` returned nothing at all, and the `contact` block kind -- one of the
  // prototype's sixteen -- had gone missing without a single mention anywhere in docs/.
  // Every gate stayed green through four slices while that was true, because the only gate
  // touching Mailcraft (ARCH-MAILCRAFT-FIDELITY) checks actions and states, never appearance.
  //
  // `mailcraft.css` is deliberately NOT here, and the exclusion is measured rather than
  // assumed: nine of its distinctive class names (email-hero, btn primary, block-grid,
  // inspect-tabs, review-btn, draft-pill, select-name, seg, product one) appear zero times in
  // studio.tsx, which uses only v3-*. It is a leftover from an earlier iteration of the
  // prototype -- still imported by its layout.tsx, styling nothing -- and its selectors are
  // BARE (.app, .canvas, .tabs, .btn.primary), so copying it would seed 296 lines of dead CSS
  // that could collide with any future EOW class of the same name. See ADR-044 clause 2. If
  // studio.tsx ever starts using those classes, this exclusion lapses.
  { handoff: 'design-reference/mailcraft-ui-handoff-v1/source/app/studio.css', production: 'apps/web/src/app/globals.css' },
];

/** Longest-common-subsequence membership: are all of `original`'s lines present, in order, in `current`? */
function missingOrReordered(original: readonly string[], current: readonly string[]): string[] {
  const remaining = [...current];
  const missing: string[] = [];
  for (const line of original) {
    const index = remaining.indexOf(line);
    if (index === -1) missing.push(line);
    else remaining.splice(0, index + 1); // consuming in order also proves relative ordering is preserved
  }
  return missing;
}

describe('ARCH-HANDOFF: approved UI source fidelity (DEC-009)', () => {
  for (const { handoff, production } of HANDOFF_FILES) {
    it(`${production} still contains every line of the approved handoff, unmodified and in order`, () => {
      const original = read(handoff).split(/\r?\n/);
      const current = read(production).split(/\r?\n/);

      const missing = missingOrReordered(original, current);

      expect(
        missing,
        `${missing.length} approved line(s) from ${handoff} were modified, deleted or reordered in ${production}. ` +
          'Adding new rules is allowed; changing or removing approved ones is a redesign of an approved screen ' +
          '(AGENTS.md §2.1) and needs an explicit Decision Log entry. First offenders:\n  ' +
          missing.slice(0, 3).map((line) => line.slice(0, 120)).join('\n  '),
      ).toEqual([]);
    });
  }
});
