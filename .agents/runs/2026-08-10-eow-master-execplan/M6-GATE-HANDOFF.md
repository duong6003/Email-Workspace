# Handoff — M6-GATE closed; M7-S1-quota (or M7-S2, M7-S3, M7-S4) is next

Written 2026-08-19, end of a session that executed the already-approved
`M6-GATE-PLAN.md` end-to-end (10 checkpoints, TDD throughout, one commit per
checkpoint), then closed the node. **Not pushed** — push requires separate,
explicit confirmation in whatever session does it; one approval never covers
a future push. `origin/main` was last known at `7d2eec0` (M5-GATE) as of the
M6-S1 handoff; this session did not check whether a different session has
since pushed further — verify with `git fetch` before assuming anything
about `origin/main`'s current tip.

This document is a **handoff for a fresh session** — not a continuation of
the current one. It gives you state and pointers; it deliberately does not
re-derive content that already lives in `state.json`, `traceability.csv` or
`EXECPLAN.md` — read those directly.

## Where to work

Checkout: `C:\Works\Projects\Email operations workspace\email-operations-workspace`,
branch `main`. HEAD is this session's own closing commit for `M6-GATE` (9
checkpoint commits, `M6-GATE CP0` through `M6-GATE CP8`, plus this closing
commit, sitting directly on top of `88d6a16`/CP7, which sits on `e7d284a`,
the prior M6-S4 close). Docker stack (`api`/`web`/`worker`/`scheduler`/
`postgres`/`redis`/`mailpit`) was running throughout, healthy. This session
**also ran two host-side dev servers** (`:3000` api via `pnpm --filter
@eow/api dev`, `:5173` web via `pnpm --filter @eow/web dev`, the
`tsc --watch`+`node --watch` pattern from `scripts/backend-dev.mjs`) for
Playwright visual-evidence capture — both were stopped at the end of this
session (confirmed via `taskkill`, ports free). **Check `netstat -ano | grep
-E ':3000 |:5173 '` before starting fresh ones anyway**, matching the
standing precedent every prior visual-capture session's handoff has
repeated. This session also found and killed one **stale leftover** host api
server on `:3000` at its own start (a different, older process than the ones
it later started itself) — confirm none are stuck before assuming a clean
slate.

## Mandatory read order (per `AGENTS.md` §1 — do not skip)

1. `AGENTS.md` — the protocol itself.
2. `.agents/runs/2026-08-10-eow-master-execplan/state.json` — `M6-GATE`'s own
   entry (now `completed`, full evidence array across all 9 checkpoints) and
   whichever `M7-S*` node you pick up (`M7-S1-quota`, `M7-S2-security-
   hardening`, `M7-S3-observability`, `M7-S4-deployment-backup` — all four
   now `pending`, all `dependsOn: ["M6-GATE"]`, all now unblocked;
   `currentNode` is set to `M7-S1-quota` but the four are otherwise
   independent and any order is legitimate). `M7-S5-perf-a11y-visual`
   depends on all four and stays blocked until they close.
3. `.agents/runs/2026-08-10-eow-master-execplan/traceability.csv` — the
   authority on rule status. 27 of 28 M6 rules are `closed`; `BR-SEND-004`
   is `partially_closed` by design (`DEC-143`) — read its row directly, its
   remaining dimension (`TC-SEC-016`) is now explicitly **your** rule to
   close if you pick up `M7-S2-security-hardening`. `BR-NOT-013`'s row
   carries a live disclosure (`D-134`/`DEC-144`) about a small pending fix in
   another agent's worktree — see below.
4. `.agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md` — Discovery Log
   `D-133` through `D-139` and Decision Log `DEC-143`/`DEC-144` are all this
   node's own. Also note the new callout at the top of §18 (Progress table):
   that table has been stale since `M3-GATE` and was **not** backfilled by
   this node — `state.json` is the actual source of truth for node status,
   not that table.
5. `.agents/runs/2026-08-10-eow-master-execplan/M6-GATE-PLAN.md` — the plan
   this session executed, useful reference for the exact shape of the
   `ARCH-ASYNCAPI-CONFORMANCE` check, the gateway's baseline-connect
   capability, and the CSS/handoff-fidelity constraint this node re-learned
   the hard way (D-139).

## What this session completed (all committed, nothing pending)

Closed `M6-GATE` by proving its four success conditions with real, re-run
evidence rather than trusting the labels already on `traceability.csv`:

