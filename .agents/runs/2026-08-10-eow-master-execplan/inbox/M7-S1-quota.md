# M7-S1 quota checkpoint inbox

## Checkpoint 0 — baseline
**Status after this checkpoint:** running
**nextAction:** Migration 034 + entity mapping (CP1).

### Evidence (verbatim, for state.json)
- Worktree `m7-s1-quota` is at `5ca0974e8dc700b5bcc8f0a878135aa0f4b472aa`; `pnpm install --frozen-lockfile` clean.
- The supplied machine had no `.env` in the root clone or any M7 worktree. A local ignored `.env` was generated from `.env.deploy.example`, then synchronized to the already-running shared `eow-m6s2-v1` PostgreSQL/Redis/Mailpit stack without printing credentials.
- The shared PostgreSQL was initially only at migration 021. Running the repository migration runner applied 022–033 cleanly before the baseline suite. This is D-141: the plan assumed migrations 001–033 were already applied, but repository reality disagreed.
- `pnpm check` did not reach exit 0 because of one deterministic pre-existing worker assertion: `apps/worker/src/campaign-send/send.integration.test.ts` expects at least `ceil(600/250) = 3` throttled events, while `sendClaimedBatch` emits exactly 2 (at recipient 250 and 500) and intentionally leaves the final flush to `runOneCampaign`. Re-running that file alone reproduced 1 failed / 16 passed. This is D-142 and is outside M7-S1 scope.
- Measured CP0 counts before the worker failure stopped the recursive suite: apps/api 89/649 passed, apps/worker 30/143 passed + 1 failed (31 files / 144 tests total), 0 skipped in both packages. `apps/web` and `packages/architecture-tests` did not run because recursive testing stops at the first package failure.

### traceability.csv rows to update
(none)

### screen-catalog.yaml changes
None — this node touches no front-end file (PARALLEL-EXECUTION-PROTOCOL-M7 §1.1).

### EXECPLAN entries
- D-141: CP0 database was behind repository source (through 021 only); migration runner applied 022–033 before baseline verification.
- D-142: Existing M6-S1 worker throttle test asserts three publications for 600 mutations although implementation and adjacent comments define two in-batch publications plus a separate `runOneCampaign` end-of-pass flush. Reproduces when run alone; not repaired in M7-S1 because `send.ts` is later touched only for quota enforcement and this defect predates the node.

## Checkpoint 1 — migration 034 + ledger schema
**Status after this checkpoint:** running
**nextAction:** Pure quota period and threshold functions (CP2).

### Evidence (verbatim, for state.json)
- RED: `quota-reservation.test.ts` failed because relation `quota_reservation` did not exist.
- Migration runner: `Migration 034_sending_quota applied.`
- `sha256sum database/migrations/034_sending_quota.sql` → `d703720b4de28036c39f59290b157eb350d0322d3b3f2cc7cec2278250f14657`.
- `quota-reservation.test.ts`: 1 file / 2 tests passed / 0 skipped.
- `@eow/api typecheck`: exit 0. `ARCH-MIGRATION`: 1 file / 1 test passed.

### traceability.csv rows to update
- `BR-CFG-006`: set `migration_files` to `034_sending_quota.sql`; proposed status remains `in_progress`.

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- DEC-147: use a locked quota-reservation ledger rather than a derived message count. Two concurrent transactions can both observe the same pre-reservation derived count; locking the tenant policy row serializes capacity decisions and the partial unique index prevents duplicate live holds.

## Checkpoint 2 — pure period and threshold functions
**Status after this checkpoint:** running
**nextAction:** Locked repository capacity check and reservation (CP3).

### Evidence (verbatim, for state.json)
- RED: both test files failed to resolve their missing implementations.
- GREEN: 2 files / 9 tests passed / 0 skipped.

### traceability.csv rows to update
- `BR-CFG-006`: add `quota-period.ts`, `quota-threshold.ts` and their unit tests to implementation/test evidence; status remains `in_progress`.

### screen-catalog.yaml changes
None.

### EXECPLAN entries
(none)

## Checkpoint 3 — locked repository reservation
**Status after this checkpoint:** running
**nextAction:** Service orchestration, threshold event, notification and metric (CP4).

### Evidence (verbatim, for state.json)
- RED: test failed to resolve the missing `quota.repository.ts`.
- GREEN: real two-connection concurrency race passed three consecutive runs; each run was 1 file / 3 tests passed / 0 skipped. Exactly one 60-unit hold was admitted and final usage was 60, never 120.

