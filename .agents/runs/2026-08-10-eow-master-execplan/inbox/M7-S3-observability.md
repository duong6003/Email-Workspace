# M7-S3 Observability Inbox

## Checkpoint 0 — baseline
**Status after this checkpoint:** running
**nextAction:** Complete the dependency review and install the ADR-017 server-only runtime packages (CP1).

### Evidence (verbatim, for state.json)
- Worktree is `/home/duong.vu/workspace/mail-operation/eow-m7-s3` on branch `m7-s3-observability`, based on `5ca0974`; no merge or rebase was performed.
- Fresh-worktree bootstrap discrepancy: `pnpm check` initially stopped during `apps/web` typecheck because `packages/contracts/dist` is gitignored and absent after `pnpm install`. Running `pnpm --filter @eow/contracts build` first restored the generated package output; no source file changed.
- The requested `pnpm infra:up` could not start a second stack because the shared M6 stack already owns `127.0.0.1:55432`, `:56379`, and `:1025`. The failed temporary `eow-m7-s3` containers/network/volumes were removed immediately; the existing PostgreSQL, Redis, and Mailpit services were healthy and used as required by protocol §2.3.
- CP0 `pnpm check` reached the API suite and reported 89 files / 649 tests, 648 passed / 1 failed / 0 skipped. The failure is pre-existing shared-database drift: `rbac-matrix.test.ts` expected the old admin permission list, while migration 033 has already added `dlq:manage` for the M7-S2 branch.
- Targeted package baselines: apps/worker 31 files / 144 tests, 143 passed / 1 failed / 0 skipped; the unrelated failure found an expired export row left by another concurrent suite. apps/web 23 files / 73 tests, all passed / 0 skipped. packages/architecture-tests 16 files / 119 tests, 117 passed / 2 failed / 0 skipped; both failures are host tooling (`docker compose` plugin absent, legacy `docker-compose` present), not repository assertions.
- Baseline discrepancy D-151: the plan expected a green full suite, but concurrent M7-S2 schema changes and shared test data make two baseline assertions stale/non-isolated; the counts above remain the comparison baseline and CP10 must re-run in a quiet window.
- `BR-SEND-013` before-state command produced no `campaign_id` logger/console hit. The plan expected one hit in `progress-reconcile.ts`; repository reality uses `const metric = progressReconcileDriftMetric(...)` followed by `console.log(JSON.stringify(metric))`, so the two-line grep does not join the identifier to the log call. The underlying payload still contains `campaign_id` at that single site.
- Backend logging before-state: three `console.error` calls in API, one `console.log` in worker, and one Nest `Logger` instance with two call sites in `NotificationsService`. `LOG_LEVEL` is declared but no source consumes it.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEND-013 | M7-S3 baseline intake |  |  |  | apps/api/src/common/http-exception.filter.ts, apps/api/src/templates/templates.service.ts, apps/api/src/notifications/notifications.service.ts, apps/worker/src/progress-reconcile.ts | TC-SEND-013 |  | only progressReconcileDriftMetric payload contains campaign_id; no structured correlation stack exists | running |
| BR-SEC-003 | M7-S3 log-redaction half baseline |  |  |  | docs/operations/security-baseline.md | TC-SEC-003 |  | no executable log-redaction evidence exists | running |

### screen-catalog.yaml changes
None. Protocol §1.1 forbids UI changes and visual evidence for this node.

### EXECPLAN entries
- D-151: CP0 differs from the plan in three measured ways: fresh worktrees need `@eow/contracts` built before root typecheck; the shared stack is already running so a second `infra:up` conflicts on ports; and the campaign-id grep returns zero because the sole payload is built one line before `console.log`. Full-suite baseline also contains concurrent/shared-state failures described above.

## Checkpoint 1 — dependency review and install
**Status after this checkpoint:** running
**nextAction:** Add RED tests, then implement the ambient request context and Pino logger (CP2).

