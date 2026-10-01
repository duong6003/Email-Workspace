# ADR-039: The builder owns its document model; GrapesJS is not adopted

Status: Accepted

Resolves the question FE-013 in `catalog/library-decisions.json` has carried as
`"status": "Spike required"` since the beginning, and the one ADR-019 was waiting on.
Follows the S2 spike (`docs/superpowers/specs/2026-09-01-grapesjs-spike-findings.md`).

## Context

FE-013 records the candidate as *"GrapesJS + newsletter preset"* and ADR-019 deferred
commitment until a spike proved the output. Both assumed the reference implementation was
built on GrapesJS. It is not.

What the prototype actually does, read from
`mailcraft-ui-handoff-v1/.../source/app/studio.tsx`:

- There is **no `grapesjs-preset-newsletter`** in `package.json` — only bare
  `grapesjs@^0.22.13`.
- The document is the prototype's **own typed model** (`Doc` → `section` / `row` / `column`
  / `heading` / `text` / `button` / `table` / `image` / `divider` / `spacer` / `custom`).
- The HTML is produced by the prototype's **own emitter**, `exportHtml` / `exportNode`
  (`studio.tsx:378-444`).
- Undo/redo is hand-rolled over that model (`past` / `present` / `future`).
- The visible canvas, the drag targets, the inspector and the block library are React
  components reading that model.

GrapesJS is initialised into a container that is styled

```css
.v3-engine{position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden;pointer-events:none}
```

with `panels: { defaults: [] }`, `aria-hidden`, and `height/width: "1px"`. The instance is
fed `setComponents(html)` on every change and is never read back — `editor.current` appears
three times in 959 lines and never in a code path that affects output. Its one observable
effect is a status badge that reads "GrapesJS Core" once `init` resolves.

**GrapesJS does no work in the reference implementation.** It is a label.

## Decision

**The builder owns its document model. GrapesJS is not taken as a dependency.**

`project_data` stores that model; `draftHtml` is produced from it by an emitter under our
control, which remains the only content rendered and sent (ADR-019's invariant, unchanged).

`EmailEditorEngine` is still added to `editor-ports.ts` as planned, and still wraps the
engine behind an interface so no component reaches past it. What changes is only what sits
behind the port: our model and emitter, not a third-party editor.

## Consequences

- **FE-013 moves off `"Spike required"` to rejected-with-reason**, not accepted. The spike
  it was waiting for has run; the answer is that the library was never load-bearing.
  ADR-019's requirement — *"keep stored canonical HTML independent of editor JSON"* — is
  satisfied more directly by owning the emitter than by wrapping one.
- **The S2 exit gate in the plan is void.** `grep -r "from 'grapesjs'" apps/web/src` resolving
  to exactly one adapter file assumed an adapter exists. The replacement gate is that
  `apps/web` gains no `grapesjs` dependency at all, and that `getHtml()` is reachable through
  `EmailEditorEngine` without any component importing the model directly.
- **What the spike measured is what we are shipping.** The 85%-survival figure, and the
  padding/margin/border numbers behind ADR-038, came from this emitter's output. Had we
  adopted GrapesJS, none of that evidence would transfer — `getHtml()` was never measured,
  and GrapesJS emits `id` and `data-gjs-*` attributes that this pipeline strips (ADR-037 §3).
- **We own the emitter's defects too.** It currently depends on `@media` for mobile stacking,
  which the sanitizer removes (ADR-037 §2, confirmed by the spike: the rule is deleted while
  `mc-stack` / `mc-column` survive as dead classes). Rewriting those blocks fluid/hybrid is
  now unambiguously our work, not something a library upgrade might fix.
- **Porting is a real cost.** `studio.tsx` is 959 dense lines covering the model, the
  emitter, the inspector and the block library. It arrives as a frozen reference, not as a
  package, and must be migrated into `apps/web` incrementally under the conventions in
  `docs/superpowers/specs/2026-08-31-mailcraft-builder-screen-design.md` §2 — ~~not copied~~.
  **Superseded 2026-09-04 by ADR-044 for the visual layer only.** Read literally, "not
  copied" was taken as licence to author the MC-UI screens' markup and CSS independently, and
  four slices later `grep -rn "v3-" apps/web/src` returned nothing while a block kind
  (`contact`) had gone missing with no record anywhere in `docs/`. ADR-044 puts the prototype's
  DOM, class names and CSS under DEC-009's verbatim rule, the same one the EOW handoff has
  always had. Everything else in this ADR — owning the model, owning the emitter, no GrapesJS
  — is untouched.
- **No dependency review, licence check or bundle-size budget is needed for GrapesJS**, and
  the editor cannot inherit a breaking change from it.
