# Handoff — M6-S3 closed; M6-S4-history-retention (or M6-GATE) is next

Written 2026-08-19, end of a session that executed the already-approved
`M6-S3-HISTORY-RECOVERY-PLAN.md` end-to-end (13 checkpoints, TDD throughout,
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
`M6-S3-history-recovery` (13 checkpoint commits, `M6-S3 CP0` through `M6-S3
CP12`, plus one extra mid-node commit recording D-124). Docker stack was
running throughout this session (`api`/`web`/`worker`/`scheduler`/`postgres`/
`redis`/`mailpit` all `Up ... (healthy)`); two host-run ad-hoc dev servers
(`:3000` api, `:5173` web, PIDs noted in this session's own transcript) were
also running for Playwright/browser evidence capture. **Confirm nothing
stale is bound to those ports before starting fresh ones** — this session did
not explicitly verify they were stopped at the very end; check `netstat -ano
| grep -E ':3000 |:5173 '` first.

## Mandatory read order (per `AGENTS.md` §1 — do not skip)

1. `AGENTS.md` — the protocol itself.
2. `.agents/runs/2026-08-10-eow-master-execplan/state.json` — the
   `M6-S3-history-recovery` node's own entry (now `completed`, full evidence
   array) and `M6-S4-history-retention`'s entry (`dependsOn:
   [M6-S3-history-recovery]`, now satisfied, `status: "pending"`) — **this is
   almost certainly the actual next node**, not `M6-GATE` directly, since
   `M6-GATE.dependsOn` includes `M6-S4-history-retention` and it has not
   started.
3. `.agents/runs/2026-08-10-eow-master-execplan/traceability.csv` — the
   authority on rule status. `BR-HIS-001, BR-HIS-003, BR-HIS-004, BR-HIS-005,
   BR-HIS-007, BR-SEND-009` are all `closed` with real `code_paths`/
   `test_files`/`migration_files`/`log_or_metric_or_audit` — read the rows
   directly, don't plan from a one-line summary. `BR-HIS-006` is `not_started`
   with `slice=M6-S4-history-retention` (reassigned in this node's own CP1,
   `DEC-137`) — that is the one rule `M6-S4` exists to close.
4. `.agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md` — discovery log
   `D-122` through `D-128` and decision log `DEC-132` through `DEC-139` are
   all this node's own. `D-126` and `D-128` (found at the very last
   checkpoint, CP12) are worth reading in full before writing any new UI code
   or running a full-suite baseline in this codebase — see below.
5. `docs/adr/adr-027-resend-lineage-and-pause-resume.md` — the Accepted ADR
   covering both of this node's non-obvious design decisions (resend always
   creates a **new** snapshot generation, never reuses the parent; pause is
   enforced inside the worker's own send loop via a 2-second bounded
   re-check, not just the scheduler's 60-second tick).
6. `.agents/runs/2026-08-10-eow-master-execplan/M6-S3-HISTORY-RECOVERY-PLAN.md` —
   the plan this session executed, for the exact shape of the history-list
   query builder, resend/export services, and the migration 029/030 schema —
   useful reference if `M6-S4`'s purge job needs to touch any of the same
   tables (`campaign_execution`, `campaign_snapshot`, `export_job`).

## What this session completed (all committed, nothing pending)

Closed `M6-S3-history-recovery`: a real `/history` list screen (`UI-HIS-001`,
server-side filter/sort/pagination with a `serverTime`-driven countdown,
`GET /campaigns/history`), pause/resume enforced inside the worker's send
loop (`BR-SEND-009`, a real 10-second bound, not just a scheduler tick),
resend as a parent-linked child snapshot+execution over only failed
recipients (`BR-HIS-005`, ADR-027), and background/inline CSV export with
RBAC (`history:export`, new permission), expiry (`EXPORT_ARTIFACT_TTL_HOURS`)
and a per-download audit row (`BR-HIS-003`/`BR-HIS-007`). Full detail is in
`state.json`'s own `M6-S3-history-recovery` node entry — don't re-derive it
here.

**Final workspace baseline this handoff is written against**:
- `apps/api`: 86 files / 626 tests / 0 skipped / 0 failed
- `apps/worker`: 27 files / 130 tests, **26 files / 128 tests passing, 1 file
  (`progress-reconcile.integration.test.ts`) / 2 tests (A15/A17) failing —
  disclosed, root-caused, pre-existing, NOT a regression this node
  introduced** (see D-127 below; do not spend time re-diagnosing this from
  scratch, the cause is already found)
- `apps/web`: 23 files / 69 tests / 0 skipped / 0 failed
- `packages/architecture-tests`: 14 files / 113 tests / 0 skipped / 0 failed
  (after this node's own CP12 fix, D-128 — see below)

**Three real defects were found and fixed at CP12** (the visual-evidence and
full-suite-verification checkpoint), all disclosed in `EXECPLAN.md`:

- **D-126**: `HistoryFilterDialog.tsx` and `ResendConfirmDialog.tsx` (this
  node's own CP10/CP11 code) rendered their overlay markup with
  `className="modal-overlay"`/`"modal-panel"` — CSS classes that exist
  **nowhere** in `globals.css`. Every other overlay in this app uses
  `.overlay-backdrop`/`.action-overlay` (see `StopSendConfirmOverlay.tsx` for
  the canonical shape). Because the history screen's own root
  (`.workspace-module-frame`) has `overflow:hidden`, the two unstyled dialogs
  were **entirely invisible to a real user** — yet every Playwright assertion
  passed, because `getByRole('dialog', {...})` matches on DOM role/accessible
  name regardless of visual clipping. This is the exact failure mode
  `D-78`/`D-104` warned about, now reconfirmed a third time — **a green
  Playwright run alone is never sufficient evidence in this codebase; you
  must open every captured screenshot and look at it.** Fixed by rewriting
  both components onto the established `.overlay-backdrop`/`.action-overlay`
  pattern; re-verified via re-captured, re-inspected screenshots.
- **D-127**: `apps/worker/src/progress-reconcile.integration.test.ts`'s
  A15/A17 (M6-S1 CP9 code, untouched by this node) now fail
  **deterministically**, not as a timing flake. Root cause:
  `reconcilable_campaign_executions()` (migration 028) scans `ORDER BY
  started_at LIMIT 100` (ascending — oldest first). The shared dev database's
  candidate count is now **at or over 100** from many sessions' accumulated
  real fixtures, so any *newly created* execution (the *newest* `started_at`)
  is the one the `LIMIT` excludes — backwards from what a reconciliation scan
  should prioritize. Out of this node's rule ownership (`BR-HIS-008`, not one
  of the six rules this slice closes) and belongs to an already-closed node
  (M6-S1) — **not fixed inline**, disclosed via a spawned background task
  (`task_fc02ed64`, title "Fix progress-reconcile scan starving newest
  executions"). **If you pick up that task or otherwise touch
  `progress-reconcile.ts`, read `D-127`'s full entry in `EXECPLAN.md` first**
  — the fix likely needs `ORDER BY started_at DESC` and/or real pagination,
  not just a bigger `LIMIT` (which only delays recurrence). If you don't pick
  it up, **expect this same 1-file/2-test failure in every future full-suite
  run of `apps/worker` until someone does** — it will not self-resolve, and
  it is not this node's fault when you see it.
- **D-128**: `packages/architecture-tests`'s `ARCH-NO-ORPHANS` failed because
  this node's own CP10 (`AppRoutes.tsx` pointing `/history` at the new real
  `HistoryScreen`) left `apps/web/src/screens/placeholder/ComingSoon.tsx`
  with zero remaining real importers — a genuine regression this node
  introduced, caught only because CP12 ran the full
  `packages/architecture-tests` suite (no earlier checkpoint had). Fixed by
  deleting the file (and its now-empty `placeholder/` directory) outright,
  not leaving it as dead code.

**Takeaway for the next session**: don't treat this node's own CP0-CP11 work
as fully proven by its own checkpoint-level test runs alone — all three
defects above were only caught by CP12's specific disciplines (individually
inspecting every screenshot; running every one of the four packages' full
suites at real parallelism, not just the one package a checkpoint happened to
touch). Follow the same two disciplines at your own node's final checkpoint.

## Next: `M6-S4-history-retention` (not started)

`state.json`'s own node entry:
```json
"dependsOn": ["M6-S3-history-recovery"],
"successConditions": [
  "Purge job has audit and does not break aggregate reporting",
  "Retention policy is tenant-configurable",
  "BR-HIS-006 closed"
]
```

Read `BR-HIS-006`'s full acceptance text directly from `catalog/ba-rules.json`
before planning: `Job purge có audit và không phá aggregate report; chính
sách cấu hình được.` (P2 — lowest priority of any rule in M6, which is why
this session's own CP1 split it out of `M6-S3` into its own node, `DEC-137`,
user-approved during brainstorming).

### What already exists (read before designing anything)

- **`apps/api/src/notifications/notifications.service.ts`'s
  `purgeExpired()`** plus `NOTIFICATION_RETENTION_DAYS` in `env.ts` — the
  closest existing precedent for "a scheduled job deletes rows older than a
  configurable retention window." `M6-S3`'s own pre-execution handoff
  (superseded by this one, but its design-questions section is still in git
  history if you want it) flagged this as the shape to imitate.
- **`apps/worker/src/progress-reconcile.ts`** — the closest existing
  precedent for "a cross-tenant scheduled scan job that runs periodically
  against every tenant's data," if the purge needs to run system-wide rather
  than per-tenant-triggered. **Read `D-127` first** (this handoff, above) —
  don't copy its `reconcilable_campaign_executions()` scan-limit/ordering
  pattern uncritically; it has a live, disclosed bug right now.
- **`export_job.expires_at`/`EXPORT_ARTIFACT_TTL_HOURS`** (this node, CP7/CP9)
  — an existing "row has an expiry, something eventually needs to clean it
  up" shape already in the schema, though nothing currently purges expired
  `export_job` rows/artifact bytes. Worth checking whether `BR-HIS-006`'s
  scope is meant to cover `export_job` cleanup too, or is scoped only to
  `campaign`/`campaign_execution`/`message_attempt` history rows — the
  acceptance text ("không phá aggregate report") suggests the latter
  (aggregate reporting reads from `campaign_execution`'s stored counters, not
  raw `message_attempt` rows, so a purge of old raw rows should be safe as
  long as the stored counters aren't touched) but confirm before assuming.
- **`audit_log` immutability (`BR-SEC-002` trigger)** — any purge job must
  still write its own audit entry (per the rule's own acceptance text, "Job
  purge có audit") describing what was deleted, since the deleted rows
  themselves can no longer be inspected afterward. Follow
  `progress-reconcile.ts`'s own `progress.reconciled` audit-row pattern (one
  audit row per repair/action, not a single row per whole-scan run) unless a
  simpler per-run summary row is a better fit for BR-HIS-006's own wording —
  worth a brainstorming question, not an assumed answer.

### Design questions this node's plan will likely need to answer

1. **Retention window granularity.** "Chính sách cấu hình được" (policy is
   configurable) — per-tenant (a new `tenant_config`-style column/table) or a
   single global env var (`NOTIFICATION_RETENTION_DAYS`'s own precedent)?
   Check whether any existing tenant-level settings table already exists to
   extend, or whether this is the first tenant-configurable retention policy
   in the codebase.
2. **What exactly gets purged.** `campaign_execution`/`campaign_snapshot`/
   `message_attempt`/`campaign_recipient` rows past the window? All of them,
   or a subset? Given the immutable `campaign_snapshot` trigger (M4-S4) and
   this node's own new `parent_snapshot_id`/`parent_execution_id` lineage
   columns (migration 029), purging a *parent* snapshot/execution that a
   still-live *resend child* references would break the lineage FK — the
   purge job needs to either exclude rows with live children or cascade
   correctly. Read migration 029's exact FK constraints before designing.
3. **Interaction with `export_job`.** If a campaign's underlying
   `campaign_execution` is purged, does any live `export_job` referencing it
   (via `execution_id`) need to be purged too, or does the export's own
   independent `expires_at` already handle that lifecycle separately? Check
   `export_job`'s FK `ON DELETE` behavior (migration 029) before assuming
   either answer.

## Non-obvious environmental notes (carry forward — established over many sessions)

- Host-run tests vs. docker-composed containers is a real split — same as
  every prior handoff: integration tests run host-side against the same
  Postgres/Redis the docker containers use (`eow` database, ports
  55432/56379), while `api`/`web`/`worker`/`scheduler` run containerized.
- **The live docker worker/scheduler containers actively poll the same
  shared database host-run tests use** (D-118) — any fixture your plan
  creates with `campaign.status IN ('queued', 'validating', 'sending')` is
  exposed to being raced mid-test. `send.ts`'s pause check now specifically
  tests `status === 'paused'` (not `!== 'sending'`, D-124's fix) — if you
  need a fixture-hiding value, `'completed'` is the established safe choice
  (D-124), not `'paused'` (which now carries real meaning).
- **This shared dev database's accumulated backlog is no longer just an
  observation — it is now an active, deterministic bug source (D-127).** Any
  new cross-tenant scan job this node writes (if `M6-S4`'s purge is scoped
  that way) should default to `ORDER BY ... DESC` (newest/most-urgent first)
  or genuine pagination, not blindly copy `reconcilable_campaign_executions()`'s
  ascending-oldest-first pattern.
- `pnpm run check`'s recursive test step aborts the whole run on the first
  package's first flake — drop to running each package's own `vitest run
  --maxWorkers=3` directly for a real, complete baseline (established since
  M5-GATE, reconfirmed every node since).
- **A green Playwright visual-capture run is never sufficient evidence on
  its own in this codebase (D-78, D-104, and now D-126 — three confirmed
  instances).** `getByRole('dialog', ...)` and similar DOM-role assertions
  pass even when an element is completely invisible due to a CSS/layout bug.
  Individually open and inspect every captured screenshot before writing any
  evidence claim.
- `*.log` files are globally gitignored (`.gitignore:5`) — narrate script-run
  evidence in `state.json`'s evidence array instead of force-adding a log
  file, per established precedent.

## Working discipline (unchanged, carried forward from every prior node)

- Evidence before status — never flip `closed`/`completed` before the
  artifact justifying it exists and has been re-run.
- Compare the workspace check's test *and skip* count against the previous
  node's own baseline (this handoff's own numbers above), not just exit code.
- Real bugs found during work get fixed at the root cause and disclosed
  (`D-*`/`DEC-*`), not silently worked around — unless the bug is in an
  already-closed node's code outside this node's own rule ownership, in
  which case disclose via a spawned background task instead of reopening a
  closed node (this session's own `D-127` is the precedent).
- Individually inspect every captured visual-evidence image — a green
  Playwright run is not evidence on its own (D-78, D-104, D-126).
- Run every package's full suite at real parallelism (`--maxWorkers=3`) at
  least once before calling any node done — this session's own D-128 was
  only caught this way.
- Commit at every checkpoint, one commit per logical step, per `AGENTS.md`
  §2 — this node's own work was 13 commits (one per checkpoint plus one
  mid-node discovery-log commit), not one giant commit, by design.
- Push/merge-commit actions require separate, explicit per-instance user
  confirmation — this session did not push; do not assume a future push is
  pre-approved by any prior session's approval.

## Suggested skills for the next session

- **`superpowers:brainstorming`** — `M6-S4`'s three open design questions
  above (retention granularity, purge scope, export_job interaction)
  shouldn't be papered over with an assumed answer.
- **`superpowers:writing-plans`** — once resolved, write
  `M6-S4-HISTORY-RETENTION-PLAN.md` the same way every prior `M*-S*-PLAN.md`
  was written: TDD task-by-task, RED before GREEN, one commit per checkpoint.
- **`superpowers:test-driven-development`** — a new scheduled scan job
  (if that's the chosen shape) needs its cross-tenant race behavior designed
  in from the start, not discovered mid-checkpoint (this node's own D-127 is
  a live cautionary example, not hypothetical).
- **`superpowers:systematic-debugging`** — for triaging any of this host's
  now eight documented flake/bug classes (D-93, D-94, D-118, D-120, D-121,
  D-124, D-126, D-127) if one resurfaces, before assuming a new one.
- **`superpowers:verification-before-completion`** — before flipping
  `M6-S4` to `completed`; `M6-GATE` depends on it and is the last thing
  standing before M7.