- **Condition 1** (rule closure): confirmed 27/28, with `BR-SEND-004`'s
  remaining gap explicitly disposed of (`DEC-143`) rather than force-closed.
  Strengthened `validate_plan.py`'s traceability evidence rule (now also
  requires `test_case_ids`/`log_or_metric_or_audit`, and verifies every
  referenced test file exists on disk) — errors for `M6` (this node's own
  ownership), warns for 34 pre-existing gaps in `M1`–`M5` (`D-133`,
  disclosed, not fixed — a real re-audit of five already-closed gates, out
  of scope here). Filled all 16 `BR-NOT-*` `log_or_metric_or_audit` cells
  with evidence read from the actual code.
- **Condition 2** (test mapping/execution): re-verified all 16 `TC-HIS-*`/
  `TC-SEND-*` progress-subset mappings, ran every real test file backing
  them (`apps/api` 9 files/58 tests, `apps/worker` 7 files/47 tests,
  `apps/web` 4 files/17 tests), all green after one standalone re-run each
  for three host-load-contention flakes (matching D-132's exact class, not
  regressions).
- **Condition 3** (visual verification): captured `reconnecting` for
  `UI-HIS-001`, `UI-HIS-002` and the notifications popover at all 3
  viewports (9 PNGs, `evidence/visual/M6-GATE/production/`), each
  individually inspected. This surfaced and fixed two real product defects
  along the way (`D-138`): neither `HistoryScreen.tsx` nor
  `NotificationPopover.tsx` nor `AppShell.tsx` ever opened the shared
  realtime socket at all (fixed server-side — `realtime.gateway.ts` now
  authenticates once per connection and always joins `user:{id}`, even with
  no job/campaign room requested — exercised end-to-end via the existing
  dev-only `__eowSocket` escape hatch, **not** by wiring `AppShell`'s own
  connection lifecycle, which stays open — see below), and a CSS
  negative-margin overlap in the popover's own reconnecting banner. Also
  de-staled `screen-catalog.yaml`: `UI-HIS-001`/`UI-HIS-002` flip from
  `not_inventoried` to `migrated` with real `states_covered` for all 6
  required states each; `UI-SHELL-001.states_covered.reconnecting` no longer
  reads the stale `deferred_to_M6-S1` (`D-136`).
- **Condition 4** (AsyncAPI conformance): wrote the first-ever mechanical
  check over `contracts/asyncapi.yaml`/`catalog/realtime-events.json`
  (`packages/architecture-tests/src/asyncapi-conformance.test.ts`, 5 tests).
  It found a real, already-shipped defect on its first run: `rt.connection.
  ready` was emitted with no `tenant_id` (a required `EventEnvelope` field)
  from the moment M6-S1 shipped it (`D-135`) — fixed and proven on the wire
  with a new integration test, not just in the source.

**Final workspace baseline this handoff is written against** (CP8, after
this node's own code, re-confirmed clean by CP9's own re-check):

- `apps/api`: 89 files / 647 tests / 0 skipped / 0 failed (+2 from M6-S4's
  own 644/645 baseline: the two new gateway baseline-connection tests)
- `apps/worker`: 29 files / 139 tests / 0 skipped / 0 failed (unchanged from
  M6-S4's own baseline; the D-127 `progress-reconcile` starvation exception
  **did not trigger** on this run — it is data-dependent on the shared dev
  database's current candidate count, not fixed; `task_fc02ed64` is still
  open, still uncommitted — do not assume it landed just because one run
  happened to pass clean)
- `apps/web`: 23 files / 73 tests / 0 skipped / 0 failed (+4: `CP5`'s
  `shouldRefetchOnReconnect`)
- `packages/architecture-tests`: 16 files / 119 tests / 0 skipped / 0 failed
  (+1 file/+5 tests: the new `asyncapi-conformance.test.ts`)

`pnpm typecheck` and `pnpm build` both clean across the whole workspace.
`docker compose --env-file .env config --quiet` exits 0. `validate_plan.py`:
`ERRORS: 0`, `WARNINGS: 1` (the D-133 cross-milestone disclosure, expected
and unchanged since CP1).

**Seven discoveries this session** (`D-133` through `D-139`), **two
decisions** (`DEC-143`/`DEC-144`), all with evidence, none silently
absorbed:

- **D-133**: the strengthened `validate_plan.py` traceability rule found 34
  pre-existing `log_or_metric_or_audit` gaps in `M1`–`M5`, all already
  closed at five earlier gates. Scoped to a warning, not fixed — a real
  five-milestone re-audit, out of this node's ownership.
