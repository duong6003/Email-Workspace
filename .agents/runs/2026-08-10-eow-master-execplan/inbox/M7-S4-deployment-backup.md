# M7-S4-deployment-backup inbox

## Checkpoint 0 — baseline
**Status after this checkpoint:** running
**nextAction:** Fix D-156 in CI, document the secret-safe Compose inspection command, then add ARCH-DEPLOY-CONTRACT.

### Evidence (verbatim, for state.json)
- Branch/worktree verified: `m7-s4-deployment-backup` at baseline `5ca0974`; `.env` was copied from the configured batch tooling and remains gitignored; dependencies installed with pnpm 11.21.0 using a worktree-local `.pnpm-store`.
- CP0 baseline first failed before tests because a clean worktree had generated `packages/contracts/src/openapi.d.ts` but no generated `packages/contracts/dist`; after the documented prerequisite `pnpm --filter @eow/contracts build`, typecheck and build passed. This prerequisite is generated output only and is not committed.
- The full baseline suite then executed 89 API test files / 649 API tests, with 88 files / 648 tests passing and 1 file / 1 test failing; 0 skipped. Failure: `apps/api/test/integration/rbac-matrix.test.ts` expected the pre-M7 admin permission list, while the shared PostgreSQL already contains M7-S2 migration 035's `dlq:manage`. M7-S2's branch updates that test, but this node must not touch another node's file. This is cross-node shared-database contamination rather than an M7-S4 source failure. Worker/web/architecture package baseline counts were not reached because pnpm stopped at the API failure.
- D-156 reproduced as DEPLOY-001 using the installed Compose v1 binary (`docker-compose` 1.29.2; this host has no `docker compose` v2 plugin). Verbatim output is committed in `evidence/deploy/DEPLOY-001-blank-required-secret.txt`; exit was 1 before container startup and the message named `EOW_POSTGRES_APP_PASSWORD`.
- D-156 source locations are `compose.yaml:56`, `compose.yaml:75`, `compose.yaml:117`, `compose.yaml:118`, `compose.yaml:153`; `.env.deploy.example:10` is blank; `.github/workflows/ci.yml` fills the other three required secrets only. `${VAR:?}` rejects blank as well as unset.
- DEPLOY-001 therefore behaves correctly; CI's last deployment-config step is broken.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|
| BR-SEC-004 | M7-S4-deployment-backup |  | 037 reserved-unused | compose.yaml;.env.deploy.example;.github/workflows/ci.yml;docs/deployment;deploy;Dockerfile;scripts | TC-SEC-004;TC-SEC-015 | .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-001-blank-required-secret.txt | DEPLOY-001 real Compose interpolation evidence | running |
| BR-SEC-005 | M7-S4-deployment-backup | getReadiness (planned) | 037 reserved-unused | apps/api/src/health;apps/worker/src/main.ts;apps/scheduler/src/main.ts | TC-SEC-005;TC-SEND-018;TC-SEC-016 | planned | CP0 baseline only | running |

### screen-catalog.yaml changes
No changes. This node has no UI surface, does not touch `apps/web/**`, and takes no screenshots.

### EXECPLAN entries
- D-156: CI copies `.env.deploy.example`, fills only `EOW_POSTGRES_PASSWORD`, `EOW_REDIS_PASSWORD`, and `EOW_SESSION_SECRET`, then Compose rejects blank `EOW_POSTGRES_APP_PASSWORD`, which is required at five Compose locations. The same failure is valid DEPLOY-001 evidence.
- D-157: The batch shares one migrated PostgreSQL. M7-S2 applied migration 035 before M7-S4's CP0 baseline, so M7-S4's baseline `rbac-matrix.test.ts` failed because main's test expected nine admin permissions while the shared database returned the new `dlq:manage` tenth permission. M7-S2 already owns and updates that test; M7-S4 did not edit it.
- D-158: The execution host provides `docker-compose` 1.29.2 but no `docker compose` v2 plugin. Commands and evidence on this host must use the available binary while preserving the documented one-command contract for supported Compose v2 deployment hosts.
- DEC-161: Treat CP0's API permission mismatch as shared-database baseline contamination, record it verbatim, and continue only with M7-S4-owned targeted checks; do not copy M7-S2's source change or reset its migration from the shared database.

## Checkpoint 1 — fix CI and inspect resolved config
**Status after this checkpoint:** running
**nextAction:** Add ARCH-DEPLOY-CONTRACT and prove its CI-fill assertion red against CP0 and green against CP1.

