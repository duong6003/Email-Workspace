# ADR-037: Builder-origin sanitizer allowlist and editor package placement

Status: Accepted

Extends ADR-019 (email visual editor, still Proposed pending a compatibility spike) and the
`origin`/`project_data`/`draft_revision` seam added by the S0 template-editor-base work
(`database/migrations/071_template_origin_and_draft_revision.sql`). Supersedes nothing.

## Context

`docs/frontend/mailcraft-integration-requirements.md` §2 named three concrete conflicts
between a drag-and-drop builder (evaluated via the external `mailcraft-ui-handoff-v1`
reference package) and `apps/api/src/templates/template-html-sanitizer.ts`'s allowlist:
`border-radius` is stripped, `@media` is deleted by `juice({ preserveMediaQueries: false })`
(line 111), and `id` is stripped from every element. The same reference package's
`boilerplate/frontend-package-boundary.md` proposes housing the editor at
`packages/mailcraft-editor/`, which disagrees with `catalog/library-decisions.json`'s
existing FE-013 record (`"location": "apps/web"`) and with this monorepo's convention that
`packages/*` holds non-UI code only (`contracts`, `sender-credentials`,
`runtime-orchestration`, `api-schematics`). None of these four points can be left open once
block/inspector code for a builder-origin template starts getting written, since the
sanitizer runs unconditionally on every save (`template-html-sanitizer.ts`, no bypass for
`origin = 'builder'`).

## Decision

**1. `border-radius` is added to the CSS allowlist**, reusing the existing numeric
`safeStyleValues` regex (`template-html-sanitizer.ts:27-33`) — it accepts one value+unit
(`8px`, `50%`) applied uniformly. No existing regex parses space-separated multi-value CSS,
so four-corner shorthand (`8px 8px 0 0`) is not accepted. A radius control in the block
inspector must emit a single shared value, not independent per-corner inputs, until a future
ADR adds shorthand parsing.

**2. Responsive layout ships as Option B: fluid/hybrid HTML only.**
`preserveMediaQueries: false` stays unchanged. Blocks achieve mobile layout with
percentage-width tables, `max-width`, and column-stacking via existing `align`/`width`
attributes — not `@media`. Option A (`preserveMediaQueries: true`, real media queries
surviving in a saved `<style>` block) remains explicitly rejected until a client-rendering
compatibility spike proves it; none is scheduled by this ADR.

**3. `id` stays excluded from `emailAttributes`.** Any mapping a builder needs between saved
HTML and its own component tree must live entirely inside `project_data` (opaque JSON,
never read by the API per the entity comment on `email-template.entity.ts:39-40`) — never
recovered from `id` in `draftHtml` after a sanitizer round-trip. If a real anchor-link
feature is requested later, `a[name]` is already allowed and is the mechanism to extend
deliberately — that is a separate, explicit product decision, not implied here.

**4. Builder editor code lives in `apps/web`, not a new `packages/mailcraft-editor`
workspace package.** This confirms the existing FE-013 location rather than changing it.
`packages/*` in this repo has no UI-code precedent, `apps/web` is the one frontend target
every UI-handoff process and screen ADR already references, and ADR-009's requirement that
Mailcraft mount as a route-level package inside the EOW shell is satisfied by a feature
directory and lazy route inside `apps/web` — a separate workspace package would only
reintroduce the two-source-of-truth problem this ADR exists to close.

## Consequences

- `mailcraft-ui-handoff-v1`'s `boilerplate/frontend-package-boundary.md` layout
  (`packages/mailcraft-editor/src/...`) is reference material only; migrating its component
  code targets `apps/web/src/...` instead.
- The block library's corner-radius control is constrained to one shared value per element
  from day one — a real design constraint on the block spec, not just an implementation
  detail, and should be reflected before canvas/inspector code is written.
- Mobile-responsive block layouts are constrained to table-based fluid techniques from day
  one for the same reason.
- `catalog/library-decisions.json` FE-013 keeps `"status": "Spike required"` — this ADR
  removes three named blockers but does not itself prove GrapesJS output survives the full
  sanitizer + lint pipeline end-to-end. That proof is still the job of the vertical slice
  (P2 in `mailcraft-ui-handoff-v1/docs/phase-roadmap.md`, or its successor plan in
  `docs/superpowers/plans/`).
- ADR-019's status is unchanged — still Proposed, pending that same vertical-slice proof.