### Evidence (verbatim, for state.json)
- `catalog/library-decisions.json` already selects Pino (`BE-014`) and OpenTelemetry (`BE-015`), matching Accepted ADR-017; no conflicting library choice exists.
- Dependency review on 2026-08-19: `pino` 10.3.1, MIT, published 2026-08-15, 37,452,755 weekly downloads; `@opentelemetry/api` 1.9.1, Apache-2.0, published 2026-05-01, 66,388,972 weekly downloads; `@opentelemetry/sdk-node` 0.221.0, Apache-2.0, published 2026-07-21, 14,716,768 weekly downloads; `@opentelemetry/auto-instrumentations-node` 0.79.0, Apache-2.0, published 2026-07-23, 6,990,951 weekly downloads; `@opentelemetry/exporter-prometheus` 0.221.0, Apache-2.0, published 2026-07-21, 13,787,866 weekly downloads.
- All packages are runtime dependencies of server applications only. `apps/web/package.json` is unchanged. The main runtime impact is the auto-instrumentation dependency graph (+167 packages on first API install); this is accepted because ADR-017 requires traces and metrics, while `prom-client` would leave a second tracing stack to add and operate.
- `pnpm audit --audit-level=moderate` reports 9 existing Nodemailer findings (1 low, 6 moderate, 2 high) on the pre-existing `nodemailer@7.0.6` paths. No reported advisory is introduced by Pino or OpenTelemetry. Dependency updates outside this node are not attempted.
- `protobufjs@7.6.5`, pulled transitively by OpenTelemetry, declares a build script. Supply-chain policy now records `protobufjs: false` in `pnpm-workspace.yaml`; the package is used as shipped and no unreviewed install script executes.
- `pnpm typecheck && pnpm build`: exit 0 across all workspace packages. Targeted architecture checks themselves passed, including migration immutability, encoding and structure; the package command still reports the same two host-only Compose-plugin failures because this Vitest configuration ignores file arguments and runs the entire package.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEND-013 | ADR-017 dependency foundation |  |  |  | apps/api/package.json, apps/worker/package.json, apps/scheduler/package.json, pnpm-workspace.yaml | TC-SEND-013 |  | Pino and OpenTelemetry runtime foundation | running |

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- DEC-156: Pino plus `@opentelemetry/{api,sdk-node,auto-instrumentations-node,exporter-prometheus}` are server-only runtime dependencies. Accepted ADR-017 and library decisions BE-014/BE-015 already choose them. `prom-client` is rejected because it covers only metrics and would force the repository to operate two telemetry stacks. Licenses, recency, downloads, audit and bundle/runtime impact were reviewed; no package enters `apps/web`.
- DEC-159: `protobufjs` install scripts are explicitly denied (`allowBuilds.protobufjs: false`). OpenTelemetry uses the distributed JavaScript package without requiring a local build; rejecting the script preserves the workspace supply-chain policy and avoids executing a transitive installer merely to add telemetry.

## Checkpoint 2 — ambient request context and Pino logger
**Status after this checkpoint:** running
**nextAction:** Add the RED unit/integration controls and implement fail-closed log redaction (CP3).

### Evidence (verbatim, for state.json)
- RED was observed: the new observability suites failed to resolve `request-context.js` and `logger.js` before implementation. Because the package script forwards file arguments after `--`, Vitest also collected the full API suite; the unrelated shared-schema RBAC baseline failure remained visible.
- GREEN targeted verification: 5 files / 16 tests passed / 0 skipped (`request-context`, `logger`, `trace-id`, `auth-http`, `audit-log-immutability`). Existing trace-id count remains 3/3; auth HTTP remains 5/5 and proves the request Problem trace id and audit path remain coherent.
- `pnpm --filter @eow/api typecheck` and `build`: exit 0.
- AsyncLocalStorage creates one mutable context per HTTP request. `AuthGuard` fills tenant and actor into that same object after session resolution; it does not create a second context and therefore cannot split a request into two trace ids.
- Pino lines always carry `trace_id`, `tenant_id`, `actor_id`, `module`, and `campaign_id`; boot/shutdown lines emit null identifiers instead of throwing or disappearing. `LOG_LEVEL` is now consumed.
- The global exception filter and both template test-send error paths now use the shared structured logger. The worker's existing progress metric `console.log` and the NotificationsService Nest logger remain for their planned CP4/CP7 conversions.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEND-013 | API ambient request correlation |  |  |  | apps/api/src/observability/request-context.ts, apps/api/src/observability/logger.ts, apps/api/src/main.ts, apps/api/src/auth/auth.guard.ts, apps/api/src/common/http-exception.filter.ts | TC-SEND-013 | apps/api/src/observability/request-context.test.ts, apps/api/src/observability/logger.test.ts, apps/api/src/common/trace-id.test.ts, apps/api/test/integration/auth-http.test.ts | pino fields trace_id, tenant_id, actor_id, module, campaign_id | test_passing |

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- DEC-160: Request correlation uses one mutable AsyncLocalStorage store seeded from `getOrCreateTraceId` before routing and enriched by `AuthGuard` after authentication. Restarting ALS in the guard was rejected because pre-auth and post-auth logs could then acquire different trace ids for one request.

## Checkpoint 3 — fail-closed log redaction
**Status after this checkpoint:** running
**nextAction:** Add migration 036 and propagate correlation into worker/scheduler job contexts (CP4).