### traceability.csv rows to update
- `TC-CFG-006`: add `quota-reservation.test.ts`; proposed status remains `in_progress`.

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- DEC-147 evidence strengthened: PostgreSQL `FOR UPDATE` on the tenant's single `sending_policy` row serializes concurrent capacity checks; the test was repeated 3x to exclude scheduling luck.

## Checkpoint 4 — threshold event, notification and metric
**Status after this checkpoint:** running
**nextAction:** Reserve at confirm, release at cancel, and add quota HTTP surface (CP5).

### Evidence (verbatim, for state.json)
- RED: metric test could not resolve `quota-metrics.js`; integration test could not resolve `quota.service.js`.
- GREEN quota suite: 4 files / 14 tests passed / 0 skipped.
- Notification trigger suite: 1 file / 6 tests passed. ARCH-ASYNCAPI-CONFORMANCE: 1 file / 5 tests passed. API typecheck: exit 0.
- One 80% crossing produced one outbox event and one durable notification; release and re-cross produced no duplicate; one 100-unit reservation produced 80/90/100 events and three notifications.

### traceability.csv rows to update
- `BR-CFG-006`: add threshold event, notification, metric and service files; status remains `in_progress`.
- `BR-NOT-014`: quota trigger is now wired to the contract event name.

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- DEC-146: rename notification trigger source from `quota.threshold` to `quota.threshold_reached`. The AsyncAPI contract and realtime catalog agree on the latter; the architecture conformance scanner makes the former unemittable.

## Checkpoint 5 — confirm reservation, cancel release, quota HTTP
**Status after this checkpoint:** running
**nextAction:** Org-room realtime routing (CP6).

### Evidence (verbatim, for state.json)
- Sending quota HTTP + repository: 3 files / 19 tests passed / 0 skipped (4 HTTP quota, 3 repository, 12 campaign-send regression tests).
- Four campaign regression suites: 4 files / 61 tests passed / 0 skipped; counts unchanged.
- ARCH-RBAC: 1 file / 1 test passed. API typecheck: exit 0.
- Exhausted quota returns `429 application/problem+json`, `code=QUOTA_EXCEEDED`, positive `Retry-After`, and rolls back the freeze/queued transition. Cancel marks the hold released; replay retains one hold.

### traceability.csv rows to update
- `BR-CFG-006`: add confirm/cancel wiring, quota controller and HTTP tests; status remains `in_progress`.
- `TC-CFG-006`: add `sending-quota-http.test.ts`.

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- D-143: Existing send idempotency behavior has two legitimate sequential outcomes while the idempotency row is being finalized: a persisted identical response replays, while an identical request still marked `processing` returns 409. CP9 added a tenant-scoped persisted-response lookup before draft-state validation without bypassing the existing different-payload conflict or non-draft rejection; the invariant proven here is exactly one live quota hold.

## Checkpoint 6 — organization realtime room
**Status after this checkpoint:** running
**nextAction:** Worker-side execution quota enforcement (CP7).

### Evidence (verbatim, for state.json)
- RED: own-tenant org event timed out; cross-tenant negative passed because no org prefix existed.
- GREEN: org-room + existing campaign-room suites: 2 files / 12 tests passed / 0 skipped. Existing realtime-campaign count stayed 10.

### traceability.csv rows to update
- `BR-CFG-006`: add realtime gateway org-room wiring and `realtime-org-room.test.ts`; status remains `in_progress`.

### screen-catalog.yaml changes
None.

### EXECPLAN entries
(none)

## Checkpoint 7 — worker execution-time quota
**Status after this checkpoint:** running
**nextAction:** Additive OpenAPI contract (CP8).

### Evidence (verbatim, for state.json)
- RED: worker submitted 5 instead of 3 and reservation consumed stayed 0.
- GREEN quota-consume suite: 1 file / 3 tests passed / 0 skipped. Quota exhaustion submitted 3, deferred 2, failed 0; reservation consumed was 3; unlimited tenant submitted all 5.
- Existing `run.integration.test.ts`: 1 file / 3 tests passed. Existing `send.integration.test.ts`: 16 passed / 1 failed on the same deterministic D-142 baseline assertion (`2` in-batch events vs expected `3`); no new worker regression was observed.

