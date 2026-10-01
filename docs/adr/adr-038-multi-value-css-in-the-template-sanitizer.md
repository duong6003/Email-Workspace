# ADR-038: Multi-value CSS in the template sanitizer

Status: Accepted

Narrows ADR-037 §1, which deferred this: *"No existing regex parses space-separated
multi-value CSS, so four-corner shorthand (`8px 8px 0 0`) is not accepted … until a future
ADR adds shorthand parsing."* This is that ADR. ADR-037 is not edited; where the two differ,
this one governs.

## Context

The S2 spike (`docs/superpowers/specs/2026-09-01-grapesjs-spike-findings.md`) ran the real
builder-prototype export through the real `sanitizeTemplateHtml`. Three properties that are
**in** the allowlist were being stripped anyway:

| Property | in → out |
|---|---|
| `padding` | 15 → 0 |
| `border` | 14 → 1 |
| `margin` | 9 → 1 |

Root cause: none of the five patterns in `safeStyleValues`
(`template-html-sanitizer.ts:27-33`) matches a space-separated value. Measured directly
(`evidence/s2-spike/css-value-probe.mjs`): `padding:24px` is kept, `padding:12px 20px` is
dropped; `border:0` is kept, `border:1px solid #ccc` is dropped.

ADR-037 read this as a `border-radius` quirk. It is not. `border-radius` is decoration;
`padding` is the primary spacing mechanism of table-based email, and `border: 1px solid
<color>` has **no** single-value equivalent that renders a visible border. An email stripped
of all padding is text against the cell edge — broken, not merely off-design.

Two aggravating facts decided the priority. The loss is **silent** — the sanitizer returns
`errors: []`, `warnings: []` and one generic `changes` line. And `sanitizeTemplateHtml` has
no per-`origin` branch, so this is **already happening to `imported` templates in
production**, not a future risk for the unbuilt builder.

## Decision

**Accept space-separated multi-value CSS for the properties whose CSS grammar defines it,
by requiring every token to independently satisfy the existing value rules.**

The security posture is unchanged: previously a value had to be one safe token; now it may
be up to four safe tokens separated by whitespace, and each token is validated against the
same patterns. No pattern is loosened. `unsafeCss` still rejects `@import`, `url(`,
`expression(`, `behavior:`, `-moz-binding`, `javascript:` and `data:` at the stylesheet
level before this runs.

Three deliberate constraints:

1. **Scoped to five properties** — `padding`, `margin`, `border`, `border-radius`,
   `border-spacing`. These are exactly the allowlisted properties whose CSS grammar takes
   more than one value. Every other property keeps the single-token rule. `allowedStyles` is
   already a per-property map, so this costs nothing structurally.

2. **The multi-token grammar excludes the two whitespace-bearing patterns.** Tokens are
   drawn from hex colors, `rgb()`/`rgba()` **without internal spaces**, numbers with an
   optional unit, and a bare word (`[a-z][a-z-]*`). The font-family pattern
   (`/^[a-z][a-z\s,-]*$/`) and the space-tolerant `rgb()` pattern are excluded from the
   token set because composing a whitespace-containing token with a whitespace separator
   creates ambiguous backtracking — a ReDoS hazard on attacker-supplied CSS. Both patterns
   keep working for whole-value matches, so `font-family: Arial, Helvetica, sans-serif` and
   `color: rgb(0, 0, 0)` are unaffected.

   The token is a bare word rather than the existing keyword alternation for a reason found
   by testing against real output: **`transparent` is not in that keyword list**, while the
   builder emitter writes `border:${width}px solid ${color || 'transparent'}`. A token set
   limited to the keyword list would have passed every unit test and still dropped the most
   common `border` value in real data. A bare word is not a new permission class either —
   the whole-value pattern above has always accepted an arbitrary letter string; this is the
   same class, tokenised.

3. **Maximum four tokens.** CSS shorthand never exceeds four (`padding`/`margin`/
   `border-radius`); `border` takes three. A bounded quantifier also keeps the matcher
   linear.

The change is **purely additive**: a value is tested against the existing patterns first and
the new one only if those fail. Nothing that is accepted today can start being rejected.

## Consequences

- **`border-radius` may now carry four-corner shorthand, reversing ADR-037 §1's constraint
  on the inspector.** The rule that "a radius control must emit a single shared value, not
  independent per-corner inputs" is lifted; the S1 test asserting shorthand is dropped is
  replaced by one asserting it survives. This is the intended effect of a superseding ADR,
  not a regression.
- **`imported` templates stop losing their spacing.** This fixes a live defect for the
  existing code-editor flow, which is the reason this was done now rather than deferred into
  the builder work.
- **Measured on the spike's own input** (`evidence/s2-spike/prototype-export.html`):
  `padding` 15→0 becomes 15→15, `margin` 9→1 becomes 9→9, `border` 14→1 becomes 14→14, and
  the share of bytes surviving the sanitizer rises from 69% to 85%.
- **`rgb(0, 0, 0)` inside a shorthand is still rejected** — the space-free `rgb(0,0,0)` form
  is accepted. This is the price of ruling out the ReDoS ambiguity, and it is a narrow
  enough gap that no separate ADR is warranted; an emitter under our control writes the
  space-free form.
- **Nonsense multi-value on a single-value property is still rejected**, because the new
  pattern is not attached to those properties. `color: 1px solid` fails. (`color: 12px`
  already passes today and still does — the shared value list has never been type-aware, and
  this ADR does not change that.)
- **Silence is not fixed by this ADR.** A declaration dropped for any other reason —
  `box-shadow`, `display`, an unsafe token — still vanishes with no specific `changes` entry.
  The spike recommended reporting what was removed; that remains open and is not in scope
  here.