### Evidence (verbatim, for state.json)
- RED: 5/7 assertions failed before implementation, visibly leaking the planted SMTP secret, cookie/session token, recipient custom values, email body/subject and unknown-key email address into captured real Pino lines.
- GREEN: 3 files / 10 tests passed / 0 skipped. The integration capture emits three real Pino lines, asserts a trace field is present, proves every planted value is absent, and includes a negative-control raw destination write that must expose its canary.
- `pnpm --filter @eow/api typecheck` and `build`: exit 0.
- Redaction is fail-closed for exact secret/token/cookie keys at any depth and for email-address-shaped string leaves under unknown future keys. Email content becomes byte count plus SHA-256; recipient custom-data field names remain visible while every value becomes `[REDACTED]`.
- Operational identifiers (`tenant`, `campaign`, `execution`, `recipient`, `job`) remain searchable. Secret references remain masked handles (`EO••••12`) rather than being removed completely.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEC-003 | M7-S3 structured-log half |  |  |  | apps/api/src/observability/log-redaction.ts, apps/api/src/observability/logger.ts | TC-SEC-003 | apps/api/src/observability/log-redaction.test.ts, apps/api/test/integration/log-redaction.test.ts | real Pino capture contains no SMTP secret, session token, recipient custom value or email body | partially_closed |
| BR-SEND-013 | logs contain identifiers but no full body or secret |  |  |  | apps/api/src/observability/log-redaction.ts | TC-SEND-013 | apps/api/src/observability/log-redaction.test.ts | content size/hash summaries and masked secret references | test_passing |

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- D-152: Key-only redaction is insufficient for future fields: an unknown property containing an email address leaked in the RED test. A string-leaf value-shape pass was added so newly introduced keys fail closed for address-shaped PII.

## Checkpoint 4 — correlation across process boundaries
**Status after this checkpoint:** running
**nextAction:** Start OpenTelemetry before app imports and add explicit hop spans (CP5).

### Evidence (verbatim, for state.json)
- Migration `036_outbox_trace_id.sql` applied forward against the shared populated database after migrations 034 and 035. The new nullable `outbox_event.trace_id` column and partial index exist; the column has no default so older processes remain compatible.
- RED repository fact: `outbox_event` had no correlation column, and worker audit paths used synthetic identifiers such as `progress-reconcile:<executionId>`.
- GREEN targeted verification: API trace propagation 1 file / 1 test passed / 0 skipped; worker inherited job context 1 file / 1 test passed / 0 skipped. API, worker and scheduler typechecks all exit 0.
- `appendOutboxEvent` writes an explicit trace id when supplied or the ambient request trace id otherwise, without changing `.orIgnore()` idempotency.
- Every BullMQ handler is wrapped in worker AsyncLocalStorage. Jobs inherit `job.data.traceId` when present and receive a UUID fallback when produced by older code. Worker logs carry trace, tenant, job and campaign fields; progress reconciliation now uses the inherited trace for audit/log evidence instead of its synthetic placeholder when a job context exists.
- Scheduler logging now uses Pino and `LOG_LEVEL`; no UI or AsyncAPI file changed.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEND-013 | API outbox and worker job correlation |  |  | database/migrations/036_outbox_trace_id.sql | apps/api/src/outbox/outbox-writer.ts, apps/api/src/database/entities/outbox-event.entity.ts, apps/worker/src/observability/, apps/worker/src/main.ts, apps/worker/src/progress-reconcile.ts, apps/scheduler/src/observability/ | TC-SEND-013 | apps/api/test/integration/trace-propagation.test.ts, apps/worker/src/observability/job-context.test.ts | outbox_event.trace_id + worker pino trace_id/job_id/campaign_id | test_passing |

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- D-153: Worker progress reconciliation used a synthetic audit trace (`progress-reconcile:<executionId>`), which cannot connect to the scheduler/job request that caused the work. The job context now supplies the inherited trace when available and retains the synthetic value only as an older-caller fallback.
- Review-session follow-up, deliberately not applied because M7-S2 owns `apps/worker/src/outbox-relay.ts`: extend each `relay_pending_outbox_events` row type/select to include `trace_id`, then enqueue `{ ..., traceId: row.trace_id ?? undefined }`. Migration 035 currently replaces the SQL function with only `(id, aggregate_id, tenant_id)`; after merging 035+036, replace it in a forward migration or M7-S2 merge resolution to return `trace_id` too.

## Checkpoint 5 — OpenTelemetry hop spans
**Status after this checkpoint:** running
**nextAction:** Add the typed metrics registry and internal-only Prometheus scrape listener (CP6).

