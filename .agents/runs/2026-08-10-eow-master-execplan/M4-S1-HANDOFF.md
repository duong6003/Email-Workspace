# Handoff — execute M4-S1-campaign-draft, checkpoints 5-7

Written 2026-08-13, updated same day after checkpoint 4 closed. Checkpoints 0-4 are **done
and committed**. Checkpoints 5-7 (frontend, traceability closure, final verification) are yours.

---

## Where to work

**Primary checkout:** `C:\Works\Projects\Email operations workspace\email-operations-workspace`
Branch `main`, HEAD `a571d00`. Do not work in `.claude\worktrees\next-step-2ae237` — it only
holds a stale copy of the checkpoint-0 files and was abandoned early on.

## Read these first, in this order

1. `AGENTS.md` — the mandatory protocol. Sections 2 (autonomous task protocol, UTF-8 rule,
   commit-per-checkpoint rule), 2.1 (approved UI handoff), 5 (change and stop gates), 6 (DoD).
2. `.agents/runs/2026-08-10-eow-master-execplan/M4-S1-CAMPAIGN-DRAFT-PLAN.md` — **your spec.**
   Scope, hard non-goals, the locked data contract, the 428/404/409/412 precedence, the
   completeness formula, checkpoints 1-7, Appendix A (exact endpoint table, zod schema sketch,
   commands). Do not re-derive any of it here.
3. `.agents/runs/2026-08-10-eow-master-execplan/state.json` node `M4-S1-campaign-draft` — read
   its full `evidence` array before touching anything. It is the ground truth for what checkpoints
   1-4 actually built, more precise than this doc's summary below.
4. `.agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md` §19 D-38 through D-41 (this run's
   recent discoveries), §9 "M4-S1 — Campaign draft" (the 7-step sequence), §18/§20 (you append
   progress and any new decisions here).

## What's already built (checkpoints 0-4, commits `f17ac72`..`a571d00`)

- **Backend persistence is real and tested.** `apps/api/src/campaigns/{campaigns.controller,
  campaigns.service,campaigns.repository}.ts` + `dto/campaign.dto.ts` + `CampaignEntity`. Six
  endpoints exist: `GET/POST /campaigns`, `GET/PATCH/DELETE /campaigns/:id`,
  `POST /campaigns/:id/duplicate` — full table and status-code precedence in the plan's
  Appendix A.3. The original mock `progress`/`schedule`/`send`/`cancel` handlers are untouched.
- **`campaign-completeness.ts`** is the single authoritative 5-component, 20-point score. Web
  code should render this number, never recompute it.
- **Migrations 017 and 018** are applied to the shared local Postgres (idempotent re-run
  confirmed). 017 added the draft columns, the non-blank-name CHECK, the drafts index, and the
  edit-after-send trigger. **018 is a correction, read D-41 in EXECPLAN before you write any new
  status-handling code**: `campaign.status` accepts the full 10-value BR-SEND-001 domain
  (`draft, scheduled, queued, validating, sending, paused, completed, partial_failed, failed,
  cancelled`), not just the 6 this slice writes.
- **OpenAPI is additive and regenerated.** `contracts/openapi.yaml` has real schemas for
  `Campaign`/`CampaignSender`/`CampaignAudience`/`CampaignSettings`/list+create+update request
  bodies; `packages/contracts` regenerated; `contract-shape.check.ts` has 3 new compile-time
  proofs. Compat-check and redocly bundle both pass.
- **Current measured baseline (post-checkpoint-4, run twice, both green):**
  `pnpm -r --workspace-concurrency=1 test` → **71 files / 321 tests / 0 skipped / 0 failed**
  across 6 workspaces; `apps/api` specifically **41 files / 265 tests**. This is the number
  checkpoint 7 compares against — not the 248-test pre-node number in the plan's Appendix A.1,
  which is now stale (superseded by this section).

## A defect was found and fixed while verifying checkpoint 4 — know this before you write status logic

Migration 017's `campaign_status_known` CHECK and `contracts/openapi.yaml`'s `Campaign.status`
enum both independently listed only the 6 statuses this slice writes, not BR-SEND-001's full
10-value state machine. It surfaced as a regression in an unrelated M2 test, not inside this
slice. Fixed by migration 018 and a matching OpenAPI edit — see EXECPLAN D-41 for the full story.
The lesson that applies directly to your checkpoints: **when you touch anything that encodes a
business rule's domain (an enum, a CHECK, a status union type), copy the rule's literal list,
not just the values the current slice happens to produce.** BR-CMP-011's own acceptance text
("PUT trả 409" for `sending`/`completed`) is the one this slice cares about; don't narrow the
column's own CHECK to match, it already covers the full domain correctly as of 018.

## Environment facts that cost previous sessions real time

- **Local infra is already up**: postgres `127.0.0.1:55432`, redis `127.0.0.1:56379`, mailpit
  `8025`, plus running `api`/`web`/`worker`/`scheduler` containers from an earlier build. The
  campaign migrations already applied against this same database — every future column you add
  still needs a DEFAULT so those containers keep working.
- **`.env` exists at the repo root**, gitignored, with locally generated secrets. Never print,
  commit, or copy it.
- **`pnpm` may not be on PATH.** Run `corepack enable` once per shell if bare `pnpm` fails.
- **`tsx watch` silently breaks NestJS constructor DI on this host** (D-22): use the
  tsc-compiled `dist/main.js` for any live/browser verification (DEC-022). Vitest is unaffected.
- **Write every file as UTF-8 explicitly** — Windows-1252 console codepage has silently
  corrupted Vietnamese text three times already (ARCH-ENCODING).
