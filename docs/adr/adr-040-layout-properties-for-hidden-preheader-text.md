# ADR-040: Allow `display`, `max-height` and `overflow` so a preheader can hide

Status: Accepted

Extends the allowlist established by ADR-037 §1 and widened by ADR-038. Answers the one
open question left by `docs/superpowers/specs/2026-09-01-builder-block-sanitizer-audit.md`
§2.3. Supersedes nothing.

## Context

The block audit ran every builder block's own emitted markup through the real sanitizer.
The preheader block emits

```
display:none!important;max-height:0;overflow:hidden;opacity:0;color:transparent
```

and **four of those five properties are stripped**. Only `color:transparent` survives, so
the text meant to appear in the inbox preview line and nowhere else stays in the body,
occupying layout, pushing the real content down.

There is no way to fix this in the emitter. Hiding an element genuinely requires
`display:none`, or `max-height:0` paired with `overflow:hidden`. Neither is allowlisted.

The same missing property breaks two other blocks less severely: `display:block` on `<img>`
(the standard fix for the gap browsers leave under an image) and on the button anchor.

Measured before deciding, against `sanitize-html` with the property allowlisted
(`evidence/s2-spike` probe):

| Declaration | Result |
|---|---|
| `display:none` | kept |
| `display:none!important` | kept — the library separates `!important`, matches the value, re-emits it |
| `display:block`, `display:inline-block`, `display:table-cell` | kept |
| `max-height:0`, `overflow:hidden`, `opacity:0` | kept |
| `mso-hide:all` | **still dropped** |

The `!important` result mattered: the emitter writes it, and had the library folded it into
the value the property would have been stripped anyway and this ADR would have fixed
nothing.

## Decision

**Allow `display`, `max-height` and `overflow`.** Values are validated by the existing
`safeStyleValues` patterns, unchanged.

`opacity` is **not** allowed. It is redundant once the other three are in place, and it is a
second way to hide content for no additional capability. The emitter stops emitting it —
tracked as an emitter fix alongside the other four in the block audit's task table.

These three are pure layout. None can reference a URL, execute anything, or carry a scheme.
`unsafeCss` still rejects `@import`, `url(`, `expression(`, `behavior:`, `-moz-binding`,
`javascript:` and `data:` before any of this runs.

## Consequences

- **The preheader works in most clients, but not Outlook desktop.** Outlook needs
  `mso-hide:all`, and `mso-*` stays stripped. This ADR does not change that, and adding
  vendor-prefixed properties is a separate decision with a separate risk profile. The block's
  UI must say so rather than implying the text is hidden everywhere — showing a control whose
  result is wrong in a major client is the failure mode ADR-037 §1 already warned about.
- **Images and buttons regain `display:block`.** Two of the audit's cosmetic findings close
  as a side effect, which is part of why this is worth doing beyond the preheader.
- **This makes hidden text expressible, and hidden text is a deliverability signal.** Spam
  filters treat invisible content as suspicious, and this product sends on shared sender
  configuration (ADR-030), so one tenant's habits can affect others. That is an operational
  risk, not a code-execution one, and it is the actual cost of this decision. It is accepted
  because the legitimate use — the preheader — is a standard, expected email feature, and
  because a determined author could already hide text with `color` matching the background,
  which has always been allowed.
- **The 19-property list from ADR-037 is now 23** — 19 original, `border-radius` (ADR-037),
  and these three. `docs/frontend/mailcraft-integration-requirements.md` §1.3 must be updated
  in the same change; it is the document the integration side reads, and it opens by
  promising every constraint is sourced to current code.
- **This does not make stripping visible.** A declaration removed for any other reason still
  vanishes silently; that is
  `docs/superpowers/specs/2026-09-01-sanitizer-reports-what-it-removed-design.md`, still
  unimplemented.