### Evidence (verbatim, for state.json)
- API, worker and scheduler import their OpenTelemetry bootstrap as the first line of `main.ts`, before `reflect-metadata` or queue/database imports, so auto-instrumentation can patch modules before use.
- Explicit spans now cover `outbox.append`, `provider.send_batch`, and `webhook.receive`; every worker job has an ambient job context and the auto-instrumented HTTP/PostgreSQL/BullMQ layers cover the surrounding process boundaries.
- Targeted verification: tracing bootstrap + real compiled boot suite passed 2 files / 3 tests / 0 skipped. API, worker and scheduler typechecks all exit 0. With `OTEL_EXPORTER_OTLP_ENDPOINT` unset, span creation executes and the app boots/fails only for its intentional env validation, not telemetry.
- The provider span is batch-level in `run.ts`, not per-message in M7-S1-owned `send.ts`; the exact merge follow-up is recorded below.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEND-013 | OTel API/outbox/job/provider/webhook trace hops |  |  | database/migrations/036_outbox_trace_id.sql | apps/api/src/observability/instrumentation.ts, apps/worker/src/observability/instrumentation.ts, apps/scheduler/src/observability/instrumentation.ts, apps/api/src/outbox/outbox-writer.ts, apps/worker/src/campaign-send/run.ts, apps/api/src/webhooks/webhooks.service.ts | TC-SEND-013 | apps/api/src/observability/tracing.test.ts, apps/api/test/integration/boot.test.ts | spans outbox.append, job context, provider.send_batch, webhook.receive | test_passing |

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- Review-session follow-up, deliberately not applied because M7-S1 owns `apps/worker/src/campaign-send/send.ts`: wrap the existing provider call with `trace.getTracer('eow-worker').startActiveSpan('provider.send', ...)`, set tenant/campaign/execution/recipient attributes, and end the span in `finally`. This refines the current batch span to the per-message span the acceptance ultimately wants.

## Checkpoint 6 — typed metrics registry and internal scrape target
**Status after this checkpoint:** running
**nextAction:** Wire every metric at its authoritative runtime event site (CP7).

### Evidence (verbatim, for state.json)
- DEC-157 implemented: Prometheus exposition is served from a separate internal API-process listener (`METRICS_PORT`, default 9464) at `/metrics`, not from `/api/v1`. It therefore needs neither a public Nest route nor an OpenAPI path and is not proxied by the application nginx route.
- Worker metrics use the same OTel model on an internal listener (`METRICS_PORT`, default 9465). No ports are published by Compose; Prometheus will scrape service DNS inside the backend network.
- GREEN verification: metrics registry + real HTTP scrape passed 2 files / 2 tests / 0 skipped. The exposition contains HELP data and `eow_notification_created_total`, while identifier labels are absent. API and worker typechecks exit 0.
- When no OTLP endpoint/exporter is configured, each SDK explicitly uses `OTEL_TRACES_EXPORTER=none`; the prior RED teardown attempted the SDK default `127.0.0.1:4318`, proving that relying on library defaults would make an unconfigured collector noisy/failing.
- API helpers cover idempotency, notifications, webhook lag and DLQ depth. Worker helpers cover bulk rows, schedule outcomes, send attempts/retries/rejections, progress drift, notification persistence and queue lag. `eow_quota_usage_ratio` remains deliberately absent for M7-S1.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEND-013 | internal Prometheus exposition and typed bounded-label registries |  |  |  | apps/api/src/observability/metrics-registry.ts, apps/api/src/observability/instrumentation.ts, apps/worker/src/observability/job-metrics.ts, apps/worker/src/observability/instrumentation.ts, apps/api/src/config/env.ts | TC-SEND-013 | apps/api/src/observability/metrics-registry.test.ts, apps/api/test/integration/observability-metrics.test.ts | `/metrics` on internal ports 9464/9465; no identifier labels | test_passing |

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- DEC-157: Metrics use separate internal listeners (`api:9464/metrics`, `worker:9465/metrics`). Rejected: `/api/v1/metrics`, which would require public/service-account auth and would be externally proxied; M7-S4 owns nginx so this node cannot safely add an edge deny rule.
- D-154: Current OpenTelemetry SDK defaults attempted an OTLP HTTP export to `127.0.0.1:4318` when no collector endpoint was configured. The bootstrap now explicitly selects the `none` trace exporter unless an operator configures OTLP, preserving the default deployment contract.

## Checkpoint 7 — runtime metrics wired at authoritative sites
**Status after this checkpoint:** running
**nextAction:** Add queue lag, webhook lag and campaign correlation coverage (CP8).

