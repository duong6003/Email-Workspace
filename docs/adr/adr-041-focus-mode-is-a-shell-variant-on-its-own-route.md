# ADR-041: Focus mode is an AppShell variant, on its own route

Status: Accepted

Implements the UI half of ADR-037 §4 (the editor lives in `apps/web`) and ADR-009's
route-level embedding with a compact host header. Decides the two things S3 could not start
without: **where focus mode lives in the component tree**, and **what its URL is**.

## Context

`AppShell` wraps every authenticated route through `<Outlet />` and supplies a 260px
sidebar, a 60px utility bar, a `page-header` with `<h1>` and description, and a footer.
ADR-009 requires the opposite for the builder: a 56px compact header and the rest of the
viewport given to the canvas.

Three placements were possible. Two constraints that looked decisive turned out not to be,
and two that looked minor turned out to be.

**`AppShell.tsx` is not frozen.** `ARCH-HANDOFF`
(`packages/architecture-tests/src/handoff-fidelity.test.ts`) protects exactly two files —
`globals.css` and `ui-icons.tsx` — and its invariant is subtractive: *"Additions are free;
edits and deletions are not."* So the shell component can gain a second layout, and focus-mode
CSS can be appended to `globals.css`, provided no approved line is touched.

**Varying the shell by route is established practice, and carries a recorded lesson.**
`page-meta.ts` already exposes `isAutosaveRoute` and `isCampaignComposeRoute`, and its comment
explains why they are two predicates rather than one: folding them together *"put send buttons
on a screen that cannot send"*.

**Leaving the shell costs the theme.** `theme-${theme}` and `theme-dark` are applied to
`main.app-shell` (`AppShell.tsx:109`). A route mounted outside it inherits no theme class at
all, so dark mode silently stops working — which the conventions spec §2.3 requires.

**Leaving the shell costs the save-state channel.** `TemplateEditorScreen.tsx:87` reports
autosave state upward with `useOutletContext<SetShellSaveState>()`, exactly as
`ComposeDraftScreen` does. A sibling route outside the shell would have to rebuild that.

## Decision

**1. Focus mode is a variant of `AppShell`, not a route outside it.** The builder route stays
under the existing `RequireAuth` → `AppShell` → `<Outlet />` chain. When the route is a focus
route, the shell renders a compact header in place of the sidebar, utility bar, page header
and footer; auth, theme, notifications, realtime status and the save-state context stay wired
exactly as they are for every other screen.

The predicate is **narrow and single-purpose** — `isFocusRoute(pathname)` decides layout and
nothing else — following the lesson `page-meta.ts` records rather than reusing
`isAutosaveRoute`, which answers a different question and happens to be true for the same
route today.

**2. The builder gets its own path: `/templates/:templateId/build`.** Not a mode of
`/templates/:templateId/edit`.

This is forced by mechanics, not taste. `origin` decides which editor a template opens in, but
the shell must choose its chrome **before** any template is fetched. A single route
dispatching on `origin` would make the layout depend on data the shell does not have and has
no business fetching, producing a chrome flash on every open. A pathname answers
synchronously.

The URL split costs nothing in practice because the listing already carries `origin`:
`TemplateSummaryResponse` omits only `html`, `textBody` and `projectData`, so
`TemplatesScreen` links each row straight to the correct editor. `/templates/:id/edit`
redirects to `/build` when it loads a `builder` template, purely as a safety net for stale
links.

## Consequences

- **`AppShell` gains a second layout, and that is the honest cost.** It is one file
  branching on one predicate rather than two shells drifting apart, but it does grow. The
  mitigation is the narrow predicate: anything beyond layout that wants to vary by route gets
  its own predicate, per the precedent above.
- **Focus mode becomes a shell capability, not a builder feature.** The campaign composer
  could adopt it later without new plumbing. That is a side effect, not a commitment — nothing
  is built for it now.
- **The compact header owns Back, document title, save state, preview and publish** (ADR-009),
  and Back must implement the four-layer order in the conventions spec §2.11, including the
  Save draft / Discard / Stay confirmation. Back never silently discards.
- **All focus-mode CSS is appended.** No approved `globals.css` line may be edited to make the
  new layout fit; where an existing rule targets the wrong surface, the fix is a new class in
  the JSX, which is the precedent set by
  `2026-08-26-template-editor-layout-and-thumbnails-design.md` §3.
- **`routePermissions` gains `/templates/:id/build` at `content:read`**, matching the editor
  route. Read-only for a caller without `content:manage` is enforced inside the screen, not at
  the route, because gating the route blanks it — conventions spec §2.1.
- **Below 1024px the builder does not render its canvas** (conventions spec §2.2). Focus mode
  must therefore degrade to the management view or an explanation, not to a broken layout,
  and that behaviour belongs to the route rather than to the shell.