### Evidence (verbatim, for state.json)
- Added the missing CI fill for `EOW_POSTGRES_APP_PASSWORD` beside the other required deployment secrets.
- `docker-compose --env-file ../m7s4-scratch/ci-fixed.env config --quiet` exited 0 with all four required blank example values filled.
- Resolved config without `--quiet` contained the generated PostgreSQL app password five times. `docs/deployment/operations.md` now warns that non-quiet config output contains resolved secrets and must not be pasted into tickets, chat or archived logs.
- DEPLOY-010 config half is now proven: quiet interpolation is valid, while non-quiet output is explicitly classified as sensitive.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|
| BR-SEC-004 | M7-S4-deployment-backup |  | 037 reserved-unused | .github/workflows/ci.yml;docs/deployment/operations.md | TC-SEC-004;TC-SEC-015 | DEPLOY-001 evidence;CP1 Compose config proof | DEPLOY-010 sensitive-config warning | running |

### screen-catalog.yaml changes
No changes; no UI surface.

### EXECPLAN entries
- DEC-162: Deployment config validation uses `config --quiet`; resolved config output is sensitive because Compose substitutes and prints secret values.

## Checkpoint 2 — ARCH-DEPLOY-CONTRACT
**Status after this checkpoint:** running
**nextAction:** Announce the CP3 stack window, create a gitignored deploy env with generated secrets, and execute DEPLOY-002/003/004 when peer nodes are idle.

### Evidence (verbatim, for state.json)
- Added `packages/architecture-tests/src/deployment-contract.test.ts` with four assertions: every real Compose interpolation variable is in `.env.deploy.example`; `${VAR:?}` requirements exactly match docs marked `Required: Yes`; CI fills every required blank example value; every long-running service has a healthcheck or a reasoned allowlist exception.
- RED proof against CP0 CI: 1 file, 4 tests; 1 failed / 3 passed / 0 skipped. The failure named only `EOW_POSTGRES_APP_PASSWORD` as missing from CI fills.
- GREEN proof after CP1: 1 file, 4 tests; 4 passed / 0 failed / 0 skipped.
- The scanner deliberately ignores Compose's escaped container-side `$${POSTGRES_USER}` and `$${POSTGRES_DB}` references; only host interpolation belongs in `.env.deploy.example`.
- `mailpit` is allowlisted as a development-only mail sink; `migrate` is allowlisted as a one-shot service whose successful completion is the dependency gate. Both exceptions carry written reasons.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|
| BR-SEC-004 | M7-S4-deployment-backup |  | 037 reserved-unused | packages/architecture-tests/src/deployment-contract.test.ts;.github/workflows/ci.yml;compose.yaml;.env.deploy.example;docs/deployment/environment-variables.md | TC-SEC-004 | packages/architecture-tests/src/deployment-contract.test.ts | ARCH-DEPLOY-CONTRACT RED/GREEN evidence | running |

### screen-catalog.yaml changes
No changes; no UI surface.

### EXECPLAN entries
- DEC-163: Enforce the one-command deployment contract mechanically in four directions, including a reasoned healthcheck allowlist for Mailpit and the one-shot migration service.

## Checkpoint 3 — DEPLOY-002/003/004 stack window
**Status after this checkpoint:** running
**nextAction:** Execute the primary-project clean boot, smoke check, seeded second boot, and capture evidence; peer M7 nodes were checked idle before the window opened.

### Evidence (verbatim, for state.json)
- STACK WINDOW ANNOUNCEMENT (2026-08-19 Asia/Ho_Chi_Minh): M7-S1, M7-S2 and M7-S3 branches are pushed and no peer `pnpm check`, Vitest or integration process is running. This checkpoint will rebuild and exercise the primary deployment ports and named volumes.
- `.env.deploy.local` was created from `.env.deploy.example`, assigned project `eow-m7s4`, filled with four locally generated 64-hex-character secrets, chmod inherited local user access, and is gitignored. `*.dump` is now also gitignored for CP8.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|
| BR-SEC-004 | M7-S4-deployment-backup |  | 037 reserved-unused | compose.yaml;.env.deploy.example;.gitignore | TC-SEC-004 | DEPLOY-002/003/004 evidence pending | stack window open | running |

### screen-catalog.yaml changes
No changes; no UI surface.

