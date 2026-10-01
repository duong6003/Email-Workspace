# M6-GATE Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking. Same house shape as
> `M5-GATE-BR-CFG-002-PLAN.md` and `M6-S4-HISTORY-RETENTION-PLAN.md`: RED before
> GREEN in every task that writes code, one commit per checkpoint, evidence
> before status.

**Goal:** Close `M6-GATE` by proving — not asserting — its four success conditions,
fixing every real gap the proof surfaces, and leaving a mechanical check behind for
each drift class found so the next gate cannot inherit the same blind spot.

**Architecture:** This is a verification node, not a vertical slice. The bulk of the
work is (a) strengthening two existing mechanical checks (`validate_plan.py`'s
traceability evidence rule, `packages/architecture-tests`' contract coverage) so the
gate's conditions are enforced by something that runs, not by a human reading a CSV;
(b) closing the three real gaps that strengthening exposes (an AsyncAPI envelope
missing a required field, a missing `reconnecting` state on the notifications
popover, and `screen-catalog.yaml` never updated by M6-S1/M6-S3); (c) recording an
evidenced disposition for the one M6 rule that genuinely cannot close on this host.

**Tech Stack:** Vitest (`packages/architecture-tests`, `apps/api`, `apps/worker`,
`apps/web`), Playwright (`apps/web/e2e/visual-capture.spec.ts`), Python 3
(`validate_plan.py`), React 19 + Vite (`apps/web`), AsyncAPI 3.0 + a JSON event
catalog (`contracts/asyncapi.yaml`, `catalog/realtime-events.json`).

---

## 0. Read this before touching anything

Everything in this section was verified against the working tree on 2026-08-19
during planning. Do not re-derive it; do not assume the opposite.

### (a) Another agent is writing into THIS working tree right now

`task_c753bff4` ("Purge expired export_job artifact bytes", D-131) was started by
the user and is **not** working in its own worktree — its files are appearing in
the primary checkout. Snapshot taken during planning:

```text
 M apps/scheduler/src/main.ts
 M apps/worker/src/main.ts
?? apps/worker/src/export-purge.integration.test.ts
?? apps/worker/src/export-purge.ts
?? database/migrations/033_export_artifact_purge.sql
```

(`export-purge.ts` written 08:50, `033_*.sql` 08:51, the test 08:54 — actively
progressing, roughly one file every few minutes.)

Four consequences, all binding:

1. **Never `git add -A`, `git add .`, or `git commit -a`.** Every commit in this
   plan stages an explicit file list. Staging that agent's in-flight files would
   commit half-written code under this node's name and violate AGENTS.md §2
   ("Do not amend or discard another agent's commits" — and do not create them
   either).
2. **Do not touch** `apps/worker/src/main.ts`, `apps/scheduler/src/main.ts`,
   `apps/worker/src/export-purge*.ts`,
   `database/migrations/033_export_artifact_purge.sql`, or
   `database/migrations.lock.json`. All are that agent's live surface.
3. `packages/architecture-tests`' `ARCH-JOB-WIRING` reads both `main.ts` files and
   will be **transiently red** while that agent has edited one side and not the
   other. A red `job-wiring.test.ts` during this node is that agent's in-flight
   state, not a regression — confirm by diffing the two files' job names before
   treating it as anything else.
4. **CP8's definitive full-suite baseline cannot be taken while that agent is
   mid-edit.** CP8 has an explicit gate on this; see its own steps.

`task_fc02ed64` ("Fix progress-reconcile scan starving newest executions", D-127)
is still open and still uncommitted, in its own worktree
`.claude/worktrees/reverent-wiles-aa8740` at `9843e6e`, still holding migration
number `031`. Do not touch `apps/worker/src/progress-reconcile.ts` or
`apps/worker/src/progress-reconcile.integration.test.ts`. **This node writes no
migration at all**, so the 031/033 collision is not this node's problem — but
`progress-reconcile.integration.test.ts`'s A15/A17 are still expected to fail
deterministically per D-127, and that is a disclosed pre-existing exception, not
a regression.

A third worktree, `.claude/worktrees/kind-wozniak-055662` (branch
`claude/kind-wozniak-055662`, at `b3cfbd6`), holds the still-uncommitted D-125
follow-up. It matters to this gate — see §2 condition 1(c).

### (b) Baseline this plan is written against

HEAD is `e7d284a` ("M6-S4-history-retention: completed"), branch `main`, **not
pushed**. `origin/main` was last known at `7d2eec0`; nothing in this plan pushes.

Per-package baseline carried from the M6-S4 handoff (CP8):

| Package | Files | Tests | Skipped | Failed |
|---|---|---|---|---|
| `apps/api` | 89 | 644 | 0 | 0 |
| `apps/worker` | 29 | 139 | 0 | 0 (clean run) |
| `apps/web` | 23 | 69 | 0 | 0 |
| `packages/architecture-tests` | 15 | 114 | 0 | 0 |

`validate_plan.py` re-run during planning: **ERRORS 0, WARNINGS 0**, 46 graph
nodes, 134/134 rules allocated, 159/159 test cases, 14 screen entries.

Docker stack confirmed healthy during planning (`api`, `web`, `worker`,
`scheduler`, `postgres`, `redis`, `mailpit` all `Up`/`healthy`).

### (c) Environment facts that will otherwise cost an hour

- `pnpm run check`'s recursive test step aborts on the first package's first
  flake. Run each package directly instead:
  `pnpm --filter @eow/api exec vitest run --maxWorkers=3`.
- Integration tests run **host-side** against the same Postgres/Redis the
  containers use (ports 55432/56379). Do not run `database/migrate.sh` on the
  host — it hard-codes `/database/migrations`. Use
  `docker compose --env-file .env run --rm migrate`. **This node adds no
  migration, so it should never need to.**
- `apps/web` has **no `@testing-library/react`**. Every web test in this repo is a
  pure-function unit test (`realtime-status.test.ts`, `eta-format.test.ts`, …).
  Component behaviour is verified by Playwright, not by rendering in vitest. CP5
  is designed around this, not against it.
- Write every file as UTF-8 explicitly (AGENTS.md §2, `ARCH-ENCODING`). The
  traceability rows and `screen-catalog.yaml` prose contain Vietnamese diacritics.
- `*.log` is globally gitignored; narrate script output in `state.json` evidence
  rather than force-adding a log file.

---

## 1. Scope

**In scope:** the four `M6-GATE` success conditions, verbatim from `state.json`:

1. All 28 M6 rules closed (12 `BR-*` plus 16 `BR-NOT-*`)
2. `TC-HIS-*` and the `TC-SEND-*` progress subset mapped and executing
3. `UI-HIS-001`, `UI-HIS-002` and the notifications popover verified at 3
   viewports including `reconnecting`
4. AsyncAPI conformance passes for every emitted envelope and dedupe key

**Non-goals** (explicitly not this node's work):

- Fixing D-127 (`progress-reconcile` scan order) — `task_fc02ed64` owns it.
- Fixing D-131 (`export_job` artifact purge) — `task_c753bff4` owns it, and is
  mid-flight in this tree.
- Any `M7-*` rule. `BR-SEC-*`, `BR-CFG-006` and `BR-SEND-013` are `not_started`
  by design and stay that way.
- Running `TC-SEC-016`'s 10,000-connection load test. See §2 condition 1(b).
- Pushing to `origin`. Requires separate explicit confirmation in the executing
  session.

---

## 2. What planning already found (do not re-derive)

### Condition 1 — rule closure

`traceability.csv` has exactly **28 rows with `milestone == M6`**: `BR-SEND-003`,
`BR-SEND-004`, `BR-SEND-005`, `BR-SEND-009`, `BR-HIS-001`…`BR-HIS-008` (12 `BR-*`)
plus `BR-NOT-001`…`BR-NOT-016` (16). The condition's own count is correct — unlike
M4-GATE's and M5-GATE's, it needs no correction.

**(a) 15 of 16 `BR-NOT-*` rows have an empty `log_or_metric_or_audit` cell.**
Only `BR-NOT-016` carries one (`notification_metric log`). Every M6 `BR-HIS-*`/
`BR-SEND-*` row carries a real one. `validate_plan.py`'s existing rule only errors
when `code_paths` **and** `test_files` are *both* blank, so this was invisible —
the same "an artifact only humans read is an artifact that drifts" lesson as D-38.
CP1 strengthens the rule and fills the cells.

**(b) `BR-SEND-004` is `partially_closed`, not `closed`.** Its own cell already
records why: `TC-SEC-016` ("Tăng tải dần… Đo connection error, lag, CPU/memory…
Restart một replica", type `Performance`) needs staging infrastructure this host
does not have; M6-S1 declined to claim it. Checked during planning:
`catalog/test-cases.json` gives `TC-SEC-016` two owners — `BR-SEND-004` **and
`BR-SEC-005`**, which is `not_started` and belongs to `M7-S2-security-hardening`,
whose own success condition already reads "TC-SEC-* (17 cases) executing". So the
remainder has a real, already-planned owner downstream. This is exactly the
`DEC-088`/`DEC-089` → `DEC-120` compound-status precedent M5-GATE set for
`BR-SCH-004`/`BR-SCH-007`. CP2 records it as a decision and corrects the
condition's own text rather than force-closing the row.

**(c) A known defect in `notifications.service.ts` is fixed but uncommitted.**
D-125 (M6-S3) found that TypeORM's `manager.query()` returns `[rows, count]` for
`DELETE … RETURNING`, and disclosed two remaining instances as a background task.
That task's worktree (`kind-wozniak-055662`) holds the fix, still uncommitted:

```diff
-      const result = await manager.query(
+      const [rows] = (await manager.query(
         `DELETE FROM notification WHERE tenant_id = $1 AND expires_at <= $2 RETURNING id`,
         [tenantId, now],
-      ) as Array<{ id: string }>;
-      return result.length;
+      )) as [Array<{ id: string }>, number];
+      return rows.length;
```

`purgeExpired()` is **`BR-NOT-013`'s own mechanism**, and `BR-NOT-013` is marked
`closed`. Today the method returns `2` for every call regardless of how many rows
it purged. Both call sites (`notifications.service.ts:29` and `:43`) discard the
return value, so no user-visible behaviour is currently wrong — but the number is
wrong, and a rule marked `closed` on code with a known wrong return is precisely
what this gate exists to catch. CP2 handles it; see its steps for the
land-vs-disclose decision (it does **not** get silently re-implemented here).

### Condition 2 — test-case mapping

Verified mechanically during planning: **all 10 `TC-HIS-*` are mapped** to a rule
row with a non-empty `test_files` cell, and every `TC-SEND-*` in the progress
subset (`TC-SEND-003`, `004`, `005`, `015`, `016`, `019`) is mapped. All 33
distinct test files referenced by the 28 M6 rules **exist on disk** (checked
individually). The mapping half of this condition is already satisfied; the
"executing" half is CP4's job and needs a real run, not a file-exists check.

### Condition 3 — visual verification

`evidence/visual/` currently holds:

| Surface | Node | 3 viewports? | `reconnecting`? |
|---|---|---|---|
| `UI-HIS-002` drawer | M6-S1 | yes | **desktop only** |
| notifications popover | M6-S2 | yes (7 states × 3) | **absent** |
| `UI-HIS-001` history list | M6-S3 | yes (list state) | **absent** |

Three real gaps:

1. **`screen-catalog.yaml` still says `status: not_inventoried` for both
   `UI-HIS-001` and `UI-HIS-002`** — no `states_covered`, no `ported_to`, no
   `production_render_path`, despite M6-S1 and M6-S3 having shipped and captured
   both. `UI-SHELL-001.states_covered.reconnecting` still reads
   `deferred_to_M6-S1` after M6-S1 completed. This is the identical drift class
   M1-GATE caught for `UI-SHELL-001.error` ("still said `deferred_to_M1-S3` after
   that node had already shipped the screen"). CP7 closes it.
2. **The `reconnecting` state is captured at desktop only**, and only for the
   drawer. `HistoryScreen.tsx:108` and `CampaignProgressDrawer.tsx:126` both
   render `Đang kết nối lại…`, so both surfaces *have* the state — it was simply
   never captured at tablet/mobile. CP6 captures it.
3. **`NotificationPopover.tsx` has no `reconnecting` state at all.** It does not
   import `useRealtimeStatus`, and its `refresh()` runs only on filter change —
   so a socket reconnect neither shows a status nor refetches. `UI-SHELL-001`
   declares `reconnecting` as a required state and `BR-NOT-012` says the unread
   API is authoritative after reconnect; the API half is closed and tested, the
   client half does not exist. CP5 builds it.

### Condition 4 — AsyncAPI conformance

**Nothing mechanical checks this today.** Grepping the whole workspace: no
TypeScript file references `contracts/asyncapi.yaml` or
`catalog/realtime-events.json`, and `packages/architecture-tests` has no
contract-conformance rule. The condition has never been enforced by anything that
runs.

The real surface, enumerated during planning:

*Realtime envelopes actually published to sockets*

- `apps/api/src/campaigns/progress-event.ts` → `campaign.progress`, `rt.resync_required`
- `apps/worker/src/campaign-send/progress-event.ts` → same two (parity-guarded by `ARCH-PROGRESS-PARITY`)
- `apps/worker/src/job-events.ts` → `import.progress`, `import.completed`, `bulk_update.progress`, `bulk_update.completed`, `export.completed`
- `apps/worker/src/progress-reconcile.ts:185` → `rt.resync_required`
- `apps/api/src/realtime/realtime.gateway.ts:139` → `rt.connection.ready`

*Outbox rows (durable domain events, not socket envelopes)*

- `schedule.state_changed` (`campaign-dispatcher.ts:140`), `campaign.execution_state_changed` (`aggregate.ts:82`), `campaign.snapshot_frozen` (`campaign-snapshot.ts:209`), `template.published` (`templates.service.ts:198`), `import.job.created` (`import-jobs.service.ts:188`), `bulk-update.job.created` (`bulk-jobs.service.ts:228`)

**A real conformance violation is already visible.** `realtime.gateway.ts:139`:

```ts
client.emit('rt.connection.ready', { event_id:crypto.randomUUID(), event_type:'rt.connection.ready', occurred_at:new Date().toISOString(), version:1, data:{ resume:true } });
```

`EventEnvelope` declares `required: [event_id, event_type, occurred_at, tenant_id,
version, data]`. This envelope has **no `tenant_id`** (and no `aggregate_id`). It
is emitted to every client on every connect. CP3 catches it with a test and CP3
fixes it.

Two further classification questions CP3 must answer with a written allowlist
reason rather than a guess:

- `import.job.created` / `bulk-update.job.created` are internal work-item relays
  (`outbox-relay.ts` turns them into BullMQ jobs); they are **not** realtime
  envelopes and correctly have no AsyncAPI channel.
- `campaign.snapshot_frozen` is an outbox row with no AsyncAPI channel and no
  consumer, deliberately (M4-S4's "visible before its consumer exists" boundary,
  the same one `campaign.execution_state_changed`'s own contract comment
  describes). `campaign.execution_state_changed` *does* have a channel;
  `campaign.snapshot_frozen` does not. That asymmetry is either a real gap or a
  deliberate one — CP3 decides it explicitly and records the reason.

Nine AsyncAPI channels are declared but emitted by nothing yet
(`notification.created`/`updated`/`read`, `campaign.state_changed`,
`campaign.issue_detected`, `audience.validation_progress`/`_completed`,
`sender.state_changed`, `quota.threshold_reached`, `recipient.segment_changed`).
The condition's own wording is "every **emitted** envelope", so
declared-but-unemitted channels are in bounds for a warning, not an error — CP3
asserts direction (`emitted ⊆ declared`), not equality.

---

## 3. File structure

| File | Action | Responsibility |
|---|---|---|
| `.agents/runs/…/validate_plan.py` | Modify (`~line 210-222`) | Strengthen the traceability evidence rule: a `closed` row needs `code_paths` **and** `test_files` **and** `test_case_ids` **and** `log_or_metric_or_audit`, and every referenced test file must exist |
| `.agents/runs/…/traceability.csv` | Modify (15 rows) | Fill `BR-NOT-001`…`BR-NOT-015`'s `log_or_metric_or_audit` with real evidence |
| `packages/architecture-tests/src/asyncapi-conformance.test.ts` | **Create** | `ARCH-ASYNCAPI-CONFORMANCE`: emitted event types ⊆ declared channels; catalog ↔ contract agreement; every builder emits all 6 required envelope fields; `+version` dedupe keys are not fed a literal |
| `apps/api/src/realtime/realtime.gateway.ts` | Modify (`:139`) | Add the missing `tenant_id` to the `rt.connection.ready` envelope |
| `apps/api/test/integration/realtime-campaign.test.ts` | Modify | RED-first test: a real connected socket receives an `rt.connection.ready` carrying the caller's own `tenant_id` |
| `apps/web/src/api/realtime-status.ts` | Modify | Add the pure `shouldRefetchOnReconnect()` helper (the testable half of CP5) |
| `apps/web/src/api/realtime-status.test.ts` | Modify | Unit tests for `shouldRefetchOnReconnect()` |
| `apps/web/src/overlays/NotificationPopover.tsx` | Modify | Render `Đang kết nối lại…` and refetch when the socket returns |
| `apps/web/e2e/visual-capture.spec.ts` | Modify (append one describe block) | `reconnecting` captures at all 3 viewports for the history list, the drawer and the popover |
| `.agents/runs/…/screen-catalog.yaml` | Modify (3 entries) | `UI-HIS-001`/`UI-HIS-002` → migrated with real `states_covered`; `UI-SHELL-001.reconnecting` de-staled |
| `.agents/runs/…/EXECPLAN.md` | Modify | `D-133`…`D-136`, `DEC-143`…`DEC-146` |
| `.agents/runs/…/state.json` | Modify | `M6-GATE` evidence array + `completed` |
| `.agents/runs/…/M6-GATE-HANDOFF.md` | **Create** | Handoff for the `M7-S1-quota` session |

Discovery/decision IDs `D-133`…`D-136` and `DEC-143`…`DEC-146` are reserved for
this node. Verify they are still free at CP0 — `task_fc02ed64` and
`task_c753bff4` may have claimed some when they land.

---

## 4. Checkpoints

### CP0: Intake, concurrency guard, baseline

**Files:** none (read-only) — then `state.json`

- [ ] **Step 1: Re-check both background tasks before assuming anything**

```bash
git -C .claude/worktrees/reverent-wiles-aa8740 status --porcelain && git -C .claude/worktrees/reverent-wiles-aa8740 log --oneline -1
```

Expected (unchanged from planning): four dirty entries, HEAD `9843e6e`. If it has
landed, `031` is published and D-127's A15/A17 exception may no longer apply —
re-check `apps/worker`'s suite before treating those two failures as expected.

- [ ] **Step 2: Snapshot the concurrent agent's live surface**

```bash
git status --porcelain
```

Record the exact list in `state.json`'s CP0 evidence. Every later `git add` in
this plan is checked against it. If this list has **grown to include any file
this plan touches** (§3's table), stop and re-plan that checkpoint — do not
resolve a collision by overwriting.

- [ ] **Step 3: Confirm the run artifacts still validate clean**

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Expected: `ERRORS: 0   WARNINGS: 0`, 46 graph nodes, 134/134 rules, 14 screen entries.

- [ ] **Step 4: Confirm the docker stack is healthy (integration tests need it)**

```bash
docker compose ps
```

Expected: `postgres`, `redis`, `mailpit` at minimum, all `healthy`. If not:
`pnpm infra:up`.

- [ ] **Step 5: Confirm `D-133`/`DEC-143` are still free**

```bash
grep -cE "^\| (D-13[3-6]|DEC-14[3-6]) " .agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md
```

Expected: `0`. If not, shift this node's block upward and note the shift.

- [ ] **Step 6: Set the node to running and commit**

Set `M6-GATE.status` to `"running"`, `attempt` to `1`, and add a CP0 evidence
entry recording Steps 1–5's actual output (including the concurrent-agent file
list verbatim).

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/state.json
```

```bash
git commit -m "M6-GATE CP0: intake, concurrency guard against task_c753bff4, clean baseline"
```

---

### CP1: Strengthen the traceability evidence rule, then satisfy it

The existing rule in `validate_plan.py` errors only when `code_paths` **and**
`test_files` are *both* blank — which is why 15 blank `log_or_metric_or_audit`
cells sat under a `closed` status unnoticed. Extend the safety net, not just the
instance (AGENTS.md §5).

**Files:**

- Modify: `.agents/runs/2026-08-10-eow-master-execplan/validate_plan.py:210-222`
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/traceability.csv` (15 rows)

- [ ] **Step 1: Write the stricter check (this is the "failing test")**

Replace the `closed_without_evidence` block with:

```python
        test_cases_col = tc_header.index("test_case_ids")
        log_col = tc_header.index("log_or_metric_or_audit")
        # Strengthened at M6-GATE. The original rule fired only when BOTH
        # code_paths and test_files were blank, so a row could carry code and
        # tests while silently declaring no log/metric/audit and no test case
        # id at all -- which is how 15 of 16 BR-NOT-* rows reached `closed`
        # with an empty log_or_metric_or_audit cell, invisible to every check
        # that existed. AGENTS.md §6 makes logs/metrics/audit part of Definition
        # of Done, so a closed row that genuinely has no such dimension must say
        # so in words ("none: <reason>"), not leave the cell blank.
        for col_name, col_idx in (
            ("code_paths", code_paths_col),
            ("test_files", test_files_col),
            ("test_case_ids", test_cases_col),
            ("log_or_metric_or_audit", log_col),
        ):
            blank = [r[0] for r in tc_data if r[status_col].strip().startswith("closed") and not r[col_idx].strip()]
            if blank:
                err(f"traceability.csv rows marked closed with a blank {col_name}: {blank}")
        missing_tests = []
        for r in tc_data:
            for rel in (p.strip() for p in r[test_files_col].split(";")):
                if rel and not (ROOT / rel).exists():
                    missing_tests.append((r[0], rel))
        if missing_tests:
            err(f"traceability.csv references test files that do not exist (rule_id, path): {missing_tests}")
```

- [ ] **Step 2: Run it and confirm it goes RED on the real gap**

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Expected: `ERRORS: 1` (or more), naming
`traceability.csv rows marked closed with a blank log_or_metric_or_audit: ['BR-NOT-001', … 'BR-NOT-015']`.
If any *other* rule also appears — a `BR-*` outside M6 — that is a second real
finding: record it as `D-133` and fix it in the same checkpoint rather than
narrowing the check to hide it.

- [ ] **Step 3: Fill the 15 cells with evidence read from the code**

For each `BR-NOT-00x` row, open the `code_paths` files and record what is
actually there — never invent a log line. Reference material verified during
planning: `notification` rows are the durable record (migration `021`),
`notifications.service.ts` writes them, `notification-rules.ts` owns severity/
category/message-key policy, `notification-writer.ts` (worker) resolves
recipients, and `BR-NOT-016`'s existing cell already names `notification_metric
log` as the metric surface for creation/delivery/read.

Where a rule genuinely has **no** log/metric/audit dimension (e.g. `BR-NOT-007`,
severity controls icon and colour only), write `none: <one-clause reason>` —
that is a real statement, and the check above accepts it while still rejecting a
blank cell. Do not write `n/a` with no reason.

- [ ] **Step 4: Run the check again and confirm GREEN**

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Expected: `ERRORS: 0   WARNINGS: 0`.

- [ ] **Step 5: Commit**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py .agents/runs/2026-08-10-eow-master-execplan/traceability.csv
```

```bash
git commit -m "M6-GATE CP1: closed rows must declare log/metric/audit and real test files (16 BR-NOT rows filled)"
```

---

### CP2: Dispose of the two rules that cannot simply be marked closed

No production code changes in this checkpoint. Two separate items.

**Files:**

- Modify: `.agents/runs/2026-08-10-eow-master-execplan/state.json` (`M6-GATE.successConditions[0]`)
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md` (`DEC-143`, `D-134`, `DEC-144`)
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/traceability.csv` (`BR-NOT-013`)

- [ ] **Step 1: Re-read `BR-SEND-004`'s row and confirm nothing changed**

```bash
grep "^BR-SEND-004," .agents/runs/2026-08-10-eow-master-execplan/traceability.csv
```

Expected: `status` is `partially_closed`, and the `log_or_metric_or_audit` cell
already ends with the `TC-SEC-016` explanation.

- [ ] **Step 2: Confirm `TC-SEC-016` has a real downstream owner**

```bash
python -c "import json;print([t for t in json.load(open('catalog/test-cases.json',encoding='utf-8')) if t['id']=='TC-SEC-016'])"
```

Expected: `rule_ids` is `BR-SEND-004, BR-SEC-005`. Then confirm `BR-SEC-005` is
`not_started` and that `M7-S2-security-hardening`'s own success conditions name
`TC-SEC-*`. Both were true at planning time.

- [ ] **Step 3: Record `DEC-143` in `EXECPLAN.md`**

Append one row to the Decision Log, following its existing
`| id | decision | why | rejected alternative |` shape:

> **DEC-143** — `M6-GATE`'s first success condition is corrected (matching
> M4-GATE's and M5-GATE's own precedent of correcting stale condition text found
> at evaluation time rather than silently reinterpreting it) to read: *27 of 28
> M6 rules closed; `BR-SEND-004` remains `partially_closed` by design.* Its
> `M6`-scoped acceptance (p95 under 5s, reconnect from `last_event_id`) is real
> and tested (`TC-SEND-004`, `TC-SEND-016`, `realtime-campaign.test.ts`,
> `campaign-realtime.test.ts`, plus this node's own CP6 3-viewport reconnecting
> evidence). Its remaining dimension is `TC-SEC-016`, a `Performance` case
> requiring 10,000 concurrent connections and 1,000 events/s against staging
> infrastructure this host does not have — co-owned by `BR-SEC-005`, which is
> `not_started` and belongs to `M7-S2-security-hardening`, whose own success
> condition already reads "TC-SEC-* (17 cases) executing". Force-closing the row
> here would misrepresent work M7 has not done. Same compound-status precedent as
> `DEC-120` (`BR-SCH-004`/`BR-SCH-007`) and `DEC-029` (`BR-GEN-006`).

Then edit `state.json`'s `M6-GATE.successConditions[0]` to the corrected text,
naming `DEC-143`.

- [ ] **Step 4: Decide `BR-NOT-013`'s `purgeExpired()` defect — do not silently reimplement it**

The fix already exists, written and tested by the D-125 follow-up task, sitting
uncommitted in `.claude/worktrees/kind-wozniak-055662`. Re-check it first:

```bash
git -C .claude/worktrees/kind-wozniak-055662 status --porcelain
```

Two acceptable outcomes, both evidenced:

- **If that task has since landed on `main`** (`git log --oneline -5` shows it):
  nothing to do beyond confirming `BR-NOT-013`'s row still describes reality.
- **If it is still uncommitted** (the state at planning time): **do not
  re-implement it here.** Writing the same three-line change in the primary tree
  would create exactly the two-owners-for-one-file collision AGENTS.md §2 warns
  about, and would orphan that task's own already-written RED test. Instead
  record `DEC-144`:

> **DEC-144** — `BR-NOT-013` stays `closed`, with its row amended to disclose
> that `notifications.service.ts`'s `purgeExpired()` currently returns the raw
> `[rows, count]` tuple length (always `2`) rather than the purged row count —
> the second of D-125's two disclosed instances. Both call sites
> (`notifications.service.ts:29`, `:43`) discard the return value, so no rule's
> observable acceptance is currently wrong; the retention/purge behaviour
> `BR-NOT-013` asserts (expired notifications are deleted, audit rows are not)
> is unaffected and tested. The fix plus its own RED test already exist in
> `.claude/worktrees/kind-wozniak-055662` under the D-125 follow-up task;
> re-implementing it in the primary tree would collide with that agent's live
> work and orphan its test. Recorded as `D-134` and left to its owner, matching
> the D-125/D-127/D-131 precedent for out-of-rule-ownership defects.

Add the matching `D-134` row to the Discovery Log with the diff shown in §2(c).

- [ ] **Step 5: Amend `BR-NOT-013`'s row and re-validate**

Append the `DEC-144` disclosure to `BR-NOT-013`'s `log_or_metric_or_audit` cell
(it was filled at CP1).

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Expected: `ERRORS: 0   WARNINGS: 0`.

- [ ] **Step 6: Commit**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/state.json .agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md .agents/runs/2026-08-10-eow-master-execplan/traceability.csv
```

```bash
git commit -m "M6-GATE CP2: BR-SEND-004 disposition (DEC-143) and BR-NOT-013 purgeExpired disclosure (D-134/DEC-144)"
```

---

### CP3: `ARCH-ASYNCAPI-CONFORMANCE` (condition 4)

The first mechanical check this repo has ever had over `contracts/asyncapi.yaml`.
It is expected to go RED on a real, already-identified defect.

**Files:**

- Create: `packages/architecture-tests/src/asyncapi-conformance.test.ts`
- Modify: `apps/api/src/realtime/realtime.gateway.ts:139`
- Modify: `apps/api/test/integration/realtime-campaign.test.ts`

- [ ] **Step 1: Write the architecture test**

Create `packages/architecture-tests/src/asyncapi-conformance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { read } from './repo.js';

/**
 * ARCH-ASYNCAPI-CONFORMANCE (M6-GATE, condition 4). Before this rule nothing in
 * the workspace opened contracts/asyncapi.yaml or catalog/realtime-events.json --
 * the two files were documentation that only humans read, the same D-38 drift
 * class screen-catalog.yaml already demonstrated. The gate's own wording is
 * "every EMITTED envelope", so the containment is one-directional: an emitted
 * event type must be declared, a declared channel need not yet be emitted.
 */

/** Event types that are outbox domain rows, never socket envelopes. */
const NON_REALTIME_OUTBOX_EVENTS = new Set([
  // Internal work-item relays: outbox-relay.ts turns each into a BullMQ job.
  // They never reach a client, so they are deliberately not AsyncAPI channels.
  'import.job.created',
  'bulk-update.job.created',
  // M4-S4's durable snapshot record. Deliberately visible before a consumer
  // exists, the same boundary campaign.execution_state_changed's own contract
  // comment describes -- but unlike that one it has no client-facing shape
  // agreed yet, so it is not declared as a channel.
  'campaign.snapshot_frozen',
  'campaign.snapshot_superseded',
]);

/** Files that construct a realtime envelope destined for a socket. */
const ENVELOPE_SOURCES = [
  'apps/api/src/campaigns/progress-event.ts',
  'apps/api/src/realtime/realtime.gateway.ts',
  'apps/worker/src/campaign-send/progress-event.ts',
  'apps/worker/src/job-events.ts',
  'apps/worker/src/progress-reconcile.ts',
];

const REQUIRED_ENVELOPE_FIELDS = ['event_id', 'event_type', 'occurred_at', 'tenant_id', 'version', 'data'];

function declaredAddresses(): string[] {
  return [...read('contracts/asyncapi.yaml').matchAll(/^\s{4}address: (\S+)$/gm)].map((m) => m[1]!).sort();
}

function catalogEvents(): { event: string; dedupe: string }[] {
  return JSON.parse(read('catalog/realtime-events.json')) as { event: string; dedupe: string }[];
}

/** Every quoted dotted event-type literal in a source file. */
function emittedTypes(repoRelativePath: string): string[] {
  const source = read(repoRelativePath);
  return [...source.matchAll(/event_type ?: ?'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!)
    .concat([...source.matchAll(/eventType ?: ?'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!))
    .concat([...source.matchAll(/emit\('([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!));
}

describe('ARCH-ASYNCAPI-CONFORMANCE: emitted realtime envelopes match the published contract', () => {
  it('declares an AsyncAPI channel for every emitted event type', () => {
    const declared = new Set(declaredAddresses());
    const undeclared: string[] = [];
    for (const file of ENVELOPE_SOURCES) {
      for (const type of emittedTypes(file)) {
        if (!declared.has(type) && !NON_REALTIME_OUTBOX_EVENTS.has(type)) undeclared.push(`${file}: ${type}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('finds a non-trivial number of emitted event types (guards against a dead scanner)', () => {
    const found = ENVELOPE_SOURCES.flatMap(emittedTypes);
    expect(found.length, 'no event types found — the scanner regex or the file list is wrong').toBeGreaterThanOrEqual(8);
  });

  it('keeps catalog/realtime-events.json and contracts/asyncapi.yaml in agreement', () => {
    const declared = new Set(declaredAddresses());
    const catalogued = catalogEvents().map((e) => e.event);
    expect(catalogued.filter((e) => !declared.has(e))).toEqual([]);
  });

  it('gives every emitted envelope all six required EventEnvelope fields', () => {
    const contract = read('contracts/asyncapi.yaml');
    const required = /required: \[(.+?)\]/.exec(contract)![1]!.split(',').map((f) => f.trim());
    expect(required.sort()).toEqual([...REQUIRED_ENVELOPE_FIELDS].sort());
    const violations: string[] = [];
    for (const file of ENVELOPE_SOURCES) {
      const source = read(file);
      // Scan per emission site, not per file, so one conforming builder cannot
      // cover for a non-conforming sibling in the same module.
      for (const match of source.matchAll(/event_id ?: ?[^;]{0,600}?data ?: ?\{/gs)) {
        const literal = match[0];
        const missing = REQUIRED_ENVELOPE_FIELDS.filter((f) => !new RegExp(`\\b${f} ?:`).test(literal));
        if (missing.length) violations.push(`${file}: envelope missing ${missing.join(', ')}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never feeds a hard-coded version to an event whose dedupe key includes version', () => {
    const versioned = new Set(catalogEvents().filter((e) => e.dedupe.includes('version')).map((e) => e.event));
    const sources = [...ENVELOPE_SOURCES, 'apps/worker/src/import-processor.ts', 'apps/worker/src/bulk-processor.ts', 'apps/worker/src/export-processor.ts'];
    const violations: string[] = [];
    for (const file of sources) {
      const source = read(file);
      for (const match of source.matchAll(/eventType ?: ?'([a-z_]+\.[a-z_]+)'[^;]{0,200}?version ?: ?(\d+)\b/g)) {
        if (versioned.has(match[1]!)) violations.push(`${file}: ${match[1]} given literal version ${match[2]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm the expected RED**

```bash
pnpm --filter @eow/architecture-tests exec vitest run src/asyncapi-conformance.test.ts
```

Expected: the fourth case (`gives every emitted envelope all six required
EventEnvelope fields`) **FAILS** with
`apps/api/src/realtime/realtime.gateway.ts: envelope missing tenant_id`.

If a *different* case also fails, that is an additional real finding — record it
as `D-135` and fix the code, not the test. If **no** case fails, the scanner is
wrong (the `rt.connection.ready` defect at `realtime.gateway.ts:139` is real and
was confirmed by reading the line during planning) — fix the regex until it
reproduces, then continue.

- [ ] **Step 3: Write the RED integration test for the real behaviour**

The architecture test proves the source text is wrong; this proves the wire is
wrong. Add to `apps/api/test/integration/realtime-campaign.test.ts`, reusing the
file's existing authenticated-socket helper (the same one A10/A11 use for a
genuine connection — read the file and reuse it, do not build a second harness):

```ts
  it("rt.connection.ready carries the connecting user's own tenant_id (ARCH-ASYNCAPI-CONFORMANCE)", async () => {
    const client = await connectAuthenticatedSocket(tenantA, userA);
    try {
      const ready = await new Promise<Record<string, unknown>>((resolve) => client.once('rt.connection.ready', resolve));
      expect(ready.tenant_id).toBe(tenantA.id);
      for (const field of ['event_id', 'event_type', 'occurred_at', 'tenant_id', 'version', 'data']) {
        expect(ready, `rt.connection.ready is missing the required EventEnvelope field ${field}`).toHaveProperty(field);
      }
    } finally {
      client.disconnect();
    }
  });
```

`connectAuthenticatedSocket`, `tenantA` and `userA` are placeholders for whatever
that file's real helper and fixtures are called — substitute the real names.

- [ ] **Step 4: Run it and confirm it fails on the wire, not just in the source**

```bash
pnpm --filter @eow/api exec vitest run test/integration/realtime-campaign.test.ts
```

Expected: FAIL — `expected undefined to be '<tenant uuid>'`.

- [ ] **Step 5: Fix the gateway**

`apps/api/src/realtime/realtime.gateway.ts:139` — the handler already resolved
the caller's session to authorise the connection, so the tenant id is in hand.
Read the surrounding lines and use that same resolved value; do not re-query.

```ts
    client.emit('rt.connection.ready', { event_id:crypto.randomUUID(), event_type:'rt.connection.ready', occurred_at:new Date().toISOString(), tenant_id:session.tenantId, aggregate_id:session.userId, version:1, data:{ resume:true } });
```

(`session.tenantId`/`session.userId` are placeholders for whatever the
surrounding scope actually calls them — use the real identifiers.)

- [ ] **Step 6: Run both tests and confirm GREEN**

```bash
pnpm --filter @eow/architecture-tests exec vitest run src/asyncapi-conformance.test.ts
```

```bash
pnpm --filter @eow/api exec vitest run test/integration/realtime-campaign.test.ts
```

Expected: both green. Then confirm nothing else in `apps/api` regressed:

```bash
pnpm --filter @eow/api exec vitest run --maxWorkers=3
```

Expected: 89 files / 645 tests (baseline 644 + this checkpoint's 1), 0 skipped, 0 failed.

- [ ] **Step 7: Record `D-135` and commit**

Add the `rt.connection.ready` finding to `EXECPLAN.md`'s Discovery Log as
`D-135`, stating plainly that it shipped in M6-S1 and reached every connecting
client until this gate.

```bash
git add packages/architecture-tests/src/asyncapi-conformance.test.ts apps/api/src/realtime/realtime.gateway.ts apps/api/test/integration/realtime-campaign.test.ts .agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md
```

```bash
git commit -m "M6-GATE CP3: ARCH-ASYNCAPI-CONFORMANCE, and rt.connection.ready gets its required tenant_id (D-135)"
```

---

### CP4: Prove `TC-HIS-*` and the `TC-SEND-*` progress subset execute (condition 2)

Mapping was verified at planning time; this checkpoint produces the *executing*
half. No code is written unless a run surfaces a failure.

**Files:** `.agents/runs/2026-08-10-eow-master-execplan/state.json` (evidence only)

- [ ] **Step 1: Re-verify the mapping mechanically after CP1/CP2's edits**

Write this as a throwaway script under the scratchpad, run it, then discard it:

```python
import csv, json
rows = list(csv.DictReader(open('.agents/runs/2026-08-10-eow-master-execplan/traceability.csv', encoding='utf-8')))
mapped = {t.strip(): r for r in rows for t in r['test_case_ids'].split(';') if t.strip()}
want = [t['id'] for t in json.load(open('catalog/test-cases.json', encoding='utf-8'))
        if t['id'].startswith('TC-HIS-') or t['id'] in ('TC-SEND-003','TC-SEND-004','TC-SEND-005','TC-SEND-015','TC-SEND-016','TC-SEND-019')]
for tc in want:
    r = mapped.get(tc)
    print(tc, '->', (r['rule_id'], r['status'], bool(r['test_files'].strip())) if r else '*** UNMAPPED ***')
```

Expected: all 16 mapped, every one with `test_files` non-empty, every owning rule
`closed` except `BR-SEND-004` (`partially_closed`, per `DEC-143`).

- [ ] **Step 2: Run the API-side owners of those cases**

```bash
pnpm --filter @eow/api exec vitest run test/integration/campaign-history.test.ts test/integration/history-schema.test.ts test/integration/campaign-export.test.ts test/integration/campaign-pause.test.ts test/integration/campaign-resend.test.ts test/integration/realtime-campaign.test.ts src/campaigns/history-query.test.ts src/campaigns/progress-math.test.ts src/campaigns/export-render.test.ts --maxWorkers=3
```

Expected: all green, 0 skipped. Record the exact file/test counts.

- [ ] **Step 3: Run the worker-side owners**

```bash
pnpm --filter @eow/worker exec vitest run src/campaign-send/send.integration.test.ts src/campaign-send/run.integration.test.ts src/campaign-send/pause.integration.test.ts src/campaign-send/progress-math.test.ts src/export-processor.integration.test.ts src/history-purge.integration.test.ts src/retention-window.test.ts --maxWorkers=3
```

Expected: all green. Per D-132, if `send.integration.test.ts`'s A7 times out at
its hard-coded 30s budget under host load, **re-run that one file standalone
before calling it anything** — it passed in 19.84s with more room. A single
re-run that passes is a flake, not a regression; record both attempts.

- [ ] **Step 4: Run the web-side owners**

```bash
pnpm --filter @eow/web exec vitest run src/screens/history src/api/realtime-status.test.ts --maxWorkers=3
```

Expected: all green.

- [ ] **Step 5: Record and commit**

Write a CP4 evidence entry naming each `TC-*` id, the test file that executes it,
and the run's actual counts — not "all green".

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/state.json
```

```bash
git commit -m "M6-GATE CP4: TC-HIS-* and the TC-SEND-* progress subset executing with real counts"
```

---

### CP5: The notifications popover's `reconnecting` state (condition 3)

`NotificationPopover.tsx` today imports no realtime hook and refetches only when
the filter changes. `UI-SHELL-001` declares `reconnecting` as a required state and
`BR-NOT-012` makes the unread API authoritative after reconnect — the API half is
closed and tested, the client half does not exist.

Because `apps/web` has no `@testing-library/react`, the testable unit is a pure
function; the component wiring stays thin and is verified by CP6's Playwright
capture. This is the established pattern in this repo (`realtime-status.ts`'s own
comment says so explicitly), not a shortcut.

**Files:**

- Modify: `apps/web/src/api/realtime-status.ts`
- Modify: `apps/web/src/api/realtime-status.test.ts`
- Modify: `apps/web/src/overlays/NotificationPopover.tsx`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/api/realtime-status.test.ts` (and add
`shouldRefetchOnReconnect` to the file's existing import from
`./realtime-status.js`):

```ts
describe('shouldRefetchOnReconnect (BR-NOT-012: the unread API is authoritative after a reconnect)', () => {
  it('refetches when the socket comes back after a drop', () => {
    expect(shouldRefetchOnReconnect('reconnecting', 'live')).toBe(true);
    expect(shouldRefetchOnReconnect('offline', 'live')).toBe(true);
  });

  it('does not refetch while the socket stays live -- the socket itself is the channel', () => {
    expect(shouldRefetchOnReconnect('live', 'live')).toBe(false);
  });

  it('does not refetch on the way down -- there is nothing to fill in yet', () => {
    expect(shouldRefetchOnReconnect('live', 'reconnecting')).toBe(false);
    expect(shouldRefetchOnReconnect('reconnecting', 'offline')).toBe(false);
  });

  it('does not refetch on first mount, when there is no previous status', () => {
    expect(shouldRefetchOnReconnect(null, 'live')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm --filter @eow/web exec vitest run src/api/realtime-status.test.ts
```

Expected: FAIL — `shouldRefetchOnReconnect is not a function` / import error.

- [ ] **Step 3: Write the minimal implementation**

Append to `apps/web/src/api/realtime-status.ts`:

```ts
/**
 * BR-NOT-012: after a reconnect the REST unread list is authoritative and fills
 * whatever the socket missed while it was down. Only the down->live edge needs a
 * refetch: staying live means the socket is already the channel, going down
 * means there is nothing to fill in yet, and a null previous status is first
 * mount, whose own initial load already ran.
 */
export function shouldRefetchOnReconnect(previous: RealtimeStatus | null, next: RealtimeStatus): boolean {
  return next === 'live' && previous !== null && previous !== 'live';
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm --filter @eow/web exec vitest run src/api/realtime-status.test.ts
```

Expected: PASS, 6 tests in that file (2 pre-existing + 4 new).

- [ ] **Step 5: Wire the popover**

In `apps/web/src/overlays/NotificationPopover.tsx`, add `useRef` to the existing
`react` import and import `useRealtimeStatus`, `shouldRefetchOnReconnect` and
`type RealtimeStatus` from `../api/realtime-status.js`, then add alongside the
existing `useEffect(() => { void refresh(); }, [filter])`:

```tsx
  const realtimeStatus = useRealtimeStatus();
  const previousStatus = useRef<RealtimeStatus | null>(null);
  useEffect(() => {
    if (shouldRefetchOnReconnect(previousStatus.current, realtimeStatus)) void refresh();
    previousStatus.current = realtimeStatus;
  }, [realtimeStatus]);
```

Render the indicator inside the popover's `<div className="notification-center">`,
immediately before `<div className="notification-toolbar">`, using the **exact**
markup `HistoryScreen.tsx:108` and `CampaignProgressDrawer.tsx:126` already use so
the three surfaces stay visually identical:

```tsx
{realtimeStatus === 'reconnecting' && <p className="login-error" role="status">Đang kết nối lại…</p>}
```

- [ ] **Step 6: Typecheck and run the web suite**

```bash
pnpm --filter @eow/web typecheck
```

```bash
pnpm --filter @eow/web exec vitest run --maxWorkers=3
```

Expected: typecheck clean; 23 files / 73 tests (baseline 69 + 4), 0 skipped, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api/realtime-status.ts apps/web/src/api/realtime-status.test.ts apps/web/src/overlays/NotificationPopover.tsx
```

```bash
git commit -m "M6-GATE CP5: notifications popover shows reconnecting and refetches on reconnect (BR-NOT-012 client half)"
```

---

### CP6: `reconnecting` visual evidence at all 3 viewports (condition 3)

**Files:** Modify `apps/web/e2e/visual-capture.spec.ts` (append one describe block)

- [ ] **Step 1: Confirm the dev-only socket escape hatch still exists**

```bash
grep -n "__eowSocket" apps/web/src/api/realtime.ts
```

Expected: present, guarded by `import.meta.env.DEV`. It is what M6-S1's existing
desktop reconnecting capture uses to force a deterministic disconnect, and this
checkpoint reuses that exact technique — read
`apps/web/e2e/visual-capture.spec.ts:1818-1842` before writing, and copy its
`context.route` + `page.evaluate` + `unroute` sequence rather than inventing a
second one.

- [ ] **Step 2: Append the capture block**

At the end of `apps/web/e2e/visual-capture.spec.ts`:

```ts
// M6-GATE (condition 3): the reconnecting state at all three viewports for
// every surface the condition names. M6-S1 captured the drawer's reconnecting
// state at desktop only; the history list and the notifications popover were
// never captured in that state at all (the popover did not have the state
// until this gate's own CP5). Same deterministic-disconnect technique as
// M6-S1's own desktop capture above -- block the transport, force the socket
// closed, wait for the real indicator.
const M6_GATE_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M6-GATE');

async function forceReconnecting(page: Page, context: BrowserContext): Promise<void> {
  await context.route('**/socket.io/**', (route) => route.abort());
  await page.evaluate(() => (window as unknown as { __eowSocket: { disconnect(): void } }).__eowSocket.disconnect());
  await page.getByText('Đang kết nối lại…').waitFor({ timeout: 10_000 });
}

test.describe('Visual evidence: M6-GATE reconnecting at 3 viewports (production only)', () => {
  for (const viewport of VIEWPORTS) {
    test(`history list — reconnecting — production — ${viewport.name}`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.goto('/history');
      await page.locator('.history-table, .module-card').first().waitFor();
      await forceReconnecting(page, context);
      mkdirSync(resolve(M6_GATE_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_GATE_EVIDENCE_ROOT, 'production', `history-list-reconnecting-${viewport.name}.png`), fullPage: true });
      await context.unroute('**/socket.io/**');
    });

    test(`campaign drawer — reconnecting — production — ${viewport.name}`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const label = `gate-reconnect-${viewport.name}-${Date.now()}`;
      const fixture = await seedSendFixture(page, label, 3);
      const draft = await createDraftWithFixture(page, `Gate reconnect ${viewport.name} ${Date.now()}`, fixture);
      await setDraftSender(page, draft.id, draft.version, 'ops@example.test');
      await sendDraftViaApi(page, draft.id);
      seedCampaignSend(draft.id, 'sending');
      await page.goto(`/history/${draft.id}`);
      await page.locator('.live-send-state').waitFor();
      await forceReconnecting(page, context);
      mkdirSync(resolve(M6_GATE_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_GATE_EVIDENCE_ROOT, 'production', `history-drawer-reconnecting-${viewport.name}.png`), fullPage: true });
      await context.unroute('**/socket.io/**');
    });

    test(`notifications popover — reconnecting — production — ${viewport.name}`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.goto('/history');
      await openNotificationsPopover(page);
      await page.getByRole('dialog', { name: 'Trung tâm thông báo' }).waitFor();
      await forceReconnecting(page, context);
      mkdirSync(resolve(M6_GATE_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_GATE_EVIDENCE_ROOT, 'production', `notifications-popover-reconnecting-${viewport.name}.png`), fullPage: true });
      await context.unroute('**/socket.io/**');
    });
  }
});
```

Two things to reconcile against the real file before running: `openNotificationsPopover`
stands in for however M6-S2's own popover block (near line 1648) opens the bell —
read it and reuse that exact selector rather than guessing at the button's
accessible name; and check whether `Page`/`BrowserContext` need adding to the
`@playwright/test` type import at the top of the file.

- [ ] **Step 3: Run the new block**

```bash
pnpm --filter @eow/web exec playwright test e2e/visual-capture.spec.ts -g "M6-GATE reconnecting"
```

Expected: 9 tests pass (3 surfaces × 3 viewports).

- [ ] **Step 4: Look at every screenshot individually**

```bash
ls -la .agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M6-GATE/production/
```

Expected: 9 PNGs. **Open each one and actually look at it.** A green Playwright
run is not evidence — D-126 is this run's own proof that `getByRole('dialog')`
passes against an element clipped to zero effective area by an ancestor's
`overflow:hidden`. Confirm in each image that the `Đang kết nối lại…` text is
genuinely visible and not clipped, especially at mobile 390×844 where the popover
is narrowest.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/visual-capture.spec.ts .agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M6-GATE
```

```bash
git commit -m "M6-GATE CP6: reconnecting captured at 3 viewports for history list, drawer and notifications popover"
```

---

### CP7: De-stale `screen-catalog.yaml` (condition 3)

**Files:** Modify `.agents/runs/2026-08-10-eow-master-execplan/screen-catalog.yaml`
(and `validate_plan.py` if Step 5's check proves feasible)

- [ ] **Step 1: Confirm the current stale state**

```bash
python -c "import yaml; d=yaml.safe_load(open('.agents/runs/2026-08-10-eow-master-execplan/screen-catalog.yaml',encoding='utf-8')); [print(s['id'],'|',s['status'],'|',list(s.get('states_covered',{}))) for s in d['screens'] if s['id'] in ('UI-HIS-001','UI-HIS-002','UI-SHELL-001')]"
```

Expected: `UI-HIS-001` and `UI-HIS-002` both `not_inventoried` with no
`states_covered`; `UI-SHELL-001` `in_progress` with
`reconnecting: deferred_to_M6-S1`.

- [ ] **Step 2: Read the status vocabulary the validator accepts**

```bash
grep -n -i "status" .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Use a value already in that vocabulary (D-38 added the enforcement); do not
invent one.

- [ ] **Step 3: Fill both entries from real, on-disk evidence**

For `UI-HIS-001` and `UI-HIS-002`, set `status` to the migrated value and add:

- `ported_to`: `apps/web/src/screens/history/HistoryScreen.tsx` and
  `apps/web/src/screens/history/CampaignProgressDrawer.tsx` respectively
- `visual_baseline_path`: production-only — state that plainly, following
  `UI-CF-001`'s own precedent, since neither screen has a handoff counterpart at
  a real route (M6-S1's and M6-S3's capture-block comments both say so)
- `production_render_path`: the real files under
  `evidence/visual/M6-S1-realtime-progress/production/`,
  `evidence/visual/M6-S3-history-recovery/production/` and this node's own
  `evidence/visual/M6-GATE/production/` — list them from `ls`, do not guess
- `states_covered`: one entry per required state (`loading`, `empty`, `error`,
  `success`, `permission_denied`, `reconnecting`), each naming the capture or the
  reasoned diff note that backs it. Where a state is genuinely not applicable, say
  so with the reason (M4-GATE's precedent: "empty is
  `not_applicable_to_this_screen` since Compose has no empty list state") — a bare
  key with no explanation is what this checkpoint exists to remove.

For `UI-SHELL-001`, replace `reconnecting: deferred_to_M6-S1` with the real
description: the shell's notifications popover now renders the state (CP5) and it
is captured at 3 viewports (CP6); extend `production_render_path` with the three
popover PNGs.

- [ ] **Step 4: Validate**

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Expected: `ERRORS: 0   WARNINGS: 0`, still 14 screen entries.

- [ ] **Step 5: Extend the safety net, not just the instance**

This is the third instance of the class D-38 named (an artifact only humans read
drifts) and M1-GATE already caught once for `UI-SHELL-001.error`. Add to
`validate_plan.py`: a screen whose `milestone`-owning nodes in `state.json` are
all `completed` must not still be `not_inventoried`. If that cross-file join is
not cleanly derivable from the two files as they stand, say so explicitly in
`D-136` rather than adding a check that only appears to work.

- [ ] **Step 6: Record `D-136` and commit**

Add a Discovery Log row: `screen-catalog.yaml` was never updated by M6-S1 or
M6-S3 despite both shipping their screens, and state whether Step 5's mechanical
check was added or why it could not be.

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/screen-catalog.yaml .agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

```bash
git commit -m "M6-GATE CP7: UI-HIS-001/002 catalogued with real states_covered, UI-SHELL-001 reconnecting de-staled (D-136)"
```

---

### CP8: Definitive full-workspace verification

**Files:** `.agents/runs/2026-08-10-eow-master-execplan/state.json` (evidence only)

- [ ] **Step 1: Gate on the concurrent agent**

```bash
git status --porcelain
```

`task_c753bff4`'s files must be **either committed or absent** before this
checkpoint's baseline means anything. If they are still uncommitted and changing,
**stop here and report to the user** rather than publishing a baseline measured
over another agent's half-written code. Note the exact state either way — a
baseline taken over a dirty tree must say so in its own evidence.

- [ ] **Step 2: Typecheck and build the whole workspace**

```bash
pnpm typecheck && pnpm build
```

Expected: clean across all 8 workspaces.

- [ ] **Step 3: Run each package's full suite at real parallelism**

```bash
pnpm --filter @eow/api exec vitest run --maxWorkers=3
```

```bash
pnpm --filter @eow/worker exec vitest run --maxWorkers=3
```

```bash
pnpm --filter @eow/web exec vitest run --maxWorkers=3
```

```bash
pnpm --filter @eow/architecture-tests exec vitest run --maxWorkers=3
```

Expected deltas against §0(b)'s baseline — compare **test count and skip count**,
not just exit code (AGENTS.md §2):

| Package | Expected | Delta |
|---|---|---|
| `apps/api` | 89 files / 645 tests | +1 (CP3's `rt.connection.ready` case) |
| `apps/worker` | 29 files / 139 tests | unchanged by this node |
| `apps/web` | 23 files / 73 tests | +4 (CP5's `shouldRefetchOnReconnect`) |
| `packages/architecture-tests` | 16 files / 119 tests | +1 file / +5 (CP3) |

Two disclosed pre-existing exceptions, neither a regression from this node:
`progress-reconcile.integration.test.ts`'s A15/A17 (D-127, owned by
`task_fc02ed64`) and a transiently red `job-wiring.test.ts` if `task_c753bff4`
has one `main.ts` edited and not the other (§0(a)). Anything else that fails:
re-run that one file standalone once (D-132) before treating it as a regression,
and record both attempts.

- [ ] **Step 4: Confirm the deployment contract still holds**

This node changes no port, env var, migration or startup path, so this is a
regression check, not a change:

```bash
docker compose --env-file .env config --quiet
```

Expected: exit 0.

- [ ] **Step 5: Final artifact validation**

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Expected: `ERRORS: 0   WARNINGS: 0`.

- [ ] **Step 6: Commit the evidence**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/state.json
```

```bash
git commit -m "M6-GATE CP8: full workspace verification with per-package test and skip counts"
```

---

### CP9: Close the node

**Files:**

- Modify: `.agents/runs/2026-08-10-eow-master-execplan/state.json`
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md`
- Create: `.agents/runs/2026-08-10-eow-master-execplan/M6-GATE-HANDOFF.md`

- [ ] **Step 1: Walk the four conditions one final time, against the artifacts**

For each, write the evidence entry **from what is now on disk**, not from this
plan's expectations:

1. 27/28 closed with real evidence in all four columns; `BR-SEND-004`
   `partially_closed` per `DEC-143`; enforced going forward by CP1's
   strengthened `validate_plan.py` rule.
2. All 10 `TC-HIS-*` and the 6-case `TC-SEND-*` progress subset mapped and
   executing, with CP4's real counts.
3. `UI-HIS-001`, `UI-HIS-002` and the notifications popover captured at
   1440×900 / 768×1024 / 390×844 including `reconnecting`; `screen-catalog.yaml`
   now describes both screens truthfully.
4. `ARCH-ASYNCAPI-CONFORMANCE` green over every emitted envelope, after fixing
   the `rt.connection.ready` violation it found (`D-135`).

- [ ] **Step 2: Flip the node**

Set `M6-GATE.status` to `"completed"`, `nextAction` to `null`, `failureClass` to
`null`, and `currentNode` to `M7-S1-quota`. Confirm `M7-S1`…`M7-S4` are all
unblocked (each `dependsOn: ["M6-GATE"]`).

- [ ] **Step 3: Update `EXECPLAN.md`'s node-status table**

Mark `M6-GATE` completed in the status table, matching how the five prior gates
are recorded.

- [ ] **Step 4: Write the handoff**

`M6-GATE-HANDOFF.md`, following `M6-S4-HISTORY-RETENTION-HANDOFF.md`'s shape.
It must carry forward, at minimum:

- The commit range this node produced, and that **nothing was pushed**.
- The new per-package baseline (CP8's actual numbers).
- The state of all three background tasks at close, checked at close, not copied
  from this plan.
- `DEC-143`'s consequence for `M7-S2`: `TC-SEC-016` is now explicitly that
  node's to run, and `BR-SEND-004` closes only when it does.
- `DEC-144`'s consequence: `BR-NOT-013`'s `purgeExpired()` count fix is still
  outstanding in `kind-wozniak-055662`.
- Every §0(c) environment fact — they have held for many sessions and the next
  session will otherwise rediscover each one.

- [ ] **Step 5: Final validation and commit**

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Expected: `ERRORS: 0   WARNINGS: 0`.

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/state.json .agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md .agents/runs/2026-08-10-eow-master-execplan/M6-GATE-HANDOFF.md
```

```bash
git commit -m "M6-GATE: completed (27/28 M6 rules closed, BR-SEND-004 partially_closed per DEC-143)"
```

- [ ] **Step 6: Do not push**

`origin/main` stays where it is. Pushing requires separate, explicit confirmation
in the session that does it; no prior approval covers it.

---

## 5. Definition of done

- All four success conditions have evidence on disk that has been re-run, and
  `state.json`'s `M6-GATE.evidence` array names the artifact for each.
- `validate_plan.py`: 0 errors, 0 warnings, with the strengthened traceability
  rule in place.
- `pnpm typecheck` and `pnpm build` clean; per-package test **and skip** counts
  recorded and compared against §0(b)'s baseline.
- `ARCH-ASYNCAPI-CONFORMANCE` exists, is green, and would fail if the
  `rt.connection.ready` defect were reintroduced.
- `screen-catalog.yaml` describes `UI-HIS-001`, `UI-HIS-002` and
  `UI-SHELL-001.reconnecting` truthfully.
- Every discovery (`D-133`…`D-136`) and decision (`DEC-143`…`DEC-146`) is in
  `EXECPLAN.md`.
- `M6-GATE` is `completed`; `M7-S1`…`M7-S4` are unblocked.
- Not pushed.