### Evidence (verbatim, for state.json)
- API targeted verification passed 3 files / 19 tests / 0 skipped; worker targeted verification passed 6 files / 22 tests / 0 skipped. API and worker typechecks exit 0.
- Idempotent replay increments only on the two `replayed: true` return paths. The 409 different-payload/in-flight branches remain separate outcomes and do not inflate replay counts.
- Bulk/import metrics are emitted once from terminal aggregate counters rather than per row, avoiding hot-loop metric calls while preserving exact succeeded/failed/skipped totals.
- Schedule metrics emit at the exact missed/blocked/dispatched branches. Send metrics use the `SendBatchOutcome` returned by `run.ts`, outside M7-S1-owned `send.ts`. Progress keeps its structured log payload and also records the gauge.
- Notification creation/read and worker persistence now increment counters. The worker stored-delivery metric represents durable per-user rows; realtime socket delivery remains a separate follow-up because no stable callback currently reports confirmed socket delivery.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEND-013 | runtime evidence metric wiring |  |  |  | apps/api/src/common/idempotency.service.ts, apps/worker/src/bulk-processor.ts, apps/worker/src/import-processor.ts, apps/worker/src/campaign-dispatcher.ts, apps/worker/src/campaign-send/run.ts, apps/worker/src/progress-reconcile.ts, apps/api/src/notifications/notifications.service.ts, apps/worker/src/notification-writer.ts | TC-SEND-013 | existing targeted unit/integration suites (41 tests) | eow_idempotent_replay_total, eow_bulk_rows_total, eow_schedule_misfire_total, eow_send_attempt_total, eow_send_retry_total, eow_provider_reject_total, eow_progress_reconcile_drift, eow_notification_created_total, eow_notification_delivered_total, eow_notification_read_total | test_passing |

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- D-155: `NotificationsService.markAllRead()` had no metric while single-row `markRead()` did. This checkpoint records the gap; a count-returning repository update is needed before `eow_notification_read_total` can increment by the exact affected row count without inventing a value.
- D-161 (overflow per protocol): `send.ts` folds rate-limit/quota deferrals into `retrying` together with actual transient provider failures, so `eow_send_retry_total` currently conflates causes until the M7-S1-owned send path returns distinct outcome fields.
- D-162: `notification-metrics.ts` has declared `socket_delivered` and `channel_attempt` since M6, but no production call site passes either action. Durable stored delivery is now measured; confirmed socket delivery requires a callback/ack contract and is not fabricated.

## Checkpoint 8 — dashboard dimensions and campaign correlation
**Status after this checkpoint:** running
**nextAction:** Commit Grafana/Prometheus definitions, optional Compose profile and thresholded runbook alerts (CP9).

### Evidence (verbatim, for state.json)
- API webhook verification passed 1 file / 25 tests / 0 skipped; worker dispatcher/send verification passed 2 files / 8 tests / 0 skipped. API and worker typechecks exit 0.
- `eow_webhook_lag_seconds{provider}` records server receipt time minus the verified provider signature timestamp. No new untrusted timestamp plumbing was added.
- `eow_queue_lag_seconds{queue}` samples the oldest waiting/delayed job for campaign-execution, import-processing and bulk-processing. Throughput and error rate remain derived from `rate(eow_send_attempt_total{result=...})` rather than stored as redundant counters.
- Campaign send, dispatcher, progress and applied-webhook paths now write structured events while their production ALS context carries `campaign_id`; direct service tests intentionally have no ambient request/job wrapper and therefore show null context fields without throwing or dropping the line.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEND-013 | queue lag, webhook lag, searchable campaign logs |  |  |  | apps/worker/src/main.ts, apps/worker/src/campaign-dispatcher.ts, apps/worker/src/campaign-send/run.ts, apps/api/src/webhooks/webhooks.service.ts | TC-SEND-013 | apps/api/test/integration/webhooks-http.test.ts, apps/worker/src/campaign-dispatcher.integration.test.ts, apps/worker/src/campaign-send/run.integration.test.ts | eow_queue_lag_seconds, eow_webhook_lag_seconds; Pino campaign_id context | test_passing |

### screen-catalog.yaml changes
None.

### EXECPLAN entries
- Throughput and error rate are dashboard queries over `eow_send_attempt_total`, not separate pre-aggregated instruments. This avoids two sources of truth for the same rate and permits arbitrary honest windows at query time.

## Checkpoint 9 — dashboard, scrape config and alert runbook
**Status after this checkpoint:** running
**nextAction:** Run full verification twice in a quiet window, validate deployment/architecture evidence, then prepare ready-for-review handoff (CP10).