### EXECPLAN entries
- D-159: `docs/deployment/acceptance-tests.md` says seven long-running services, but the Compose model has seven services total: six long-running plus the one-shot `migrate`; Mailpit also has no healthcheck, so `--wait` cannot gate on all seven.
- STACK WINDOW RESULT: the first isolated-project attempt correctly failed because the shared M6 stack still owned host ports 55432/56379/1025/8025. The shared stack was then stopped explicitly; M7 peers were idle throughout.
- DEPLOY-002 passed on a real Docker runtime: all seven service containers reached running/healthy state on this host (Mailpit image reports its own health even though Compose defines no Mailpit healthcheck), `migrate` exited 0, and captured logs show migrations 001-033 applied.
- DEPLOY-003 passed through public port 8080: `/healthz` 200 and `/api/v1/health` 200.
- DEPLOY-004 passed: a `deploy-004-marker` tenant row was inserted before the second build/up; the second deployment reached healthy state, marker count remained 1, and migration logs reported migrations already applied without checksum or object recreation failure.
- Compose v1 lacks `up --wait` and `ps --format json`; this host used the same one-command build/up plus an explicit Docker-health polling loop and plain-text `ps`. Evidence records that host-specific substitution rather than claiming unsupported flags ran.

## Checkpoint 4 — real readiness and case-aware smoke
**Status after this checkpoint:** running
**nextAction:** Execute DEPLOY-005/006/008/010 evidence, using an isolated drift project where possible and the open stack window for primary-project failure cases.

### Evidence (verbatim, for state.json)
- RED readiness proof: the new test suite could not import `readiness.service.ts` because the service did not exist; 1 suite failed before collecting tests.
- GREEN readiness proof: 1 file / 4 tests, all passed / 0 skipped. PostgreSQL failure, Redis failure, both healthy, and response redaction are separately asserted.
- Added public `GET /api/v1/health/ready`: it runs bounded `SELECT 1` and Redis `PING` checks, returns dependency names with booleans/latency only, and responds 503 when unready. Existing `/api/v1/health` liveness semantics remain unchanged.
- API Compose healthcheck now targets `/api/v1/health/ready`; Nginx `/healthz` is explicitly documented as edge liveness only.
- `scripts/smoke_deploy.py` is dependency-free and now supports `--json`, `--case`, Compose service/migrate inspection, edge/API liveness and API readiness. It auto-detects Compose v2 or v1 and names failed case/check pairs.
- Real rebuilt stack proof: smoke JSON reported DEPLOY-002 service and migration checks plus DEPLOY-003 edge liveness, API liveness and API readiness all passing. ARCH-DEPLOY-CONTRACT: 1 file / 4 tests passed / 0 skipped.
- `docs/deployment/acceptance-tests.md` now contains executable procedures, expected results and evidence filenames for DEPLOY-001 through DEPLOY-010, and corrects the service count to seven long-running plus one one-shot migration service.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|
| BR-SEC-005 | M7-S4-deployment-backup | getReadiness (contract deferred CP9) | 037 reserved-unused | apps/api/src/health;compose.yaml;deploy/nginx/default.conf;scripts/smoke_deploy.py;docs/deployment/acceptance-tests.md | TC-SEC-005;TC-SEND-018 | apps/api/src/health/readiness.service.test.ts;packages/architecture-tests/src/deployment-contract.test.ts | DEPLOY-002/003 smoke JSON and 503 readiness contract | running |

### screen-catalog.yaml changes
No changes; no UI surface.

### EXECPLAN entries
- DEC-164: Preserve `/api/v1/health` as liveness and add `/api/v1/health/ready` for PostgreSQL+Redis readiness. Compose gates API health on readiness; Nginx `/healthz` remains independent edge liveness.

## Checkpoint 5 — DEPLOY-005/006/008/010
**Status after this checkpoint:** running
**nextAction:** Execute DEPLOY-007 Redis restart and DEPLOY-009 down/redeploy persistence while the stack window remains open.