- **D-134**/**DEC-144**: `BR-NOT-013`'s `purgeExpired()` returns a wrong
  count (always `2`, the raw `[rows, affectedCount]` tuple length from a
  `DELETE ... RETURNING` under TypeORM — the second of D-125's two disclosed
  instances). No rule's observable behaviour is affected (both call sites
  discard the return value). **The fix already exists**, written and tested,
  sitting uncommitted in `.claude/worktrees/kind-wozniak-055662` under the
  D-125 follow-up task — re-check that worktree before doing anything here;
  if it's still uncommitted, land it or leave it, but do not re-implement it
  fresh (it would collide with that agent's own file).
- **D-135**: `rt.connection.ready` shipped with no `tenant_id` from M6-S1
  CP7 onward — fixed this session, confirmed via `ARCH-ASYNCAPI-
  CONFORMANCE` and a real-socket integration test.
- **D-136**: `screen-catalog.yaml` de-staled for `UI-HIS-001`/`UI-HIS-002`/
  `UI-SHELL-001.reconnecting`. A mechanical safety-net check (flag a
  `not_inventoried` screen whose rules are all closed) was considered but
  **not** added — after the fix, zero screens are `not_inventoried`, so
  there was nothing live to verify the check against. Left as a concrete,
  ready-to-implement recommendation for whichever future gate next finds a
  stale screen.
- **D-137**: the notification center has **no socket-push implementation at
  all** — `notification.created`/`updated`/`read` are declared AsyncAPI
  channels with zero emission sites; `AppShell.tsx`'s unread badge fetches
  once on mount with no poll and no socket listener. Not fixed (violates no
  rule's literal text; the REST API being the *only* source is a strictly
  stronger form of `BR-NOT-012`'s own guarantee). A real UX gap — a
  reasonable `M7`-era polish candidate, not urgent.
- **D-138**: the actual mechanism behind D-137's user-facing symptom, found
  by CP6's own first (7/9 failed) Playwright run: `HistoryScreen`/
  `NotificationPopover` never open the shared socket at all, so
  `reconnecting` was **unreachable** from a cold direct navigation, not
  merely stale. Fixed server-side (gateway now supports a baseline
  connection with no room request); **`AppShell`'s own proactive-connect
  wiring is deliberately still open** — doing it would require
  `subscribeToCampaigns`/`subscribeToJobs` to also handle "already
  connected, auth changed" by forcing a reconnect, a materially bigger and
  riskier change to already-closed, already-tested M6-S1 code than this
  gate's own verification scope warranted. **If a future node wants live
  notification push or an always-fresh history list, D-137/D-138 together
  are the starting point** — the server-side capability already exists and
  is tested; only the client's proactive-connect half remains.
- **D-139**: this node's own CP6 CSS fix briefly broke `ARCH-HANDOFF`
  (spliced into the middle of an approved handoff line instead of appended
  as a new one) — caught by CP8's own full-suite run, fixed immediately,
  re-verified visually.

## Open background work — check status before assuming either is done

- **`task_fc02ed64`** ("Fix progress-reconcile scan starving newest
  executions", D-127) — **still open at the end of this session**, unchanged
  since the M6-S4 handoff. Worktree `.claude/worktrees/reverent-wiles-
  aa8740`, branch `claude/reverent-wiles-aa8740`, still at `9843e6e`, still
  uncommitted:
  ```text
  M  apps/worker/src/progress-reconcile.ts
  M  database/migrations.lock.json
  ?? apps/worker/src/progress-reconcile-scan-order.integration.test.ts
  ?? database/migrations/031_reconcile_scan_newest_first.sql
  ```
  `031` is still that task's own claimed migration number. This node used no
  migration, so there is still no numbering collision — but the next node
  that *does* need one should re-check this worktree first; if `031` has
  landed, the next free number is `033` (`032` is `M6-S4`'s, already on
  `main`; `033` was independently claimed and then apparently abandoned by
  `task_c753bff4` — see below, worth re-verifying before reusing `033`
  either).
- **`task_c753bff4`** ("Purge expired export_job artifact bytes", D-131) —
  **landed a real commit this session, but not on `main`.** It was
  discovered mid-session working directly in the *primary* checkout (not
  its own worktree) — files appeared in `git status` here at this session's
  own CP0/CP2/CP3 checkpoints (`apps/worker/src/export-purge.ts`,
  `database/migrations/033_export_artifact_purge.sql`, edits to both
  `main.ts` files, `apps/api/src/campaigns/exports.service.ts`) — then, by
  CP8, had **relocated** to its own worktree
  `.claude/worktrees/eloquent-euclid-bfa229` (branch
  `claude/eloquent-euclid-bfa229`) and committed there as `ad78eaf`
  ("D-131: purge expired export_job artifact bytes"), on top of `e7d284a`
  (M6-S4's own close). Not merged/rebased onto `main`. Read that commit
  before touching `export_job`, `migration 033`, or either `main.ts`.
- **The D-125 follow-up task** (untracked, no `task_*` id recorded in any
  prior handoff — referenced only as "the D-125 follow-up task") —
  **still open**, worktree `.claude/worktrees/kind-wozniak-055662`, branch
  `claude/kind-wozniak-055662`, at `b3cfbd6`, still uncommitted:
  ```text
  M  apps/api/src/notifications/notifications.service.ts
  M  apps/api/src/segments/segments.service.ts
  M  apps/api/test/integration/notifications.test.ts
  M  apps/api/test/integration/segments.test.ts
  ```
  This is `D-134`/`DEC-144`'s own fix (`purgeExpired()`'s wrong return
  value) plus an unrelated `segments.service.ts` fix (the same D-125
  TypeORM `RETURNING` mistake, a different disclosed instance). Land it or
  leave it — do not re-implement either fix fresh in the primary tree.

## Next: pick any of `M7-S1-quota`, `M7-S2-security-hardening`,
## `M7-S3-observability`, `M7-S4-deployment-backup`

All four are now unblocked (`dependsOn: ["M6-GATE"]`, `M6-GATE` now
`completed`). `M7-S5-perf-a11y-visual` depends on all four together and
stays blocked. `state.json`'s own node entries carry each one's success
conditions — read them directly. Two cross-references worth knowing before
you pick one:

- **If you pick `M7-S2-security-hardening`**: `TC-SEC-016` (the 10,000-
  connection SSE load test) is explicitly yours to run — it is `BR-SEND-004`'s
  own remaining dimension (`DEC-143`), so `BR-SEND-004` only flips from
  `partially_closed` to `closed` once you run it. If this host genuinely
  lacks the staging infrastructure `TC-SEC-016` needs (the same reason M6-S1
  declined it), that is worth confirming directly rather than assuming —
  infrastructure availability can change between sessions.
- **If you pick `M7-S1-quota`**: `BR-SCH-004`'s own remaining dimension
  (quota, per `DEC-088`/`DEC-120`) is yours too — its `M5`-scoped acceptance
  is already closed and tested; only the quota-ledger half is unclosed.

### Worth checking early, whichever you pick

- Re-read `D-137`/`D-138` before assuming anything about realtime
  notification delivery — the mechanism now exists server-side (a baseline
  socket connection can authenticate and join `user:{id}` with no
  job/campaign room requested) but nothing in production code opens one
  proactively, and no notification event is ever published over it either.
  Neither gap blocks any `M7-*` rule directly as far as this session could
  tell, but confirm against your own node's actual acceptance text rather
  than trusting this summary.
- `D-133`'s 34-row cross-milestone `log_or_metric_or_audit` gap is a
  `WARN`, not an `ERROR`, in `validate_plan.py` — it will not block your own
  node's `pnpm run check`/`validate_plan.py` runs, but if your own node's
  own success condition ever reads the traceability rows more strictly than
  the mechanical check does, don't assume the warning means nothing.

## Non-obvious environmental notes (carry forward — established over many sessions)

- Host-run tests vs. docker-composed containers is a real split, unchanged:
  integration tests run host-side against the same Postgres/Redis the
  containers use (`eow` database, ports 55432/56379), while `api`/`web`/
  `worker`/`scheduler` run containerized. **New this session**: E2E/visual
  Playwright capture needs *host-run dev servers* too (`:3000` api via
  `pnpm --filter @eow/api dev`, `:5173` web via `pnpm --filter @eow/web
  dev`) — distinct from both the docker stack and the integration-test
  database connection. `apps/api`'s `pnpm dev`/`tsx watch` is broken for
  real NestJS DI (D-20/D-22, established at M1-S1) — `scripts/backend-
  dev.mjs`'s `tsc --watch` + `node --watch dist/main.js` pattern (what
  `pnpm --filter @eow/api dev` actually runs) is the correct one and was
  used throughout this session; do not try `tsx watch src/main.ts` directly.
- `apps/web`'s host dev server needs `DATABASE_URL`/`REDIS_URL`/
  `SESSION_SECRET` resolved from `.env`'s `EOW_POSTGRES_*`/`EOW_REDIS_*`/
  `EOW_SESSION_SECRET` vars, not a bare guess — `scripts/backend-dev.mjs`
  already does this construction; don't hand-roll `DATABASE_URL` from a
  guessed password (this session did, once, and got `password
  authentication failed` — the real values live in `.env`, read them).
- **`ARCH-HANDOFF` (`handoff-fidelity.test.ts`, DEC-009) treats
  `apps/web/src/app/globals.css` as line-exact against the approved handoff
  source** — every original physical line must remain byte-identical and in
  relative order; only wholesale *new* lines are free. A CSS edit that
  inserts new rules via string-match into the middle of an existing
  (possibly fully-minified, single-physical-line) approved rule block will
  fail this check even though the resulting CSS is semantically correct
  (D-139, this session's own mistake, caught and fixed). **Always append new
  CSS rules as genuinely new lines, never interleaved into an existing
  one** — check `tail` of the file for the established append point.
- `database/migrate.sh` hard-codes `migrations_dir='/database/migrations'`
  — an absolute in-container path. **Do not run it directly on the host.**
  Apply migrations via `docker compose --env-file .env run --rm migrate`.
  This node applied no migration, so this should not come up, but the next
  one likely will (`033` is contested — see `task_c753bff4` above).
- `pnpm run check`'s recursive test step aborts the whole run on the first
  package's first flake — drop to running each package's own `vitest run
  --maxWorkers=3` directly for a real, complete baseline (established since
  M5-GATE, reconfirmed every node since, reconfirmed again this session).
  `packages/architecture-tests`' full suite reliably takes 300–400s+ on this
  host under any load — run it in the background and wait for the real
  notification rather than polling.
- `*.log` files are globally gitignored (`.gitignore:5`) — narrate
  script-run evidence in `state.json`'s evidence array instead of force-
  adding a log file, per established precedent.
- `packages/contracts/src/openapi.d.ts` is gitignored (generated output,
  `packages/contracts/.gitignore:1`) — `pnpm contracts:generate` regenerates
  it locally; do not try to `git add -f` it.
- **Three agents were live in overlapping worktrees/the primary tree
  throughout this session** — none of this run's file-level concurrency
  guarantees are new, but this is the first node where the collision was
  directly observed mid-session (a concurrent agent's files appearing and
  then disappearing from `git status` on the primary tree as it relocated
  to its own worktree). Snapshot `git status --porcelain` and every relevant
  worktree's own status at the *start* of any future node, not just once —
  state can shift mid-session even without you touching anything.

## Working discipline (unchanged, carried forward from every prior node)

- Evidence before status — never flip `closed`/`completed` before the
  artifact justifying it exists and has been re-run.
- Compare the workspace check's test *and skip* count against the previous
  node's own baseline (this handoff's own numbers above), not just exit
  code.
- Real bugs found during work get fixed at the root cause and disclosed
  (`D-*`/`DEC-*`), not silently worked around — unless the bug is in an
  already-closed node's code outside this node's own rule ownership, in
  which case disclose via a spawned background task or a plain disclosure,
  matching the D-125/D-127/D-131/D-134/D-137 precedent — this node's own
  D-133/D-136/D-138/D-139 are all instances of catching real drift/defects
  *within* its own scope and fixing them directly, which is the correct
  contrast to draw.
- A green test/Playwright run is not evidence by itself — individually
  inspect visual captures before trusting them (D-78/D-104/D-126's own
  discipline, reconfirmed twice this session: once by CP6's own popover CSS
  defect, found only by looking at the screenshots, not by the passing
  assertions).
- Run every package's full suite at real parallelism (`--maxWorkers=3`) at
  least once before calling any node done, and re-run any suite that fails
  once before treating the failure as a regression rather than host-load
  noise.
- Commit at every checkpoint, one commit per logical step, per `AGENTS.md`
  §2 — this node's own work was 9 commits (one per checkpoint), not one
  giant commit, by design. Stage files explicitly at every commit — never
  `git add -A`/`git add .` — while another agent's live files may be sitting
  in the same tree.
- Push/merge-commit actions require separate, explicit per-instance user
  confirmation — this session did not push; do not assume a future push is
  pre-approved by any prior session's approval.

## Suggested skills for the next session

- **`superpowers:writing-plans`** — whichever `M7-S*` node you pick is a
  fresh vertical slice, not a verification node; a proper implementation
  plan is worth writing rather than improvising checkpoint-by-checkpoint,
  same as every `M1`–`M6` slice before it.
- **`superpowers:verification-before-completion`** — before flipping any
  `M7-S*` node to `completed`; `M7-S5`/`M7-GATE` both depend on all four
  transitively.
- **`superpowers:systematic-debugging`** — for triaging any of this host's
  now eleven documented flake/bug classes (D-93, D-94, D-118, D-120, D-121,
  D-124, D-126, D-127, D-132, D-138, D-139) if one resurfaces, before
  assuming a new one.
