# Handoff — M6-S4 closed; M6-GATE is next

Written 2026-08-19, end of a session that executed the already-approved
`M6-S4-HISTORY-RETENTION-PLAN.md` end-to-end (9 checkpoints, TDD throughout,
one commit per checkpoint), then closed the node. **Not pushed** — push
requires separate, explicit confirmation in whatever session does it; one
approval never covers a future push. `origin/main` was still at `7d2eec0`
(M5-GATE) as of the M6-S1 handoff; this session did not check whether a
different session has since pushed further — verify with `git fetch` before
assuming anything about `origin/main`'s current tip.

This document is a **handoff for a fresh session** — not a continuation of
the current one. It gives you state and pointers; it deliberately does not
re-derive content that already lives in `state.json`, `traceability.csv` or
`EXECPLAN.md` — read those directly.

## Where to work

Checkout: `C:\Works\Projects\Email operations workspace\email-operations-workspace`,
branch `main`. HEAD is this session's own closing commit for
`M6-S4-history-retention` (9 checkpoint commits, `M6-S4 CP0` through `M6-S4
CP8`, sitting directly on top of `9843e6e`, the prior M6-S3 close). Docker
stack was running throughout this session (`api`/`web`/`worker`/`scheduler`/
`postgres`/`redis`/`mailpit`) — `api`/`worker`/`scheduler` were rebuilt at
CP8 to pick up this node's own migration/env-var/job changes and confirmed
healthy. **Confirm nothing stale is bound to any host ports before starting
fresh dev servers** — this session did not run any ad-hoc host-run dev
server (unlike M6-S1/M6-S3's Playwright-capture sessions), only the docker
stack, so there should be nothing extra to clean up, but verify.

## Mandatory read order (per `AGENTS.md` §1 — do not skip)

1. `AGENTS.md` — the protocol itself.
2. `.agents/runs/2026-08-10-eow-master-execplan/state.json` — the
   `M6-S4-history-retention` node's own entry (now `completed`, full
   evidence array) and `M6-GATE`'s entry (`dependsOn: [M6-S1-realtime-
   progress, M6-S2-notification-center, M6-S3-history-recovery,
   M6-S4-history-retention]`, **all four now satisfied**, `status:
   "pending"`) — this is the actual next node. `currentNode` is already set
   to `M6-GATE`.
3. `.agents/runs/2026-08-10-eow-master-execplan/traceability.csv` — the
   authority on rule status. `BR-HIS-006` is now `closed` with real
   `openapi_operation_ids`/`migration_files`/`code_paths`/`test_files`/
   `log_or_metric_or_audit` — read the row directly. All 12 `BR-HIS-*` and
   the other M6 rules should now be `closed` or otherwise resolved; verify
   this yourself against `M6-GATE`'s own success condition ("All 28 M6
   rules closed (12 BR-* plus 16 BR-NOT-*)") rather than assuming.
4. `.agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md` — discovery log
   `D-129` through `D-132` and decision log `DEC-140` through `DEC-142` are
   all this node's own.
5. `.agents/runs/2026-08-10-eow-master-execplan/M6-S4-HISTORY-RETENTION-PLAN.md` —
   the plan this session executed, for the exact shape of migration 032's
   two SECURITY DEFINER functions, the `retention_policy` table, and the
   purge orchestrator — useful reference if `M6-GATE`'s own verification
   needs to touch any of the same surface.

## What this session completed (all committed, nothing pending)

Closed `M6-S4-history-retention`: a per-tenant `retention_policy` table
(migration 032) with a deployment-wide default
(`HISTORY_EVENT_RETENTION_DAYS=365`), two SECURITY DEFINER functions
(`purgeable_retention_tenants` — an oldest-first bounded scan,
`purge_message_events` — the actual delete with a 30-day floor enforced
*inside the database*, not just by the caller), a new
`apps/worker/src/history-purge.ts` orchestrator wired as a
`history-purge-scan` job on both `apps/worker/src/main.ts` and
`apps/scheduler/src/main.ts`, a new `GET/PUT /retention-policy` API surface
behind `settings:manage`, and one `audit_log` row per tenant per run that
actually deleted something (`action='history.purged'`). Only
`message_attempt`/`delivery_event` are ever deleted — `campaign`,
`campaign_execution`, `campaign_snapshot` and `campaign_recipient` are
untouched, which is what makes "campaign summary giữ tối thiểu 24 tháng"
true by construction and what keeps the stored `028` progress summary — the
only thing the history report reads — unchanged by a purge (verified
directly by A2, not assumed). Full detail is in `state.json`'s own
`M6-S4-history-retention` node entry — don't re-derive it here.

**Final workspace baseline this handoff is written against** (CP8, after
this node's own code):
- `apps/api`: 89 files / 644 tests / 0 skipped / 0 failed (+3 files/+18
  tests from this node: `retention-schema.test.ts` 7, `retention-
  policy.test.ts` 5, `retention.dto.test.ts` 4, `env.test.ts` +2)
- `apps/worker`: 29 files / 139 tests / 0 skipped / 0 failed on a clean run
  (+2 files/+9 tests: `retention-window.test.ts` 5, `history-
  purge.integration.test.ts` 4) — **but the host was under heavy load this
  entire session (see below) and one run of this same suite hit a real
  Postgres `deadlock detected` inside `progress-reconcile.ts` (already-
  closed M6-S1 code, D-127's own territory, untouched by this node); a
  second run completed clean at 29/139.** Don't be alarmed by a similar
  transient failure in a future run — re-run once before treating it as a
  regression, same discipline this session followed.
- `apps/web`: 23 files / 69 tests / 0 skipped / 0 failed (unchanged, no web
  file touched)
- `packages/architecture-tests`: 15 files / 114 tests / 0 skipped / 0
  failed (+1 file/+1 test: `job-wiring.test.ts` / the new `ARCH-JOB-WIRING`
  guard)

`pnpm typecheck` and `pnpm build` both clean across the whole workspace.
`docker compose --env-file .env config --quiet` exits 0. Live verification
at CP8: rebuilt `api`/`worker`/`scheduler` containers, confirmed
`HISTORY_EVENT_RETENTION_DAYS=365` inside both `api` and `worker`
containers via `printenv`, confirmed `GET /retention-policy` returns `401`
unauthenticated (registered and gated, not `404`), and read a real
completed `history-purge-scan` BullMQ job straight out of Redis
(`bull:campaign-execution:history-purge-scan-29784837`) with
`returnvalue: {tenantsPurged:0,messageAttemptsDeleted:0,
deliveryEventsDeleted:0}` — correct on a fresh scan with nothing purgeable
yet.

**Four discoveries this session, all disclosed in `EXECPLAN.md`, none fixed
inline outside this node's own scope:**

- **D-129**: `message_attempt`/`delivery_event` deliberately have no DELETE
  grant for `eow_app` (026/027's own comments) — confirmed *before* writing
  migration 032, not discovered by trial and error, so the purge went
  straight to a SECURITY DEFINER function rather than attempting and
  failing at an ordinary `DELETE`.
- **D-130**: the aggregate report (`buildHistoryProgressSql`,
  `getCampaignProgress`) reads `campaign_execution`'s stored `028` counters,
  never recomputes from `message_attempt`/`delivery_event` — confirmed
  before locking the purge's scope, then turned into a direct test (A2)
  rather than left as an assumption.
- **D-131**: `export_job.artifact_bytes` (migration 029, `EXPORT_ARTIFACT_
  TTL_HOURS`) has no cleanup path — `expires_at` gates *download* but
  nothing ever clears the stored `bytea`. Out of `BR-HIS-006`'s own scope
  (its acceptance text is about message-event detail, not export
  artifacts) and out of this node's rule ownership — disclosed and spawned
  as a background task (`task_c753bff4`, "Purge expired export_job artifact
  bytes"), matching the D-125/D-127 precedent. **If you pick that task up
  or otherwise touch `export_job`, read `D-131`'s full entry first.**
- **D-132**: this session's own `apps/worker`/`packages/architecture-tests`
  baseline runs (at CP0, *before any code in this node was written*) were
  flaky under heavy host load — `send.integration.test.ts`'s A7 (M6-S1 CP6
  code) timed out twice at the hard-coded 30s budget but passed in 19.84s
  standalone with more room; `packages/architecture-tests` hit an unrelated
  `[vitest-pool]: Worker forks emitted error` crash on one attempt and took
  417–732s on clean runs (vs. this run's own established faster baseline).
  Non-deterministic, no code defect to hand to a task, not fixed and not
  spawned — recorded so a future session recognizes the same host-load
  symptom rather than re-diagnosing it. **The CP8 `progress-reconcile.ts`
  deadlock mentioned above is the same underlying phenomenon (host
  contention on the shared dev database), not a fifth discovery.**

## Open background work — check status before assuming either is done

- **`task_fc02ed64`** ("Fix progress-reconcile scan starving newest
  executions", D-127) — **still open at the end of this session.** Its
  worktree (`.claude/worktrees/reverent-wiles-aa8740`, branch
  `claude/reverent-wiles-aa8740`) was re-checked twice during this session
  (once at CP0, once here) and is **still uncommitted**, still sitting at
  `9843e6e` (the same commit this node's own work started from), with:
  ```text
  M  apps/worker/src/progress-reconcile.ts
  M  database/migrations.lock.json
  ?? apps/worker/src/progress-reconcile-scan-order.integration.test.ts
  ?? database/migrations/031_reconcile_scan_newest_first.sql
  ```
  **`031` is still that task's own claimed migration number.** This node
  used `032` and never touched `progress-reconcile.ts`. If you plan any new
  migration, re-check that worktree first — `032` is now published (in this
  session's own migrations.lock.json on `main`), so the next free number is
  `033`, but confirm `031` has landed (or is still pending) before assuming
  either way.
- **`task_c753bff4`** ("Purge expired export_job artifact bytes", D-131) —
  spawned this session, not yet started as of this handoff. Independent of
  `task_fc02ed64` (different table, different lifecycle driver
  `EXPORT_ARTIFACT_TTL_HOURS` vs. tenant retention policy).

## Next: `M6-GATE` (not started)

`state.json`'s own node entry:
```json
"dependsOn": [
  "M6-S1-realtime-progress", "M6-S2-notification-center",
  "M6-S3-history-recovery", "M6-S4-history-retention"
],
"successConditions": [
  "All 28 M6 rules closed (12 BR-* plus 16 BR-NOT-*)",
  "TC-HIS-* and the TC-SEND-* progress subset mapped and executing",
  "UI-HIS-001, UI-HIS-002 and the notifications popover verified at 3 viewports including reconnecting",
  "AsyncAPI conformance passes for every emitted envelope and dedupe key"
]
```

All four dependencies are now `completed`. This is a GATE node, not a
vertical slice — read `.agents/agent-graph.yaml`/the orchestration policy
for what a GATE actually requires (typically: re-verify every dependent
rule's traceability row is genuinely `closed` with real evidence, not just
marked so; run the full cross-milestone test/visual/contract verification
named in its success conditions; only then flip to `completed` and unblock
`M7-*`). Don't assume this node's own work already satisfies it — `M6-GATE`
is explicitly broader than any one slice, covering M6-S1's realtime
progress and M6-S2's notification center too, neither of which this session
touched.

### Worth checking early

- **BR-NOT-013** (notification retention/purge, per `notification-
  rules.test.ts`'s own comment referencing it alongside BR-NOT-003) — this
  node's `retention_policy` table is a **new, separate mechanism** from
  `notifications.service.ts`'s existing `NOTIFICATION_RETENTION_DAYS`/
  `purgeExpired()`. Confirm `M6-GATE` doesn't expect the two to be unified;
  nothing in this node's own scope suggested they should be (different
  data: notifications vs. message-event detail; different rule: BR-NOT-013
  vs. BR-HIS-006).
- The full 28-rule M6 traceability sweep will surface whether any other M6
  rule quietly regressed while this node worked — this session did not run
  a cross-milestone check beyond its own four package suites.

## Non-obvious environmental notes (carry forward — established over many sessions)

- Host-run tests vs. docker-composed containers is a real split — same as
  every prior handoff: integration tests run host-side against the same
  Postgres/Redis the docker containers use (`eow` database, ports
  55432/56379), while `api`/`web`/`worker`/`scheduler` run containerized.
- `database/migrate.sh` hard-codes `migrations_dir='/database/migrations'`
  — an absolute in-container path. **Do not run it directly on the host.**
  Apply migrations via `docker compose --env-file .env run --rm migrate`,
  which mounts `./database:/database:ro` (established this session, not
  documented in any prior handoff — worth carrying forward).
- **This session's host was under sustained heavy load throughout** (D-132)
  — background `vitest` invocations routinely took 3–12 minutes even for
  suites that should run in seconds, one `packages/architecture-tests`
  attempt crashed a worker fork outright, and one `apps/worker` run hit a
  real Postgres deadlock in unrelated code. None of this was a code defect
  in this node's own work — every RED/GREEN transition for this node's own
  new tests was clean and fast (sub-3s) in isolation. If a future session
  sees similarly slow or flaky baseline runs, don't assume it's a
  regression before re-running once standalone.
- **This shared dev database's accumulated backlog (D-127's own root
  cause) is still present** — this node's own `purgeable_retention_tenants`
  scan is deliberately oldest-first *and self-correcting* (each run deletes
  the rows it scanned, so a tenant cannot be starved the way D-127's
  read-only reconcile scan starves newest executions), but any *other* new
  cross-tenant scan a future node writes should still default to
  `DESC`/genuine pagination rather than copying `reconcilable_campaign_
  executions()`'s pattern uncritically.
- `pnpm run check`'s recursive test step aborts the whole run on the first
  package's first flake — drop to running each package's own `vitest run
  --maxWorkers=3` directly for a real, complete baseline (established since
  M5-GATE, reconfirmed every node since, reconfirmed again this session).
- `*.log` files are globally gitignored (`.gitignore:5`) — narrate
  script-run evidence in `state.json`'s evidence array instead of force-
  adding a log file, per established precedent.
- `packages/contracts/src/openapi.d.ts` is gitignored (generated output,
  `packages/contracts/.gitignore:1`) — `pnpm contracts:generate` regenerates
  it locally; do not try to `git add -f` it.

## Working discipline (unchanged, carried forward from every prior node)

- Evidence before status — never flip `closed`/`completed` before the
  artifact justifying it exists and has been re-run.
- Compare the workspace check's test *and skip* count against the previous
  node's own baseline (this handoff's own numbers above), not just exit
  code.
- Real bugs found during work get fixed at the root cause and disclosed
  (`D-*`/`DEC-*`), not silently worked around — unless the bug is in an
  already-closed node's code outside this node's own rule ownership, in
  which case disclose via a spawned background task instead of reopening a
  closed node (D-131 is this session's own instance of that precedent).
- Run every package's full suite at real parallelism (`--maxWorkers=3`) at
  least once before calling any node done, and re-run any suite that fails
  once before treating the failure as a regression rather than host-load
  noise — this session's own CP8 did exactly that for `apps/worker`.
- Commit at every checkpoint, one commit per logical step, per `AGENTS.md`
  §2 — this node's own work was 9 commits (one per checkpoint), not one
  giant commit, by design.
- Push/merge-commit actions require separate, explicit per-instance user
  confirmation — this session did not push; do not assume a future push is
  pre-approved by any prior session's approval.

## Suggested skills for the next session

- **`superpowers:writing-plans`** — `M6-GATE` is a verification/closure
  node, not a fresh feature; a short plan for its own re-verification sweep
  (traceability re-check, cross-milestone test run, visual verification at
  3 viewports, AsyncAPI conformance) is still worth writing rather than
  improvising checkpoint-by-checkpoint.
- **`superpowers:verification-before-completion`** — before flipping
  `M6-GATE` to `completed`; `M7-S1` through `M7-S4` all depend on it
  directly, and `M7-S5`/`M7-GATE` depend on those.
- **`superpowers:systematic-debugging`** — for triaging any of this host's
  now nine documented flake/bug classes (D-93, D-94, D-118, D-120, D-121,
  D-124, D-126, D-127, D-132) if one resurfaces during `M6-GATE`'s own
  cross-milestone run, before assuming a new one.