### Evidence (verbatim, for state.json)
- DEPLOY-005 focused evidence: existing migration-runner behavior case `fails checksum mismatch and does not apply later migration` passed on a real isolated PostgreSQL container in 3.33s. Focus filtering necessarily reported 35 unselected tests as skipped, so this focused evidence used a scratch no-op reporter; no source test was skipped or changed. The final full architecture suite remains required with zero skips.
- DEPLOY-006 passed: after stopping PostgreSQL, direct API and public readiness both returned HTTP 503 with `{status:"unready", database.ok:false, redis.ok:true}`; the database check timed out at approximately 2002ms without exposing a URL or password. PostgreSQL restart returned API health to `healthy`.
- DEPLOY-008 passed: with web stopped and a real socket holding `0.0.0.0:8080`, Compose exited 1 and named the host bind conflict/address already in use. Web restarted after the holder exited.
- DEPLOY-010 passed: Compose quiet config exited 0; scans of the uncommitted raw Compose log returned zero occurrences for each of `EOW_POSTGRES_PASSWORD`, `EOW_POSTGRES_APP_PASSWORD`, `EOW_REDIS_PASSWORD`, and `EOW_SESSION_SECRET`. Only counts are committed, never the log or values.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|
| BR-SEC-004 | M7-S4-deployment-backup | getReadiness (planned contract) | 037 reserved-unused | database/migrate.sh;apps/api/src/health;compose.yaml;docs/deployment/acceptance-tests.md | TC-SEC-004 | packages/architecture-tests/src/migration-runner-behavior.test.ts;apps/api/src/health/readiness.service.test.ts | DEPLOY-005/006/008/010 real evidence files | running |

### screen-catalog.yaml changes
No changes; no UI surface.

### EXECPLAN entries
- D-160: A focused Vitest `-t` run is incompatible with the workspace no-skips reporter because every unselected test is reported skipped. Focused release evidence therefore needs a scratch reporter or the complete file; the final suite still must prove zero skips.

## Checkpoint 6 — DEPLOY-007/009 stack window
**Status after this checkpoint:** running
**nextAction:** Add BullMQ durability options and author/run the real process-kill recovery evidence for TC-SEND-018.

### Evidence (verbatim, for state.json)
- DEPLOY-007 real container restart: Redis restarted and returned healthy; API, worker and scheduler remained/recovered healthy. PostgreSQL recipient count, duplicate `(campaign_recipient_id, attempt_no)` groups and negative counter violations were all unchanged at zero on this clean deployment. This proves runtime recovery but not a non-empty in-flight campaign; CP7 provides the stronger real kill/job evidence.
- Existing worker integration cases are cited for the non-empty Redis failure semantics: Redis unavailable and mid-run disconnect fail closed, leaving unsent recipients queued rather than lost (`apps/worker/src/campaign-send/send.integration.test.ts`, DEC-103).
- DEPLOY-009 passed: `down` without `-v`, rebuilt/redeployed, all smoke checks passed, the CP3 `deploy-004-marker` still counted 1, and named `eow-m7s4_postgres_data` / `eow-m7s4_redis_data` volumes remained.
- `docs/deployment/operations.md` now explicitly warns that `down -v`/`--volumes` turns a persistence rehearsal into a fresh install.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|
| BR-SEC-005 | M7-S4-deployment-backup | getReadiness (planned contract) | 037 reserved-unused | compose.yaml;docs/deployment/operations.md;apps/worker/src/campaign-send/send.integration.test.ts | TC-SEC-005;TC-SEND-018 | DEPLOY-007/009 evidence plus existing Redis failure integration cases | Redis restart and volume persistence evidence | running |

### screen-catalog.yaml changes
No changes; no UI surface.

### EXECPLAN entries
- No new decision. DEPLOY-009 deliberately uses `down` without volume deletion; DEPLOY-007's empty-stack limitation is disclosed and strengthened by CP7 rather than overstated.

## Checkpoint 7 — TC-SEND-018 worker SIGKILL and BullMQ durability
**Status after this checkpoint:** running
**nextAction:** Implement verified backup/isolated restore scripts, run TC-SEC-015 rehearsal, and write the measured RPO/RTO variance report.