- **The workspace test run is intermittently red on its first pass** (D-40): a compiled-process
  spawn in `boot.test.ts` can time out under full-suite CPU contention. Re-run once before
  investigating; do not close the node on a suite that needed two runs to look green.

## Patterns to copy, not invent

The templates module (M3-S1/S2/S3) and this node's own `apps/api/src/campaigns/` are the
freshest examples of the shape `packages/architecture-tests` enforces: `runInTenantContext`,
`TenantScopedRepository`, `@RequirePermission`/`@UseGuards(CsrfGuard)`/`@AuditLog`, `.strict()`
zod schemas in `dto/`. Reuse the campaigns module's own conventions for checkpoint 5's web code
where an equivalent already exists (e.g. `apps/web/src/api/templates.ts` for the API-client shape).

## One open question the user has not explicitly answered

The BR-CMP-012 campaign-name field has no counterpart in the approved handoff's compose form
(`Cấu hình gửi`, `Người nhận`, `CC`, `BCC`, `Tiêu đề` only). The plan's standing answer — add it
using the handoff's own `Field` vocabulary, record it in `screen-catalog.yaml` `diff_notes` as an
addition required by an accepted business rule, precedent `DEC-034`/`UI-CF-001` — was not
contradicted by the user, and checkpoints 1-4 already assume the campaign entity has a mandatory
`name`. Proceed on it for checkpoint 5, record it as a numbered EXECPLAN decision, and surface it
plainly in your completion report. If you find it genuinely conflicts with the approved UI in a
way the precedent doesn't cover, that is a STOP gate under AGENTS.md §2.1 — stop and say so.

## Checkpoints 5-7, concretely

**Checkpoint 5 (web):** `apps/web/src/api/campaigns.ts` (+ `.test.ts`) — thin client over the
six endpoints, `If-Match` handling included. `apps/web/src/screens/compose/ComposeDraftScreen.tsx`
ports the handoff's `Composer` DOM (`compose-grid`/`compose-card`/`compose-fields`), adds the
name field, autosaves via a debounced PATCH carrying the last-known `ETag`/version (write this as
a pure, unit-tested reducer per the plan's risk table — one in-flight save at a time, queue the
next with the version the previous response returned). `apps/web/src/screens/drafts/
DraftsScreen.tsx` ports the handoff's `Drafts` DOM (`module-card drafts-card`, `draft-summary`,
`draft-list`, `draft-progress`, `row-menu`) with real data and real completeness, plus the four
required states the handoff lacks (loading/empty/error/permission_denied — success is the ported
DOM itself). Wire both into `apps/web/src/app/AppRoutes.tsx`, replacing the current
`ComposeVariablesScreen`/`ComingSoon` mounts at `/email/compose` and `/email/drafts`
(`ComposeVariablesScreen`'s variable panel should be absorbed into the new compose screen, not
deleted — M3-S2's variable catalogue is still real and still needed).

**Checkpoint 6 (traceability):** close `BR-CMP-001`, `BR-CMP-011`, `BR-CMP-012` in
`traceability.csv` with real `code_paths`/`test_files`/`openapi_operation_ids`/
`log_or_metric_or_audit` — never a closed status beside blank columns. Update `screen-catalog.yaml`
for `UI-EMAIL-001` (currently `partially_migrated`) and `UI-EMAIL-002` (currently
`not_inventoried`). Append to EXECPLAN §18 (progress table + a "what changed" subsection like
M1-S2's) and §20 (the campaign-name decision, at minimum).

**Checkpoint 7 (verification and close):** `pnpm -r typecheck`/`test`/`build`, comparing against
**this doc's 71 files / 321 tests / apps/api 265 tests** baseline, not the older 248-test one.
Playwright e2e + axe for both new screens. Visual capture at 1440x900/768x1024/390x844 under
`.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M4-S1-campaign-draft/production/` —
look at the images, don't just save them. `docker compose --env-file .env config --quiet`.
Migrations re-applied idempotently. Then write final node evidence into `state.json` and flip
`M4-S1-campaign-draft` to `completed`, with `nextAction: null`.

## Definition of done for this node

All three `successConditions` independently checkable:

1. Compose creates and autosaves a real draft with `If-Match` optimistic concurrency. **(done —
   backend; checkpoint 5 wires the UI)**
2. Drafts list shows real drafts with real completeness. **(done — backend; checkpoint 5 wires
   the UI)**
3. `BR-CMP-001`, `BR-CMP-011`, `BR-CMP-012` `closed` in `traceability.csv` with real evidence.
   **(checkpoint 6)**

## Working discipline

Stated directly since this run is executed by Codex, which has no skill system.

- **RED before GREEN, literally.** Checkpoint 5's autosave reducer and any new unit needs a
  failing test watched first. `arch_contracts`/`d85924d` caught real TypeORM bugs this way that
  the looser vitest transform hid — run `tsc --noEmit` too whenever you touch a jsonb column.
- **Evidence before status.** Never write `closed`/`migrated`/`completed` before the artifact
  that justifies it exists and has been re-run.
- **Don't guess at failures.** Reproduce, isolate, then fix — see the D-41 fix above for what
  that looks like in this repo: a failing sibling test led to the real CHECK, not a workaround.
- **Re-read your own diff before each commit** as if reviewing someone else's. M3-S2/M3-S3 each
  needed two rounds of review correction, and M3-GATE still found a shipped API with no UI.
  Checkpoint 4 itself needed exactly this kind of pass — the fix in commit `a571d00` was found
  by re-verifying Codex's own passing work, not by Codex missing a step.
- **Checkpoint the node state before you stop**, whatever state it is in. `state.json`'s
  `evidence` array is the resume point for whoever picks this up next.
