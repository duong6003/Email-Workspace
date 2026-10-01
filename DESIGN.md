# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-08-11
- Primary product surfaces: `apps/web`, with the approved handoff installed under `design-reference/ui-handoff-v2/source`.
- Evidence reviewed: `design-reference/ui-source-contract.yaml`, `design-reference/visual-acceptance.md`, existing app routes/screens/overlays, globals, fonts, icons, and current visual evidence.

## Brand
- Personality: operational, calm, precise, and trustworthy.
- Trust signals: durable status, explicit permission/error states, auditability, and canonical server data.
- Avoid: redesigning approved handoff layouts, decorative novelty, hidden background actions, or token-bypassing legacy CSS.

## Product goals
- Goals: make recipient, template, campaign, delivery, and notification operations understandable and recoverable.
- Non-goals: inventing a new visual system or making realtime payloads authoritative.
- Success signals: complete states, predictable workflows, visual-equivalence evidence, and accessible operation at every viewport.

## Personas and jobs
- Primary personas: administrators, campaign operators, and read-only viewers.
- User jobs: manage recipient data, compose and schedule campaigns, monitor progress, recover failures, and audit outcomes.
- Key contexts of use: desktop operations, tablet review, and constrained mobile checks.

## Information architecture
- Primary navigation: the approved application shell and route permissions in `apps/web/src/app`.
- Core routes/screens: those inventoried by the registered UI handoff and `screen-catalog.yaml`.
- Content hierarchy: shell navigation, screen heading/toolbar, canonical data/status, contextual overlays.

## Design principles
- Preserve the approved handoff presentation while replacing mocks with accepted behavior.
- REST/PostgreSQL state is authoritative; realtime is a refetch/reconciliation hint.
- Every workflow exposes loading, empty, error, success, permission-denied, and reconnecting states where applicable.
- Extend existing components and tokens before creating new vocabulary.

## Visual language
- Color, typography, spacing, radii, elevation, motion, and icons are owned by the registered handoff, `apps/web/src/app/globals.css`, `fonts.css`, and `ui-icons.tsx`.
- Do not restore legacy root CSS or hard-coded non-token values.

## Components
- Reuse: AppShell, module frames/cards/toolbars, status pills, tables, overlays, icons, error/permission screens.
- Variants and states: derive from existing production components and handoff markup.
- Ownership: presentation in the handoff/global tokens; behavior in business rules and API/realtime contracts.

## Accessibility
- Target standard: WCAG 2.1 AA.
- Keyboard/focus: visible focus, logical traversal, trapped/restored overlay focus.
- Semantics: one primary landmark/heading, labelled controls, meaningful table headers and status text.
- Respect reduced motion; never encode meaning by color alone.

## Responsive behavior
- Desktop 1440×900, tablet 768×1024, mobile 390×844.
- Preserve handoff adaptations and validate touch targets, overflow, tables, and overlays at all three sizes.

## Interaction states
- Loading, empty, error, success, disabled, permission-denied, and reconnecting states are explicit and testable.
- Slow/offline behavior must preserve user input where safe and expose retry/reconciliation.

## Content voice
- Tone: concise, factual, actionable.
- Terminology follows BA rules, contracts, and approved Vietnamese handoff copy.
- Errors explain impact and the next safe action without exposing internals.

## Implementation constraints
- Framework: React/Vite with existing CSS/tokens and typed API clients.
- Root structure: only `main.tsx` directly under `apps/web/src`; modules live in canonical directories.
- Performance: large import tooling remains lazy-loaded.
- Tests: typecheck/build/unit/integration plus three-viewport screenshots and material-difference notes.

## Open questions
- [ ] Revisit remaining handoff-absent screens only when their milestone reaches implementation; use existing vocabulary and record the decision.