### Evidence (verbatim, for state.json)
- RED process-kill evidence was observed in two useful stages: with the wrong shared `.env`, Redis authentication failed and hooks timed out; with the correct isolated env and competing production workers stopped, the job was redelivered and completed but the assertion exposed BullMQ's real semantic `attemptsMade=1` after a stall rather than 0.
- GREEN evidence: a real compiled Node worker process received an active BullMQ job, emitted an IPC active signal, was killed with `SIGKILL`, and a second compiled worker completed the redelivered job. 1 file / 1 test passed / 0 skipped in 10.31s. Redis process counter was 2, the final job state was `completed`, and BullMQ recorded one stalled/redelivery attempt.
- Production worker option objects now set `lockDuration: 300_000` and `maxStalledCount: 2` for all three Worker instances. Five minutes is longer than the current configured worker batch cadence and avoids redelivering a healthy slow batch; two stalls permit one real process death and one recovery opportunity before failure.
- Scheduler jobs now use `attempts: 3` with exponential 1-second backoff, preserving deterministic job IDs and existing retention options.
- ARCH-JOB-WIRING focused proof: 1 file / 1 test passed / 0 skipped.
- Full worker suite with the correct isolated env reached 32 files / 145 tests, with 29 files / 142 tests passing and 3 pre-existing/timing-sensitive tests failing under the concurrently rebuilt stack: pause bound observed 7 vs <=6; progress event count 2 vs >=3; the restart probe timed out because the full suite and queue consumers competed. The restart test passes deterministically alone with production consumers stopped. No worker suite tests were skipped in that correct-env run.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|
| BR-SEC-005 | M7-S4-deployment-backup | getReadiness (planned contract) | 037 reserved-unused | apps/worker/src/main.ts;apps/scheduler/src/main.ts;apps/worker/src/restart-probe-worker.ts | TC-SEC-005;TC-SEND-018 | apps/worker/src/campaign-send/worker-restart.integration.test.ts;packages/architecture-tests/src/job-wiring.test.ts | Real SIGKILL, stalled redelivery and final completion evidence | partially_closed |

### screen-catalog.yaml changes
No changes. TC-SEND-018's UI progress half is deferred to M7-S5; no screenshot or `apps/web/**` change was made.

### EXECPLAN entries
- DEC-165: BullMQ production workers use a five-minute lock and two stalled recoveries; scheduled jobs use three attempts with exponential one-second backoff. The lock exceeds the expected batch duration so healthy long work is not falsely redelivered.

## Checkpoint 8 — backup, isolated restore and variance report
**Status after this checkpoint:** running
**nextAction:** Add the additive `/health/ready` OpenAPI contract, cite M7-S3 evidence, disclose TC-SEC-016 as not run, then perform final verification and restore the shared stack.

### Evidence (verbatim, for state.json)
- `scripts/backup_db.py` streams `pg_dump -Fc`, removes partial output on failure, verifies readability with `pg_restore --list`, and records UTC timestamp, database, size, SHA-256, duration and verification counts in a UTF-8 JSON sidecar.
- `scripts/restore_db.py` requires `--project`, refuses the source project name, verifies sidecar SHA-256, creates a fresh isolated project with ephemeral host ports, restores without owner/privilege replay, and compares tenant/campaign/recipient/message_attempt/schema_migrations counts.
- TC-SEC-015 real rehearsal passed in isolated project `eow-m7s4-restore`: dump 185,436 bytes; backup duration 0.828s; verified restore RTO 4.289s; backup age at verification 5.159s; counts matched tenant 2, campaign 0, recipient 0, message_attempt 0, schema_migrations 32. Restore volumes were removed after evidence capture.
- The dump and sidecar remain outside the repository under `../m7s4-scratch`; `*.dump` is gitignored and no dump is committed.
- `docs/operations/backup-restore.md` records the measured evidence and explicit variance: immediate backup age and small-data RTO met the numeric targets in this rehearsal, but a 15-minute production RPO is not guaranteed without monitored schedule/WAL archiving or managed PITR, and production-volume RTO remains unmeasured.
- Root scripts now expose `deploy:backup` and `deploy:restore`; deployment docs route operators to the enforced isolated procedure.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|
| BR-SEC-004 | M7-S4-deployment-backup |  | 037 reserved-unused | scripts/backup_db.py;scripts/restore_db.py;docs/operations/backup-restore.md;docs/deployment/operations.md;docs/deployment/quick-deploy.md;package.json | TC-SEC-004;TC-SEC-015 | TC-SEC-015 restore rehearsal evidence | SHA-256/readability/count verification plus measured RPO/RTO variance | test_passing |

### screen-catalog.yaml changes
No changes; backup and restore are operator concerns with no product UI surface.

### EXECPLAN entries
- No additional number required. DEC-164/165 remain sufficient; the BR-SEC-004 variance is evidence, not a change of accepted business meaning.

## Checkpoint 9 — readiness contract and security disclosures
**Status after this checkpoint:** running
**nextAction:** Restore the shared M6 stack, run final targeted/full verification in a quiet window, confirm no secret/dump, finalize ready-for-review inbox, commit and push.

