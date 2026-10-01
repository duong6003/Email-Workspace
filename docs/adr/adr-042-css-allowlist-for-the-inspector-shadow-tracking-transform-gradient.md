# ADR-042: Allow `box-shadow`, `letter-spacing`, `text-transform`, and a gradient-only `background-image`

Status: Accepted

Extends the allowlist established by ADR-037 §1, widened by ADR-038 (multi-value shorthand)
and ADR-040 (`display`/`max-height`/`overflow`). Supersedes nothing.

## Context

The vertical-slice plan's Task 18 gives the Section/Column inspector a surface, gradient
and safe-fallback control (UI-HANDOFF §4, "Inspector") and Text/Heading a full typography
control. Four of the properties that surface needs are stripped by
`template-html-sanitizer.ts` today: `box-shadow`, `letter-spacing`, `text-transform`,
`background-image`.

The plan is explicit about the failure mode this exists to avoid (§"Hai thứ chặn thật,
không phải sở thích"): the fix is not to remove the control from the inspector to dodge the
sanitizer. A control whose result is invisible in the sent email is the exact defect
ADR-037 §1 named for `border-radius` before that property was opened. Cutting the control
instead of opening the property would repeat that mistake with a different property.

Measured before deciding, against the real `sanitizeTemplateHtml` (probe run, not a build
artifact -- see Consequences):

| Declaration | Before this ADR | After |
|---|---|---|
| `box-shadow:0 1px 2px rgba(0,0,0,0.12)` | dropped (property unlisted) | kept |
| `box-shadow:inset 0 0 0 1px #dbe5e0` | dropped | **still dropped** — 6 tokens, over the 4-token cap |
| `letter-spacing:0.5px` | dropped (property unlisted) | kept |
| `letter-spacing:-0.2px` | dropped (property unlisted; also no shared pattern admits a sign) | kept |
| `text-transform:uppercase` / `lowercase` / `capitalize` / `none` | dropped (property unlisted; keyword also absent from the shared list) | kept |
| `background-image:linear-gradient(180deg,#173f33 0%,#18342c 100%)` | dropped (property unlisted) | kept |
| `background-image:linear-gradient(to right,#173f33,#18342c)` | dropped | kept |
| `background-image:url(https://attacker.test/x.png)` | dropped | **still dropped** |
| `background-image:linear-gradient(url('https://attacker.test/x.png'),#173f33)` | dropped | **still dropped** — nested `url(` does not fit the gradient grammar |
| `background-image:#173f33` (the `background` shorthand's habit, misapplied) | dropped | **still dropped** — not a `linear-gradient(...)` call |

Full test coverage: `apps/api/src/templates/template-html-sanitizer.test.ts`, describe block
`ADR-042: box-shadow, letter-spacing, text-transform, gradient background-image`.

## Decision

**Allow four properties, each with a value grammar scoped to what it actually needs — none
reusing the shared keyword/shorthand lists unmodified:**

1. **`box-shadow`** reuses the existing `safeShorthandStyleValues` (ADR-038's 2–4 token
   shorthand: hex/`rgb()`/`rgba()` colors and numbers with `px|em|rem|%|pt`). This caps the
   inspector to `offset-x offset-y blur color` (4 tokens) — no `inset` keyword, no spread
   radius. Email clients that render `box-shadow` at all render the simple form; `inset` and
   spread are the least-supported parts of the property in email clients specifically, so the
   cap costs little in practice and keeps this property on the same shorthand grammar as
   `border`/`padding`/`margin` rather than inventing a sixth one.
2. **`letter-spacing`** gets its own single-value pattern: the existing numeric pattern with
   an optional leading `-`. Scoped to this property alone, not added to the shared
   `safeStyleValues` list — negative tracking is normal on headings, but there is no reason
   for `padding:-8px` or `width:-8px` to suddenly become acceptable as a side effect of this
   change.
3. **`text-transform`** gets its own keyword pattern: `uppercase | lowercase | capitalize |
   none | inherit | initial | unset`. The shared keyword list (`safeStyleValues`'s
   word-alternation entry) is for properties like `text-align`/`font-style` and does not
   contain these words; adding them there would let `text-align:uppercase` parse as
   plausible-looking nonsense that happens to survive. A dedicated list keeps each property's
   valid vocabulary honest.
4. **`background-image`, limited to `linear-gradient(...)`.** A purpose-built regex requires
   the whole value to be a `linear-gradient(` call with an optional direction (`to <side>` or
   an angle in `deg`) followed by 2–6 color stops, each a hex/`rgb()`/`rgba()` color with an
   optional `%` position. `url(` does not appear anywhere in this grammar, so it cannot match
   — not as the whole value, not nested inside the gradient's argument list. This is the real
   security boundary for the property: `unsafeCss` (the `@import`/`url(`/`expression(`/etc.
   scan) only runs against `<style>` block text before `juice()` inlines it, not against
   inline `style="..."` attribute values, which is the form this regex actually gates.

## Consequences

- **The 23-property list from ADR-040 is now 27.** `mailcraft-integration-requirements.md`
  §1.3 is updated in the same commit — it is the document the integration side reads, and it
  opens by promising every constraint is sourced to current code.
- **The inspector's Section/Column surface control (Task 18) can offer shadow + gradient
  background without lying about the result**, and Text/Heading can offer letter-spacing and
  a case-transform control. Neither was possible before this ADR without shipping a control
  whose output silently vanished.
- **`box-shadow:inset` is not supported.** If a future design genuinely needs an inset
  shadow, that is a new decision (a 5th shorthand token, or a dedicated `box-shadow-inset`
  boolean the emitter expands) — not an automatic consequence of this one.
- **Gradients are two-color-stop-minimum, six-color-stop-maximum, linear only.**
  `radial-gradient()`/`conic-gradient()` are not covered; if the inspector ever offers those,
  they need their own measured grammar the same way this one got one, not a loosened version
  of this regex.
- **This does not make stripping visible.** A declaration removed for any other reason still
  vanishes silently — `docs/superpowers/specs/2026-09-01-sanitizer-reports-what-it-removed-design.md`,
  still unimplemented.
- **Probe methodology note.** ADR-040's probe ran against a built `dist/` artifact
  (`evidence/s2-spike/css-value-probe.mjs`). This ADR's probe ran the same cases directly
  against the TypeScript source via `tsx`, then again as the permanent regression suite in
  `template-html-sanitizer.test.ts` — no build step required to reproduce the measurement,
  and the ongoing gate is the test file itself rather than a throwaway script.