### Evidence (verbatim, for state.json)
- Prometheus scrapes API `:9464` and worker `:9465` inside the backend network. The committed Grafana dashboard contains queue lag, throughput, error rate, webhook lag, reconciliation drift, notification delivery and dead-letter panels.
- DEC-158 implemented: Prometheus and Grafana are behind the optional `observability` Compose profile; the default product stack remains unchanged. Legacy `docker-compose` v1 validates both default and profile configurations on this host (the plan's v2 binary is absent, recorded at CP0).
- The runbook now defines seven alerts with metric expression, threshold, `for` duration, severity and action. It names BR-SEC-005 explicitly so M7-S4 can cite the SLO dashboard/alert half. Dead-letter paging follows M7-S2's suggested `depth > 0 for 15m` policy.
- `docs/architecture/observability.md` documents ALS fields, correlation hops, redaction, trace spans, internal scrape endpoints, metric names and bounded-label rules. `ARCH-ENCODING` targeted check passed 1 file / 2 tests / 0 skipped.
- Deployment env documentation and `.env.deploy.example` carry API/worker metrics ports plus optional Grafana bind/port/password. The Grafana password is blank-compatible for the default (profile-disabled) deployment; operators must fill it before enabling the profile.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEND-013 | dashboard and alert operations evidence |  |  |  | deploy/observability/dashboard.json, deploy/observability/prometheus.yml, docs/architecture/observability.md, docs/operations/runbook.md, compose.yaml | TC-SEND-013 | packages/architecture-tests/src/text-encoding.test.ts | four acceptance panels + thresholded alert set | test_passing |
| BR-SEC-005 | M7-S3 alert-set half |  |  |  | docs/operations/runbook.md, deploy/observability/dashboard.json | TC-SEC-005, TC-SEC-016 |  | SLO dashboard and alert definitions; M7-S4 owns recovery/restart proof | partially_closed |

### screen-catalog.yaml changes
None. Grafana is an operations console, not an application handoff screen.

### EXECPLAN entries
- DEC-158: Prometheus/Grafana are opt-in with `--profile observability`. Rejected: adding them to the default stack, which would add image/health dependencies to the one-command product deployment.
- D-163: `apps/api/src/health/health.service.ts` still returns a hardcoded ready literal and probes no dependency. Disclosed only; M7-S4 owns `apps/api/src/health/**`.

## Checkpoint 10 — full verification and node handoff
**Status after this checkpoint:** ready-for-review
**nextAction:** Review session must merge M7-S1/M7-S2, apply the two mechanical follow-ups below, re-run the full suite on the review machine, and only then update shared artifacts or mark the node completed.

### Evidence (verbatim, for state.json)
- `pnpm --filter @eow/api build` exits 0. Four quiet-window `pnpm check` attempts completed workspace typecheck and build with 0 skips, but the root command stopped at database-coupled suites: two runs reported API 97 files / 666 tests with respectively 663 and 665 passing; two isolated-PostgreSQL runs reported respectively API 665/666 and API 666/666 followed by worker 144/145. The repeatable worker failure is the pre-existing M6 realtime-throttle assertion expecting three publications for 600 rows but receiving two; shared-database runs also see M7-S2's already-applied `dlq:manage` permission while this branch correctly retains M7-S2-owned test code. No M7-S3 targeted test failed.
- CP0 comparison: API 89 files / 649 tests (648 pass, 1 shared-state fail), worker 31 / 144 (143 pass, 1 shared-state fail), web 23 / 73 all pass, architecture 16 / 119 (117 pass, 2 host-tool failures), 0 skipped. CP10 increased API coverage to 97 / 666 and worker coverage to 32 / 145; no suite or test count fell and every measured run had 0 skips except the deliberately filtered diagnostic command, which is not used as completion evidence.
- Clean isolated PostgreSQL proof after applying migrations 001-033 and 036: full API suite 97 files / 666 tests passed / 0 skipped. API excluding only the M7-S2-owned stale shared-fixture assertion also passed 96 files / 641 tests / 0 skipped on the shared stack. Worker excluding only the pre-existing `send.integration.test.ts` passed 31 files / 128 tests; the full worker suite reproducibly reports 31 passed files plus 1 failed file, 144 passed / 145 tests / 0 skipped.
- apps/web remains unchanged and its package suite passed 23 files / 73 tests / 0 skipped. Scheduler and contracts contain no test files and exit 0 with `--passWithNoTests`; api-schematics passed 1/1 and runtime-orchestration passed 3/3.
- Architecture tests passed 16 files / 119 tests / 0 skipped when `/tmp/m7-s3-bin/docker` translated this host's missing `docker compose` v2 subcommand to installed `docker-compose` v1. This includes ARCH-RBAC, ARCH-TENANT, ARCH-MIGRATION, ARCH-JOB-WIRING, ARCH-MODULE, ARCH-LAYERING, ARCH-TEST-HYGIENE, ARCH-ENCODING and ARCH-ASYNCAPI-CONFORMANCE. Without the temporary host-only shim, only the two Compose fixture tests fail because Docker reports `unknown flag: --project-name`.
- Default and observability-profile deployment interpolation both exit 0 with `docker-compose --env-file .env config --quiet` and `EOW_GRAFANA_ADMIN_PASSWORD=test-only docker-compose --env-file .env --profile observability config --quiet`. New application metrics variables map `EOW_API_METRICS_PORT`/`EOW_WORKER_METRICS_PORT` to `METRICS_PORT`; the API schema validates `METRICS_PORT`. Grafana bind/port/password belong to the profile container rather than API process configuration and are documented as such.
- DEC-157 uses separate internal scrape listeners, so `contracts/openapi.yaml` was intentionally not edited. The API listener is `api:9464/metrics`, the worker listener is `worker:9465/metrics`, neither is host-published or nginx-proxied, and both use bounded labels without tenant/campaign/job/recipient identifiers.
- Migration 036 is immutable and consistent: `database/migrations/036_outbox_trace_id.sql` SHA-256 is `43cbf5de12afd6249d63fee2b84e7818e6c9d92f659cb1854f8e82d36b596e9d`, equal to `database/migrations.lock.json`; it applied successfully to both the populated shared database and a clean isolated database.
- Final security repair used RED before GREEN twice: a planted secret survived raw `Error.message`/`Error.stack`, then the Nest adapter still supplied the raw message as Pino `msg`. Error output now keeps only name, `[REDACTED]`, and stack SHA-256, and Nest uses fixed `nest-error`; final redaction coverage passed 2 files / 9 tests / 0 skipped and API typecheck exits 0.
- `git diff --check` passes. `apps/web/**`, screenshots, `state.json`, `traceability.csv`, `screen-catalog.yaml`, `EXECPLAN.md`, M7-S1-owned `apps/worker/src/campaign-send/send.ts`, M7-S2-owned `apps/worker/src/outbox-relay.ts`, and M7-S4-owned `apps/api/src/health/**` are untouched.
- The plan-referenced `scripts/validate_plan.py` does not exist in repository reality, so no such command was fabricated; plan/inbox format was checked directly against protocol §4 and this discrepancy is recorded as D-164.
- Full metric evidence emitted by this node: `eow_idempotent_replay_total`, `eow_bulk_rows_total`, `eow_schedule_misfire_total`, `eow_send_attempt_total`, `eow_send_retry_total`, `eow_provider_reject_total`, `eow_progress_reconcile_drift`, `eow_notification_created_total`, `eow_notification_delivered_total`, `eow_notification_read_total`, `eow_queue_lag_seconds`, `eow_webhook_lag_seconds`, and the merge-compatible registry helper `eow_dead_letter_depth`. Pino lines carry `tenant_id`, `trace_id`, and campaign/job context; explicit spans cover `outbox.append`, `provider.send_batch`, and `webhook.receive`, with job wrappers prepared to inherit the relay payload trace.
- `eow_quota_usage_ratio` is not emitted by this node by design. M7-S1 already owns and emits the log payload in `apps/api/src/quota/quota-metrics.ts` from `QuotaService.reserve()`; if the review wants Prometheus exposition as well, add a bounded gauge helper beside `apps/api/src/observability/metrics-registry.ts:18` and invoke it beside M7-S1's `quotaUsageRatioMetric(...)` log at the merged `apps/api/src/quota/quota.service.ts` call site.
- Review follow-up 1, deliberately not applied because M7-S2 owns `apps/worker/src/outbox-relay.ts`: after the merged relay SQL returns the column, change each row type/select from `{ id; aggregate_id; tenant_id }` / `SELECT id, aggregate_id, tenant_id` to include `trace_id`, then change each queue payload at current lines 28 and 58 to exactly `{ jobId: row.aggregate_id, tenantId: row.tenant_id, traceId: row.trace_id ?? undefined }`. Because M7-S2 migration 035 currently replaces `relay_pending_outbox_events` with a three-column return shape, the reviewer must preserve 035 and add the trace column via the reserved forward migration 066 or an equivalent post-merge forward migration; never edit published 035.
- Review follow-up 2, deliberately not applied because M7-S1 owns `apps/worker/src/campaign-send/send.ts`: import `trace` from `@opentelemetry/api`, then replace the current `const result = await sendFn({ ... });` at the merged per-recipient provider call with exactly `const result = await trace.getTracer('eow-worker').startActiveSpan('provider.send', async (span) => { span.setAttributes({ 'eow.tenant_id': tenantId, 'eow.campaign_id': campaignId, 'eow.execution_id': executionId, 'eow.recipient_id': row.recipient_id }); try { return await sendFn({ ...existing arguments... }); } finally { span.end(); } });`. Keep the existing batch-level span until this lands, then the reviewer may remove it if duplicate nesting is not desired.
- BR-SEC-005 link: `docs/operations/runbook.md` and `deploy/observability/dashboard.json` provide the thresholded SLO dashboard/alert half that M7-S4 must cite alongside its restart/durability evidence.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEND-013 | M7-S3-observability |  |  | database/migrations/036_outbox_trace_id.sql | apps/api/src/observability/, apps/api/src/outbox/outbox-writer.ts, apps/api/src/webhooks/webhooks.service.ts, apps/worker/src/observability/, apps/worker/src/main.ts, apps/worker/src/campaign-send/run.ts, apps/scheduler/src/observability/, deploy/observability/, docs/architecture/observability.md, docs/operations/runbook.md | TC-SEND-013 | apps/api/src/observability/logger.test.ts, apps/api/src/observability/request-context.test.ts, apps/api/src/observability/tracing.test.ts, apps/api/src/observability/metrics-registry.test.ts, apps/api/test/integration/trace-propagation.test.ts, apps/api/test/integration/observability-metrics.test.ts, apps/worker/src/observability/job-context.test.ts, packages/architecture-tests/src/text-encoding.test.ts | `eow_idempotent_replay_total`; `eow_bulk_rows_total`; `eow_schedule_misfire_total`; `eow_send_attempt_total`; `eow_send_retry_total`; `eow_provider_reject_total`; `eow_progress_reconcile_drift`; `eow_notification_created_total`; `eow_notification_delivered_total`; `eow_notification_read_total`; `eow_queue_lag_seconds`; `eow_webhook_lag_seconds`; `eow_dead_letter_depth`; Pino structured logs carry tenant_id/trace_id/campaign_id/job_id; OTel spans cover API/outbox/job wrapper/provider batch/webhook with the exact relay and per-message merge follow-ups above; runbook alert set has thresholds | test_passing |
| BR-SEC-003 | M7-S3-observability (log half) |  |  |  | apps/api/src/observability/log-redaction.ts, apps/api/src/observability/logger.ts | TC-SEC-003 | apps/api/src/observability/log-redaction.test.ts, apps/api/test/integration/log-redaction.test.ts | recursive fail-closed redaction; bodies become length/hash, custom values and Error content never appear in captured Pino output | partially_closed |
| BR-SEC-005 | M7-S3 alert/dashboard half |  |  |  | docs/operations/runbook.md, deploy/observability/dashboard.json, deploy/observability/prometheus.yml | TC-SEC-005, TC-SEC-016 | packages/architecture-tests/src/text-encoding.test.ts | dashboard panels plus seven alerts with expression, threshold, for-duration, severity and action; M7-S4 owns restart/durability proof | partially_closed |

### screen-catalog.yaml changes
None. Protocol §1.1 forbids front-end edits, screenshots and visual judgment for this node. Grafana is an opt-in operations console, not an application handoff screen. The deferred UI questions remain exactly those in the plan: no client telemetry was added, trace IDs are not promoted to a copyable screen affordance, and M7-S5 decides any future UI presentation.

### EXECPLAN entries
- DEC-156: Pino and OpenTelemetry remain the Accepted ADR-017 server-only stack after license, security, maintenance, recency and runtime-impact review; `prom-client` was rejected to avoid a second telemetry stack.
- DEC-157: Metrics expose on separate backend-network listeners at API 9464 and worker 9465, not `/api/v1`; therefore no OpenAPI operation or edge route is added.
- DEC-158: Prometheus/Grafana are opt-in with `--profile observability`; the default product deployment does not acquire two new mandatory containers.
- DEC-159: `protobufjs` install scripts remain explicitly denied; the distributed OpenTelemetry packages work without executing that transitive build script.
- DEC-160: One mutable AsyncLocalStorage request store is seeded before routing and enriched after authentication, preserving one trace across pre-auth and post-auth logging.
- D-151: Baseline/full-suite execution depends on generated contract output, a shared occupied infrastructure stack, and database-test isolation; exact counts and failures are recorded above rather than treating exit code alone as evidence.
- D-152: Unknown future fields can leak address-shaped PII under key-only policies; recursive value-shape redaction closes that path.
- D-153: Synthetic worker trace IDs break causality; inherited job trace context replaces them where producers provide it, with UUID fallback only for older producers.
- D-154: The OpenTelemetry SDK otherwise attempts an unconfigured local OTLP endpoint; default bootstrap explicitly selects the `none` exporter.
- D-155: `NotificationsService.markAllRead()` still emits no exact `eow_notification_read_total` increment because its repository update returns no affected-row count.
- D-161: `eow_send_retry_total` currently conflates transient provider failures with rate/quota deferrals because M7-S1-owned `send.ts` adds `overBudget.length` to the same `retrying` outcome.
- D-162: Existing notification metric actions `socket_delivered` and `channel_attempt` have no production caller; this node measures durable stored delivery and does not fabricate socket acknowledgment.
- D-163: `apps/api/src/health/health.service.ts` still returns hardcoded `ready` without dependency probes; disclosed only because M7-S4 owns that directory.
- D-164: The plan references `scripts/validate_plan.py`, but the repository contains no such file. Validation used the binding inbox schema plus architecture/encoding checks instead.
- D-165: CP10 RED review found two Error-log leak paths: raw `Error.message`/`stack` in the serialized object and raw `Error.message` reused as the Pino message string. Both are now covered by executable negative tests.