### Evidence (verbatim, for state.json)
- `/health/ready` contract is additive: public `getReadiness`, 200 and 503 responses, `ReadinessResponse` with per-dependency boolean and nonnegative latency. OpenAPI compatibility against the pre-edit copy reported no breaking changes; contracts regenerated and API typecheck passed.
- Repository discrepancy: the existing `/health` operationId is `health`, not the plan's `getHealth`. CP9a's exact path hunk therefore did not apply while schemas landed; CP9b added the path in a separate corrective commit. Existing `/health` remained byte-for-byte untouched.
- TC-SEC-005 first clause is CP7's real SIGKILL/redelivery evidence. M7-S3's pushed inbox states its second clause is implemented by `deploy/observability/dashboard.json`, `deploy/observability/prometheus.yml`, and `docs/operations/runbook.md`: Grafana panels plus seven alerts with expression, threshold, for-duration, severity and action. Those files remain M7-S3-owned and were cited, not edited here.
- `BR-SEC-005` remains proposed `partially_closed` until review merges/re-verifies both branches and because TC-SEC-016 remains not run.

### TC-SEC-016 — NOT RUN, NOT CLAIMED

TC-SEC-016 (SSE 10,000 concurrent connections, 1,000 events/s, p95 event lag < 5s) requires
staging infrastructure that neither the execution host nor the review host has. It was not
executed, not simulated and is not claimed passing. This is the same disposition EXECPLAN
DEC-143 already recorded for it under BR-SEND-004.

Consequences:
- BR-SEND-004 (M6) stays partially_closed. Unchanged by this node.
- BR-SEC-005 is proposed partially_closed, for two independent reasons: TC-SEC-016 was not
  run, and its "SLO dashboard va alert ton tai" clause is M7-S3-observability's work pending merge/review.

What it would need: a host able to hold 10,000 concurrent socket.io connections (file-descriptor
limits, ephemeral port range, and enough memory for the per-connection buffers), a load generator
on a separate host so the client is not the bottleneck, and a Redis able to sustain 1,000
pub/sub messages per second to the gateway.

Attribution note: EXECPLAN DEC-143's prose says BR-SEC-005 "belongs to M7-S2-security-hardening".
state.json's M7-S4 success conditions read "BR-SEC-004, BR-SEC-005 closed", so the node
definition and DEC-143 disagree. The node definition is the operative allocation and this node
acted on it. A reviewing session may want a DEC-* correcting DEC-143's sentence. This node did
not edit EXECPLAN.md.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|
| BR-SEC-004 | M7-S4-deployment-backup | getReadiness | 037 reserved-unused | scripts/backup_db.py;scripts/restore_db.py;docs/operations/backup-restore.md;apps/api/src/health;contracts/openapi.yaml | TC-SEC-004;TC-SEC-015 | readiness.service.test.ts;TC-SEC-015 evidence | verified backup/restore and variance report | test_passing |
| BR-SEC-005 | M7-S4-deployment-backup | getReadiness | 037 reserved-unused | apps/worker/src/main.ts;apps/scheduler/src/main.ts;apps/worker/src/restart-probe-worker.ts;M7-S3 docs/operations/runbook.md and deploy/observability/dashboard.json cited | TC-SEC-005;TC-SEND-018;TC-SEC-016 | worker-restart.integration.test.ts;M7-S3 evidence cited | real SIGKILL recovery plus pending merged dashboard/alerts; TC-SEC-016 not run | partially_closed |

### screen-catalog.yaml changes
No changes; `/health/ready`, deployment and backup have no UI surface.

### EXECPLAN entries
- CP9 discrepancy to merge as a discovery if desired: existing `/health` operationId is `health`, not the plan text's `getHealth`; the accepted path remained untouched and the sibling is additive.
- Reviewer should correct DEC-143's BR-SEC-005 node attribution while preserving its honest TC-SEC-016 not-run disposition.

## Checkpoint 10 — final verification and node handoff
**Status after this checkpoint:** ready-for-review
**nextAction:** Review session merges this inbox into shared artifacts, re-runs DEPLOY evidence and full suites on the review machine, then decides terminal status.