### traceability.csv rows to update
- `BR-CFG-006` / `TC-CFG-006`: add worker gate and `quota-consume.integration.test.ts`; status remains `in_progress`.

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- D-142 remains open and unchanged from CP0; the worker quota suite is independently green.

## Checkpoint 8 — additive OpenAPI contract
**Status after this checkpoint:** running
**nextAction:** Full verification, final handoff and push (CP9).

### Evidence (verbatim, for state.json)
- `openapi-compat-check` against `/tmp/openapi-before-m7-s1.yaml`: `No breaking OpenAPI changes detected.`
- `pnpm contracts:generate`: exit 0. API typecheck: exit 0.
- Added only reserved `/sending-quota*` paths/schemas and additive 429 responses on send/schedule.

### traceability.csv rows to update
- `BR-CFG-006`: operations `getSendingQuota;putSendingQuota;getSendingQuotaUsage`; status remains `in_progress`.

### screen-catalog.yaml changes
None.

### EXECPLAN entries
(none)

## Checkpoint 9 — verification and handoff
**Status after this checkpoint:** ready-for-review
**nextAction:** Review session applies this inbox to the shared artifacts, then independently re-runs against an isolated PostgreSQL through migration 034 with Docker Compose v2 available.

### Evidence (verbatim, for state.json)
- No deployment variable was added. `send_quota_period` is tenant-owned data, so `SENDING_QUOTA_DEFAULT_PERIOD` was unnecessary. `docker-compose --env-file .env config --quiet` (the host's available Compose v1 binary) exited 0.
- `pnpm --filter @eow/api build` exited 0.
- Final M7-S1 core verification on the isolated database: API quota/realtime selection 7 files / 23 tests passed / 0 skipped; worker quota-consume selection 1 file / 3 tests passed / 0 skipped.
- An isolated database `eow_m7_s1_quota_verify` was created and the repository runner applied all 33 published migration files through `034_sending_quota`; the ledger reported 33 rows and latest id `034_sending_quota`. This avoids M7-S2's migration 035 and permission seed in the shared development database.
- Full-check attempt 1 against that isolated database: apps/api 96 files / 672 passed / 0 skipped; apps/worker 32 files / 147 total, 146 passed / 1 failed / 0 skipped. The sole worker failure was a timing-sensitive pause bound (`7 <= 6`) and passed alone immediately afterward (1 file / 3 passed). Recursive execution stopped before apps/web and architecture tests.
- Full-check attempt 2 against that isolated database: apps/api 96 files / 672 passed / 0 skipped; apps/worker 32 files / 147 total, 145 passed / 2 failed / 0 skipped. One failure was the unchanged D-142 assertion; the other was a deadlock in `run.integration.test.ts` and passed alone immediately afterward (1 file / 3 passed). Recursive execution again stopped before apps/web and architecture tests.
- Compared with CP0, apps/api rose from 89 files / 649 passed to 96 files / 672 passed. Apps/worker rose from 31 files / 144 total to 32 files / 147 total; no test count fell and no skip was reported. Both required `pnpm check` attempts were executed, but neither reached exit 0 because of the disclosed pre-existing/timing-sensitive worker failures.
- Independent apps/web verification (without editing or viewing it): 23 files / 73 tests passed / 0 skipped.
- Full architecture verification: 16 files / 119 total, 117 passed / 2 failed / 0 skipped. `ARCH-MIGRATION`, `ARCH-RBAC`, `ARCH-TENANT`, `ARCH-ASYNCAPI-CONFORMANCE`, `ARCH-LAYERING`, `ARCH-MODULE`, `ARCH-ENCODING` and `ARCH-TEST-HYGIENE` were green. Only the two production-Compose migration-runner cases failed because this host has `docker-compose` v1 but no Docker Compose v2 plugin; both commands failed before fixture startup with `docker: unknown flag: --project-name`.
- Shared-database diagnosis: `progress-counters-db.test.ts` passed alone (7/7), while `rbac-matrix.test.ts` had 24/25 pass because the shared database already contained M7-S2's unmerged `dlq:manage` permission from migration 035. The isolated migration-034 database passed the complete API suite 672/672 on both full-check attempts.
- `git diff --check` exited 0. No `apps/web/**`, `state.json`, `traceability.csv`, `screen-catalog.yaml` or `EXECPLAN.md` path is present in this branch's diff.
- The plan-validation command cannot be run from this checkout: neither `scripts/validate_plan.py` nor another matching validator file exists in repository source. This is recorded rather than silently substituted.
- `BR-CFG-006` is proposed as `test_passing`, not `closed`; closure requires independent re-verification and shared-artifact integration on the review machine.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-CFG-006 | M7-S1-quota | getSendingQuota;putSendingQuota;getSendingQuotaUsage | quota_threshold_reached | 034_sending_quota.sql | apps/api/src/quota/quota.service.ts;apps/api/src/quota/quota.repository.ts;apps/api/src/quota/quota-threshold.ts;apps/api/src/quota/quota-period.ts;apps/api/src/quota/quota-event.ts;apps/api/src/quota/quota-org-publisher.ts;apps/api/src/quota/quota-metrics.ts;apps/api/src/campaigns/campaigns.service.ts;apps/api/src/realtime/realtime.gateway.ts;apps/worker/src/campaign-send/send.ts | TC-CFG-006 | apps/api/test/integration/quota-reservation.test.ts;apps/api/test/integration/quota-threshold-emission.test.ts;apps/api/test/integration/sending-quota-http.test.ts;apps/api/test/integration/realtime-org-room.test.ts;apps/worker/src/campaign-send/quota-consume.integration.test.ts;apps/api/src/quota/quota-threshold.test.ts;apps/api/src/quota/quota-period.test.ts;apps/api/src/quota/quota-metrics.test.ts | metric eow_quota_usage_ratio + quota.threshold_reached outbox event + quota_threshold notification + audit sending_quota.updated | test_passing |

### screen-catalog.yaml changes
None. No front-end source, catalog state, render path or visual evidence was changed.

### EXECPLAN entries
- D-143: Sequential same-key send behavior may replay a persisted response or return the existing 409 while the idempotency row remains `processing`; the implementation preserves payload validation and non-draft rejection while proving only one live quota hold.
- D-144: Migration `026_campaign_execution.sql` added `sending_policy.batch_size`, `max_attempts` and `tenant_rate_limit_per_minute`, but `sending-policy.entity.ts` did not map them. This is pre-existing and outside M7-S1's quota rule; M7-S1 maps only the new quota columns.
- D-145: The single shared development database acquired M7-S2 migration 035 during M7-S1 verification, adding `dlq:manage` before this branch had M7-S2 source. This makes branch-isolated RBAC verification impossible on that database; M7-S1 therefore used a separate migration-034 database for final API evidence.
- DEC-146: Rename the notification trigger source from `quota.threshold` to `quota.threshold_reached`. `catalog/realtime-events.json` and the AsyncAPI contract already define `quota.threshold_reached`, and `ARCH-ASYNCAPI-CONFORMANCE` enforces that authority. Rejected alternative: rename the published contract/catalog event to match the stale source string.
- DEC-147: Use a locked quota-reservation ledger rather than deriving capacity from sent-message counts. Two concurrent transactions can both observe the same derived pre-reservation count; locking the tenant policy row serializes capacity decisions and a partial unique index prevents duplicate live holds. Rejected alternative: count message attempts at confirmation time.
- Authority finding: `state.json` names 80/90/100 threshold emission in M7-S1's success condition although `BR-CFG-006` acceptance text only requires no oversubscription and cancel release. `catalog/realtime-events.json` is authoritative for the threshold event contract; review may promote this finding into a shared decision record.

## DEFERRED UI / VISUAL HANDOFF — not for Codex

1. `UI-CFG-002` (`/settings/policy`) already references `BR-CFG-006` and `quota.threshold_reached`. Adding quota controls or usage presentation would invalidate its existing captures, so no UI change or capture was made here. The documented `GET/PUT /sending-quota` and `GET /sending-quota/usage` API surface unblocks later front-end work.
2. `quota.threshold_reached` now reaches `org:{tenantId}`, but no client subscriber renders a live toast or badge. Durable notifications already flow through the existing notification center, so the event is not silently lost while live presentation is deferred.
3. `screen-catalog.yaml` remains untouched: no `states_covered`, `production_render_path` or capture claim was written.
4. The `QUOTA_EXCEEDED` 429 Problem body and `Retry-After` need a UI-handoff decision (blocking overlay, inline confirm error or notification), deferred to `M7-S5-perf-a11y-visual`.
