# ADR-019: Email visual editor

Status: Accepted (2026-09-01)

## Decision

Run a GrapesJS newsletter-output spike before committing; keep stored canonical HTML independent of editor JSON.

## Rationale

Visual builders can lock data to proprietary schemas and produce inconsistent email HTML.

## Alternatives

Adopt immediately; developer-only templates

## Outcome (2026-09-01)

Both halves of the decision are discharged, so this moves from Proposed to Accepted. The
text above is left as written — it is the record of what was decided in 2026-08, not a
description of today.

**The spike ran.** `docs/superpowers/specs/2026-09-01-grapesjs-spike-findings.md`. Its first
finding was that the premise was wrong: there was no newsletter preset, and GrapesJS was
never load-bearing in the reference implementation. **ADR-039** records the resulting
decision — the builder owns its document model and emitter, and `apps/web` takes no
`grapesjs` dependency.

**The invariant held, and is now the load-bearing rule of the builder.** Canonical HTML is
`email_template.draft_html`; the editor's JSON is `project_data`, stored opaquely and never
parsed by the API (`email-template.entity.ts:39-40`). Every downstream document restates it:
nothing may exist in `project_data` that cannot be expressed in the HTML.

The caution in the Rationale proved justified in an unexpected direction. The risk was not a
third-party schema locking the data — it was our own pipeline silently discarding valid CSS
(**ADR-038**) and breaking four blocks outright
(`2026-09-01-builder-block-sanitizer-audit.md`). Keeping the HTML canonical is what made both
measurable.

Verified 2026-09-01: `pnpm typecheck`, `pnpm build` and the full suite — 235 test files,
1517 tests, no failures.