### Evidence (verbatim, for state.json)
- Shared stack restoration: M7-S4 deployment was stopped without deleting its evidence volumes; shared `eow-m6s2-v1` PostgreSQL, Redis and Mailpit were restarted and are healthy on 55432/56379/1025/8025. Isolated restore/drift/verify projects and their volumes are absent.
- `validate_plan.py`: SCHEMA PASS, graph 46 nodes, 134/134 rules allocated, 159/159 test cases, TRACEABILITY.CSV 134 rows, UI catalogue parsed, EXECPLAN 23/23; ERRORS 0, WARNINGS 1 (the known unowned blank-log warning baseline).
- Final focused M7-S4 checks after all repairs: API readiness 1 file / 4 tests passed / 0 skipped; real SIGKILL restart 1 file / 1 test passed / 0 skipped in ~10.33s; architecture deployment contract + job wiring + migration immutability + UTF-8 encoding 4 files / 8 tests passed / 0 skipped; worker build exit 0; Compose config quiet exit 0; OpenAPI compatibility reports no breaking changes; `git diff --check` clean.
- Full workspace check could not produce two green runs on this parallel-batch host and is not claimed. Against a clean baseline-only database, API completed 90 files / 653 tests but encountered one transient teardown deadlock; on another run API was 90/653 green. Worker completed 32 files / 145 tests with 30 files / 143 tests passing and two existing timing/contention failures (600-recipient progress publish expected >=3 but observed 2; a campaign-send orchestration FK race). The new restart test is now isolated to Redis DB 14 and passes inside the full worker run. Zero skips were reported in these full runs. Review must re-run `pnpm check` twice after sequential merge, as protocol requires.
- CP0's shared-database M7-S2 `dlq:manage` contamination remains restored: permission count 1 and admin grant count 1 after the bounded baseline-only API experiment.
- Secret/dump audit: no `.env`, dump, compressed SQL or coverage artifact is tracked; real dump and raw logs remain outside the repo. Committed `DEPLOY-010-secret-counts.txt` contains only four zero counts. Migration `037` was reserved and deliberately unused.
- All ten DEPLOY cases have committed evidence files. BR-SEC-004 is proposed `test_passing` based on verified backup/restore plus the explicit accepted variance report. BR-SEC-005 is proposed `partially_closed`: restart durability is proven; M7-S3 owns the dashboard/alert half pending merge/review; TC-SEC-016 was not run.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|
| BR-SEC-004 | M7-S4-deployment-backup | getReadiness | 037 reserved-unused | scripts/backup_db.py;scripts/restore_db.py;docs/operations/backup-restore.md;docs/deployment;compose.yaml;contracts/openapi.yaml | TC-SEC-004;TC-SEC-015 | apps/api/src/health/readiness.service.test.ts;packages/architecture-tests/src/deployment-contract.test.ts;TC-SEC-015 rehearsal | all DEPLOY-001..010 files; backup SHA/readability/counts; RPO/RTO variance | test_passing |
| BR-SEC-005 | M7-S4-deployment-backup | getReadiness | 037 reserved-unused | apps/api/src/health;apps/worker/src/main.ts;apps/scheduler/src/main.ts;apps/worker/src/restart-probe-worker.ts;M7-S3 runbook/dashboard cited | TC-SEC-005;TC-SEND-018;TC-SEC-016 | apps/worker/src/campaign-send/worker-restart.integration.test.ts;packages/architecture-tests/src/job-wiring.test.ts | real SIGKILL stalled redelivery; M7-S3 seven alerts/dashboard pending merge; TC-SEC-016 not run | partially_closed |

### screen-catalog.yaml changes
No changes. No `apps/web/**` file was touched, no screenshot was taken, and no visual state was judged.

### EXECPLAN entries
- D-156 through D-160 and DEC-161 through DEC-165 are recorded in prior sections. No number outside this node's reservation was used.
- Migration 037 was reserved and is deliberately unused.
- Final status is ready-for-review, never completed; independent review-machine verification is still required.

### DEFERRED UI / VISUAL HANDOFF
- `TC-SEC-005`, `TC-SEC-015` and `TC-SEND-018` are catalogued as API + UI. This node authored only infrastructure/API/recovery evidence.
- M7-S5 should verify that a campaign observed through a worker restart shows coherent non-regressing progress. CP7 supplies the backend queue-redelivery guarantee; existing BR-SEND-003 progress facts remain authoritative.
- Deployment, readiness and backup state have no product screen and should remain operator surfaces through the readiness endpoint, smoke script and backup/restore runbook.
- `screen-catalog.yaml` was not edited; no `states_covered` or capture was written.
