# M7-S3 Observability — Implementation Plan

> **For Codex, working in the `m7-s3-observability` git worktree on a machine that does not have
> this conversation.** Every checkpoint is self-contained. Read
> [`PARALLEL-EXECUTION-PROTOCOL-M7.md`](PARALLEL-EXECUTION-PROTOCOL-M7.md) **first** — it is
> binding, and §3 allocates the numbers this plan uses. Read
> [`PARALLEL-EXECUTION-PROTOCOL.md`](PARALLEL-EXECUTION-PROTOCOL.md) §4 for the inbox pattern.

**Node:** `M7-S3-observability` · **Branch:** `m7-s3-observability`
**Rule:** `BR-SEND-013` (P1) — plus the **log-redaction half of `BR-SEC-003`** (see Scope)
**Test case:** `TC-SEND-013` · **Migration reserved:** `036` (second, if needed: `066`)
**`DEC-*` block:** DEC-156…DEC-160 · **`D-*` block:** D-151…D-155 (overflow: DEC-166+, D-161+)
**OpenAPI prefix owned:** `/metrics` · **AsyncAPI:** edits nothing

---

## Goal

`BR-SEND-013`: *"Mỗi campaign/job/message có correlation_id; log, metric và trace không chứa
secret hoặc body đầy đủ."* Acceptance: *"Có dashboard queue lag, throughput, error rate, webhook
lag; tìm log theo campaign_id."*

Concretely: a structured logger whose every line carries `tenant_id` and `trace_id`; a trace that
survives the API → outbox → job → provider → webhook hops; the eleven metrics
`traceability-plan.yaml`'s `runtime_evidence` names, scrapable from a real endpoint; a dashboard
definition and a runbook alert set with actual thresholds; and a test that proves no session
token, SMTP credential, recipient custom value or email body ever reaches a log line.

## Scope — read this before writing anything

### This is the widest node in the batch. It starts from almost nothing.

Verified at `eb5a835`. `EXECPLAN.md:811-812` already said it plainly and it is still true:

> Current state: **nothing** — Nest's default console logger, no tracing, no metrics, no
> correlation IDs.

- **No logging library.** `pino` and `winston` appear in no `package.json` and not in
  `pnpm-lock.yaml`. The entire backend logs through **four** call sites:
  `apps/api/src/common/http-exception.filter.ts:29` (`console.error` with the whole error object),
  `apps/api/src/templates/templates.service.ts:285` and `:311`, and
  `apps/worker/src/progress-reconcile.ts:172-173` — plus one Nest `Logger` in
  `apps/api/src/notifications/notifications.service.ts:26`, used at `:105` and `:111`.
- **`LOG_LEVEL` is declared and read by nothing.** `apps/api/src/config/env.ts:16`
  (`z.enum(['debug','info','warn','error']).default('info')`); `compose.yaml` passes it to `api`
  (L85), `worker` (L130) and `scheduler` (L156). No source file consumes it.
- **No OpenTelemetry.** Zero `@opentelemetry/*` packages anywhere.
- **No metrics library, no `/metrics` endpoint.** `apps/api/src/health/health.service.ts` returns a
  **hardcoded literal** `{status:'ready', service:'api', time}` and probes nothing.
- **`outbox_event` has no correlation column** (`001_initial.sql:84-90`), so the API→outbox→job hop
  has no id to carry today.
- **No redaction anywhere.** Redaction today is structural — two metric builders drop sensitive
  inputs by not copying them (`apps/api/src/notifications/notification-metrics.ts:4-6` accepts
  `recipient?: string` and omits it; `apps/worker/src/progress-metrics.ts:16` says "identifiers and
  magnitudes only").
- **No dashboard, no Prometheus, no Grafana.** `deploy/` contains exactly one file,
  `deploy/nginx/default.conf`. `compose.yaml` has no observability service.

### `ADR-017` is Accepted and this node implements it — it does not supersede it

`docs/adr/adr-017-observability.md` (15 lines, Status: **Accepted**), decision line 7:

> Pino structured logs + OpenTelemetry traces/metrics; correlation IDs propagate through outbox and
> jobs.

Rationale line 11: *"Required to explain duplicate, delay, retry and provider failures."*
Alternative rejected line 15: *"Log-only diagnostics."*

So `pino` and `@opentelemetry/*` are **already-accepted architectural choices**, not new decisions.
AGENTS.md §5 still requires a dependency review before adding them — that is CP1, and it is a real
step, not a formality. Do **not** write a superseding ADR; AGENTS.md §5 forbids silently changing
an Accepted one, and you are not changing it.

### You own the log-redaction half of `BR-SEC-003` — say so, but do not claim the rule

`traceability-plan.yaml:293` names `BR-SEC-003`'s evidence as *"a redaction test asserting
recipient custom values and email bodies never appear in logs"*, and `:295` states the invariant:

> No log, metric or audit field may contain an unmasked recipient custom value, email body, session
> token or SMTP credential (docs/operations/security-baseline.md).

`M7-S2-security-hardening` owns the rest of `BR-SEC-003` (response/error payloads, export expiry,
injection, stored XSS) and will propose it `partially_closed`. **You supply the missing half.**
In your inbox, add a `BR-SEC-003` row proposing `partially_closed` with your redaction test in
`test_files` and a note that `M7-S2` supplies the other half — so a reviewing session merging both
branches can flip it to `closed`. Protocol §8.2. **Do not propose `closed` for `BR-SEC-003`.**

### `BR-SEC-005`'s "SLO dashboard và alert tồn tại" depends on you

`M7-S4-deployment-backup` owns `BR-SEC-005`, whose acceptance is *"Job không mất/không trùng sau
restart; **SLO dashboard và alert tồn tại**."* The alert set lives in
`docs/operations/runbook.md`, which **you own exclusively** (protocol §3.6). M7-S4 will propose
`BR-SEC-005` as `partially_closed` and cite your runbook. Make CP9's alert set good enough to
carry that citation, and name `BR-SEC-005` in your inbox so the reviewer sees the link.

### `eow_quota_usage_ratio` is explicitly NOT yours

`traceability-plan.yaml:292` lists it under `BR-CFG-006`. **`M7-S1-quota` emits it**, using the
existing log-payload precedent, because the ledger it measures does not exist until that node
lands. Your metric registry should be built so that wiring it in afterwards is a small follow-up —
but **do not create the metric, and do not build a quota ledger.** Protocol §8.2.

## Architecture

Five layers, each independently testable, built bottom-up so nothing is stubbed:

1. **Ambient context.** An `AsyncLocalStorage` store holding `{traceId, tenantId, actorId, module}`.
   This is the piece nothing in the repo has: `apps/api/src/common/trace-id.ts` memoizes a trace id
   onto the **Express request object** and propagates by explicit argument-passing, with exactly two
   callers. A logger cannot reach that. The store wraps every HTTP request and every job execution,
   so a log line written anywhere below gets `tenant_id`/`trace_id` without the call site knowing.
   `getOrCreateTraceId` stays and keeps feeding the store — `EXECPLAN` D-26 requires the Problem
   response's `traceId` and the `audit_log` row to match, and that behaviour must not change.

2. **The logger.** One `pino` instance per app, configured from `LOG_LEVEL` (which finally becomes
   live), with a mixin injecting the ALS context and a `redact` configuration plus a serializer for
   the shapes `redact` paths cannot express.

3. **Correlation across processes.** Migration `036` adds `outbox_event.trace_id`; the relay reads
   it into the job payload; the worker's job wrapper seeds the ALS store from it. That is what makes
   *"tìm log theo campaign_id"* and the API→job hop real rather than aspirational.

4. **Traces.** OpenTelemetry SDK started before anything else in each app's `main.ts`, with
   auto-instrumentation for HTTP and PostgreSQL, and explicit spans at the four hops
   auto-instrumentation cannot infer: outbox append, job execution, provider send, webhook receipt.

5. **Metrics + dashboard + alerts.** An OTel meter with a Prometheus exporter served at `/metrics`;
   the eleven `runtime_evidence` metrics wired at their real event sites; a committed Grafana
   dashboard; and the runbook alert set with thresholds.

## The eleven metrics and where each event actually happens

This mapping was derived by reading each site, not by grepping names. **Only one of the eleven
exists today.**

| Metric | Exists? | Where the underlying event happens |
|---|---|---|
| `eow_progress_reconcile_drift` | **YES** | `apps/worker/src/progress-metrics.ts:19`, emitted at `apps/worker/src/progress-reconcile.ts:171-173`. Keep the existing builder; route it through the registry. |
| `eow_idempotent_replay_total{resource}` | No | `apps/api/src/common/idempotency.service.ts` — the two `replayed: true` returns at **line 67** and **line 95**. The `resource` label already exists as the `resourceType` parameter (line 49). The 409 branches (`:64, :69, :92, :98`) are a **different** outcome — do not count them as replays. |
| `eow_bulk_rows_total{result}` | No | `apps/worker/src/bulk-processor.ts` — per-row at **:110** (`succeeded`) and **:114** (`failed`); aggregates in `bulkCounters()` at **:219-235**; terminal write at **:259-264**. Import's parallel path: `apps/worker/src/import-processor.ts:285, 299`. |
| `eow_schedule_misfire_total` | No | `apps/worker/src/campaign-dispatcher.ts` — misfire at **:92** (`latenessSeconds > misfireGraceSeconds`), audited `schedule.missed` at **:99**, returns `'missed'` at **:101**. Siblings `'blocked'` (**:123**) and `'dispatched'` (**:144**) are the other outcomes and are worth a label. |
| `eow_send_attempt_total{result}` | No | `apps/worker/src/campaign-send/send.ts` batch loop **:140-199**; `SendBatchOutcome = {submitted, retrying, failed}` at **:26**. **Emit from `run.ts:79`'s returned outcome, NOT from inside `send.ts`** — protocol §3.6: `send.ts` belongs to M7-S1 this batch. |
| `eow_send_retry_total` | No | Same outcome object (`retrying`). Note `send.ts:214` folds rate-limit/over-budget deferrals into `retrying` alongside real error retries — record that as a `D-*`: the metric conflates two causes, and separating them needs a `send.ts` change you cannot make this batch. |
| `eow_provider_reject_total` | No | Same outcome object (`failed` = permanent classification from `classifySmtpError` at `send.ts:181-183`). Same file-ownership constraint. |
| `eow_notification_created_total` | Partial | `apps/api/src/notifications/notifications.service.ts:105` already emits `action:'created'` via `notificationMetric(...)` — but with **no `eow_` name and no counter**. Worker path emits nothing: `apps/worker/src/notification-writer.ts:51-59`. |
| `eow_notification_delivered_total` | No | `notification-metrics.ts:1`'s type declares `'socket_delivered'` and `'channel_attempt'` **and no code ever passes them**. Delivery is `apps/api/src/realtime/` + the `user_notification` fan-out at `notification-writer.ts:60-65`. |
| `eow_notification_read_total` | Partial | `notifications.service.ts:111` emits `action:'read'`. `markAllRead()` at **:113** emits **nothing** — a real gap. |
| `eow_quota_usage_ratio` | No | **NOT YOURS.** `M7-S1` emits it. See Scope. |

`BR-SEND-013`'s acceptance also names four dashboard dimensions that are not in that list —
**queue lag, throughput, error rate, webhook lag** — so CP8 adds `eow_queue_lag_seconds`,
`eow_webhook_lag_seconds` and derives throughput/error-rate from the send counters.

## What already exists (verified — do not rebuild it)

| Thing | Where | Note |
|---|---|---|
| Trace id | `apps/api/src/common/trace-id.ts` (34 lines): `TRACE_HEADER = 'x-trace-id'`, `getOrCreateTraceId(request)` memoizes onto `request.traceId`, honouring an inbound header | Two callers: `http-exception.filter.ts:20`, `common/interceptors/audit.interceptor.ts:38`. Its memoization exists because the Problem response's `traceId` must equal the `audit_log` row's (`EXECPLAN` D-26). **Keep that guarantee.** Tests: `trace-id.test.ts` (3). |
| Request-scoped tenant | `apps/api/src/auth/authenticated-request.ts:3-11` — `AuthContext = {userId, tenantId, role, sessionId, permissions}` on `request.auth` | **There is no `TenantContext` class** despite `EXECPLAN.md:790` naming one. `apps/api/src/database/tenant-transaction.ts`'s `setTenantContext` is a Postgres transaction-local `set_config('app.tenant_id', ...)` — RLS, not an in-process context, and not readable by a logger. |
| Worker tenant context | `apps/worker/src/tenant-database.ts` (24 lines) — `runInTenantTransaction(pool, tenantId, work)`, same `set_config` shape | `tenantId` travels as an ordinary function parameter through every worker call chain. |
| Audit log | `audit_log` (`001_initial.sql:91-95`) with **`trace_id text NOT NULL`** — the only correlation column in the schema; writer `apps/api/src/common/audit-writer.ts` (30 lines); interceptor `apps/api/src/common/interceptors/audit.interceptor.ts` (77 lines, global `APP_INTERCEPTOR`, uses `concatMap` so the write commits before the response, failure variant is action + `.failed`, metadata on error is deliberately only `{status}`) | Action convention: `<entity>.<verb_past>`. Worker rows use **synthetic** trace ids — `campaign-dispatcher.ts:47` passes `` `dispatcher:${campaignId}` ``, `progress-reconcile.ts:147` passes `` `progress-reconcile:${executionId}` ``. Replacing those with real propagated ids is part of CP4. |
| The two existing metric builders | `apps/api/src/notifications/notification-metrics.ts` (6 lines, no `metric:` name), `apps/worker/src/progress-metrics.ts` (26 lines, **with** `metric:` and `value:`) | `progress-metrics.ts:1-7` documents the whole precedent: *"No stack in this repo runs a Prometheus/OTel exporter (ADR-017 names Pino + OTel as the eventual destination); the log line itself is the metric until one exists."* You are the node that makes one exist. |
| Health | `apps/api/src/health/` — 4 files, `GET /api/v1/health` returning a hardcoded literal | **`M7-S4` owns this directory** (protocol §3.6). Do not add readiness probing here. |
| Runbook | `docs/operations/runbook.md` — **12 lines**, no headings beyond the H1, no alert set. Lines 3-5 name alert *subjects* in prose: "Alert on queue age, failed-job rate, provider rejection, webhook lag, progress reconciliation drift and notification delivery failures." | **You own this file.** Those six subjects are your alert set's starting list. |
| Bootstraps | `apps/api/src/main.ts` (21 lines, ESM top-level await, line 1 `import 'reflect-metadata';`, `NestFactory.create` at :16, `setGlobalPrefix('api/v1')` at :17, `listen` at :21); `apps/worker/src/main.ts` (146 lines, three `Worker`s at :23/:127/:136); `apps/scheduler/src/main.ts` (31 lines) | All three compiled by `tsc`, run as `node dist/main.js`. **`apps/worker/src/main.ts` and `apps/scheduler/src/main.ts` are shared with `M7-S4`** (protocol §3.6): you touch line 1 and the job-result handling; M7-S4 touches the `Worker`/`queue.add` option objects. Do not reformat either file. |
| Compose | 7 services (`postgres`, `redis`, `mailpit`, `migrate` one-shot, `api`, `worker`, `scheduler`, `web`), 2 volumes, 1 bridge network. Published ports: PG 55432, Redis 56379, Mailpit 8025/1025, web 8080 | No container exposes a metrics port. `web` is nginx (`deploy/nginx/default.conf`) proxying `/api/` to `api:3000` and `/socket.io/`. |
| CI | `.github/workflows/ci.yml` — `pnpm check`, then `cp .env.deploy.example .env`, three `sed` fills, `docker compose --env-file .env config --quiet` | **`M7-S4` owns this file** and is fixing a real defect in it (protocol §8.4). Do not edit it. |

## Tech stack

TypeScript (ESM, `node >= 22.13`), NestJS, `pino`, `@opentelemetry/*`, PostgreSQL 17, BullMQ +
`ioredis`, Vitest.

## File structure

**Create:**

`apps/api/src/observability/`: `request-context.ts` (ALS store), `logger.ts` (pino factory +
redaction), `log-redaction.ts` (serializers + the denylist), `metrics-registry.ts`,
`metrics.controller.ts`, `observability.module.ts`, `instrumentation.ts` (OTel SDK bootstrap),
plus co-located `*.test.ts` for each.
`apps/worker/src/observability/`: `job-context.ts`, `logger.ts`, `instrumentation.ts`,
`job-metrics.ts`.
`apps/scheduler/src/observability/instrumentation.ts`.
`database/migrations/036_outbox_trace_id.sql`.
`apps/api/test/integration/log-redaction.test.ts` (**the `BR-SEC-003` evidence**).
`apps/api/test/integration/observability-metrics.test.ts`.
`apps/api/test/integration/trace-propagation.test.ts`.
`deploy/observability/dashboard.json`, `deploy/observability/prometheus.yml`.
`docs/architecture/observability.md`.

**Modify:** `apps/api/src/main.ts`, `apps/worker/src/main.ts`, `apps/scheduler/src/main.ts`,
`apps/api/src/common/http-exception.filter.ts`, `apps/api/src/common/trace-id.ts`,
`apps/api/src/app.module.ts`, `apps/api/src/config/env.ts`, `apps/api/src/outbox/outbox-writer.ts`,
`apps/worker/src/outbox-relay.ts` *(read-only for `trace_id` — see the warning in CP4)*,
`apps/worker/src/campaign-send/run.ts`, `apps/worker/src/campaign-dispatcher.ts`,
`apps/worker/src/bulk-processor.ts`, `apps/worker/src/import-processor.ts`,
`apps/worker/src/progress-reconcile.ts`, `apps/api/src/common/idempotency.service.ts`,
`apps/api/src/notifications/notifications.service.ts`, `apps/worker/src/notification-writer.ts`,
`apps/api/src/webhooks/webhooks.service.ts`, `contracts/openapi.yaml`, `compose.yaml`,
`.env.deploy.example`, `docs/deployment/environment-variables.md`,
`docs/operations/runbook.md`, `database/migrations.lock.json`,
`.agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S3-observability.md`.

**Must NOT touch:** `apps/web/**` (protocol §1.1), `contracts/asyncapi.yaml`, `catalog/**`,
`state.json`, `traceability.csv`, `screen-catalog.yaml`, `EXECPLAN.md`,
`apps/worker/src/campaign-send/send.ts` (M7-S1's), `apps/api/src/health/**` (M7-S4's),
`.github/workflows/ci.yml` / `Dockerfile` / `deploy/nginx/` (M7-S4's),
`apps/api/src/common/permissions.ts` (M7-S2's),
`docs/operations/security-baseline.md` (M7-S2's),
`packages/architecture-tests/src/asyncapi-conformance.test.ts` (M7-S1's),
`docs/adr/adr-017-observability.md` (Accepted — implement it, do not edit it).

---

## Checkpoint 0 — Baseline

- [ ] **Step 1: Worktree and bootstrap**

```bash
git fetch origin && git checkout main && git pull --ff-only origin main
git worktree add -b m7-s3-observability ../eow-m7-s3 main
```

In `../eow-m7-s3`: `pnpm install --frozen-lockfile`, copy `.env` from the root clone,
`pnpm infra:up`.

- [ ] **Step 2: Record the real baseline**

```bash
pnpm --filter @eow/api build
pnpm check
```

Record the per-package file and test counts **as printed**. That is your baseline.

- [ ] **Step 3: Capture the "before" evidence for `TC-SEND-013`**

`BR-SEND-013`'s acceptance includes *"tìm log theo campaign_id"*. Prove it is currently
impossible, so the "after" is a measured delta:

```bash
grep -rn "campaign_id" apps/api/src apps/worker/src --include=*.ts | grep -v "\.test\.ts" | grep -iE "console\.|logger\." 
```

Expected: **one** hit — `apps/worker/src/progress-reconcile.ts:173`, via
`progressReconcileDriftMetric`. Record the exact output in the inbox.

- [ ] **Step 4: Open the inbox and commit**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S3-observability.md
git commit -m "M7-S3 CP0: baseline recorded

pnpm check exit 0. Counts: apps/api <F>/<T>, apps/worker <F>/<T>,
apps/web <F>/<T>, packages/architecture-tests <F>/<T>, 0 skipped.

BR-SEND-013 'tim log theo campaign_id' before-state: exactly one log
line in the whole backend carries campaign_id
(progress-reconcile.ts:173). Four console call sites and one Nest Logger
instance in total; LOG_LEVEL declared in env.ts:16 and read by nothing."
```

---

## Checkpoint 1 — Dependency review (AGENTS.md §5), then install

AGENTS.md §5: *"Never add a dependency without license, security, maintenance and bundle/runtime
impact review."* This is a real step. `ADR-017` having accepted the *technology* does not waive the
review of the *packages*.

- [ ] **Step 1: Review each package and write the findings into the inbox**

For `pino`, `pino-http` (if you use it), `@opentelemetry/sdk-node`,
`@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-prometheus`,
`@opentelemetry/api`, record: licence, latest version, last publish date, weekly downloads,
`pnpm audit` result, and whether it is a runtime dependency of a **server** app only (none of these
may enter `apps/web`'s bundle — check `apps/web/package.json` is untouched).

Also check `packages/library-decisions.json` — `catalog/library-decisions.json` exists in this repo
and may already record a decision about logging or telemetry libraries. If it names a different
choice than `ADR-017`, **stop and record the conflict in the inbox**; do not silently pick one.

- [ ] **Step 2: Record `DEC-156`**

```
DEC-156 | pino + @opentelemetry/{api,sdk-node,auto-instrumentations-node,exporter-prometheus}
are added as runtime dependencies of apps/api, apps/worker and apps/scheduler only.
| ADR-017 (Accepted) already names "Pino structured logs + OpenTelemetry traces/metrics" as
the decision; this node implements it rather than re-deciding it. prom-client was rejected
despite being lighter: it would satisfy the metric half while leaving the trace half needing
OTel anyway, so the repo would carry two telemetry stacks. Licences, audit and maintenance
reviewed per AGENTS.md §5 — see the table above. No package enters apps/web.
| Alternative rejected: keeping progress-metrics.ts's log-payload-as-metric pattern for all
eleven metrics. It cannot satisfy BR-SEND-013's "co dashboard queue lag, throughput, error
rate, webhook lag" — a dashboard needs a scrape target, and a log line is not one.
```

- [ ] **Step 3: Install**

```bash
pnpm --filter @eow/api add pino @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-prometheus
pnpm --filter @eow/worker add pino @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
pnpm --filter @eow/scheduler add pino @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
pnpm install
```

- [ ] **Step 4: Verify nothing broke and commit**

```bash
pnpm typecheck && pnpm build
pnpm --filter @eow/architecture-tests test
```

Expected: exit 0. `pnpm-lock.yaml` is committed; `node_modules/` is not.

```bash
git add package.json pnpm-lock.yaml apps/api/package.json apps/worker/package.json apps/scheduler/package.json \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S3-observability.md
git commit -m "M7-S3 CP1: pino + OpenTelemetry dependency review and install

DEC-156. ADR-017 (Accepted) already decided 'Pino structured logs +
OpenTelemetry traces/metrics'; this implements it. prom-client rejected:
lighter, but it covers only the metric half and the trace half needs OTel
anyway, so the repo would carry two telemetry stacks.

Licence/security/maintenance/bundle review per AGENTS.md §5 recorded in
the inbox. Server apps only -- apps/web/package.json untouched.

pnpm typecheck + build clean; architecture-tests green."
```

---

## Checkpoint 2 — Ambient request context and the pino logger

**Files:** `apps/api/src/observability/request-context.ts` (+ test), `apps/api/src/observability/logger.ts` (+ test),
`apps/api/src/observability/observability.module.ts`; modify `apps/api/src/main.ts`,
`apps/api/src/common/trace-id.ts`, `apps/api/src/common/http-exception.filter.ts`,
`apps/api/src/app.module.ts`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/observability/request-context.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getRequestContext, runWithRequestContext } from './request-context.js';

describe('BR-SEND-013: ambient request context', () => {
  it('is undefined outside any run', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('is visible to a callee that was never passed it', async () => {
    // This is the whole point: trace-id.ts memoizes onto the Express request
    // object and propagates by explicit argument, so a logger three layers
    // down cannot reach it. AsyncLocalStorage can.
    const deep = async () => getRequestContext()?.traceId;
    const seen = await runWithRequestContext({ traceId: 't-1', tenantId: 'tenant-1' }, deep);
    expect(seen).toBe('t-1');
  });

  it('survives an await boundary and does not leak between concurrent runs', async () => {
    const observe = async (delay: number) => {
      await new Promise((r) => setTimeout(r, delay));
      return getRequestContext()?.traceId;
    };
    const [a, b] = await Promise.all([
      runWithRequestContext({ traceId: 'a', tenantId: 't' }, () => observe(20)),
      runWithRequestContext({ traceId: 'b', tenantId: 't' }, () => observe(5)),
    ]);
    expect(a).toBe('a');
    expect(b).toBe('b');
  });
});
```

`apps/api/src/observability/logger.test.ts` — assert the mixin, by writing to a capture stream:

```ts
  it('BR-SEND-013: every line carries tenant_id and trace_id from the ambient context', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', destination: captureStream(lines) });
    await runWithRequestContext({ traceId: 'trace-9', tenantId: 'tenant-9' }, async () => {
      logger.info({ event: 'probe' }, 'hello');
    });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.trace_id).toBe('trace-9');
    expect(parsed.tenant_id).toBe('tenant-9');
    expect(parsed.event).toBe('probe');
  });

  it('BR-SEND-013: a line written with no ambient context still emits, with null ids', () => {
    // Boot-time and shutdown-time lines have no request. They must not throw
    // and must not silently vanish -- an observability layer that drops the
    // lines written when something is going wrong is worse than none.
    const lines: string[] = [];
    createLogger({ level: 'info', destination: captureStream(lines) }).info({ event: 'boot' }, 'up');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.trace_id).toBeNull();
    expect(parsed.tenant_id).toBeNull();
  });

  it('honours LOG_LEVEL', () => {
    const lines: string[] = [];
    createLogger({ level: 'warn', destination: captureStream(lines) }).info({}, 'suppressed');
    expect(lines).toHaveLength(0);
  });
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @eow/api test -- src/observability/
```

Expected: FAIL on unresolved imports.

- [ ] **Step 3: Implement**

`request-context.ts` — an `AsyncLocalStorage<RequestContext>` with
`RequestContext = { traceId: string; tenantId: string | null; actorId?: string | null; module?: string }`,
plus `runWithRequestContext(ctx, fn)` and `getRequestContext()`.

`logger.ts` — a `createLogger({level, destination?})` factory returning a `pino` instance with:

- `messageKey: 'msg'`, `timestamp: pino.stdTimeFunctions.isoTime`;
- a `mixin()` returning
  `{ trace_id: ctx?.traceId ?? null, tenant_id: ctx?.tenantId ?? null, actor_id: ctx?.actorId ?? null, module: ctx?.module ?? null }`;
- `base: { service: process.env.RUNTIME_PROFILE ?? 'api' }`;
- the `redact` configuration from CP3 (add it there; leave a marked placeholder call to
  `redactionOptions()` here so CP3 is a one-line change, not a rewrite).

Wire it in `apps/api/src/main.ts`:

- Create the logger and pass it to Nest (`NestFactory.create(AppModule, { rawBody: true, logger: ... })`
  or via a `LoggerService` adapter — either is fine, but the four existing `console.*` call sites
  must end up on it).
- Add a middleware, registered before the global prefix takes effect, that calls
  `getOrCreateTraceId(request)` and then `runWithRequestContext({traceId, tenantId: null}, next)`.
  The tenant is not known until `AuthGuard` runs, so:
- In `AuthGuard` (or wherever `request.auth` is first set), **mutate the already-running context**
  to fill `tenantId`/`actorId`. Do not start a second context — that would give the pre-auth and
  post-auth halves of one request different trace ids.

**`trace-id.ts` keeps its memoization.** `EXECPLAN` D-26 requires the Problem response's `traceId`
and the `audit_log` row's to match, and `trace-id.test.ts`'s three tests assert it. Your middleware
*feeds* the context from `getOrCreateTraceId`; it does not replace it. Run
`pnpm --filter @eow/api test -- src/common/trace-id.test.ts` and confirm all three still pass with
their count unchanged.

Replace `http-exception.filter.ts:29`'s `console.error('[unhandled-error] traceId=...', error)`
with a structured `logger.error({ err: error }, 'unhandled-error')`. The `traceId` now arrives via
the mixin. **Do not change what the filter returns to the client** — `mapErrorToProblem`'s
generic-500 collapse is `BR-SEC-003` behaviour that `M7-S2` is asserting in parallel.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @eow/api test -- src/observability/ src/common/trace-id.test.ts
pnpm --filter @eow/api test -- test/integration/auth-http.test.ts test/integration/audit-log-immutability.test.ts
```

Expected: PASS; existing counts unchanged. `auth-http.test.ts:149` asserts traceId propagation into
the Problem body **and** the audit row — that test is your regression guard for D-26.

```bash
git add apps/api/src/observability/ apps/api/src/main.ts apps/api/src/common/ apps/api/src/app.module.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S3-observability.md
git commit -m "M7-S3 CP2: AsyncLocalStorage request context and pino logger

trace-id.ts memoizes onto the Express request object and propagates by
explicit argument -- a logger three layers down cannot reach it. ALS can,
so every line gets tenant_id/trace_id without the call site knowing.

The context is created once per request from getOrCreateTraceId and then
MUTATED when AuthGuard resolves the tenant, not restarted -- a second
context would give the pre-auth and post-auth halves of one request
different trace ids.

trace-id.ts's memoization is untouched: EXECPLAN D-26 requires the
Problem response's traceId and the audit_log row to match, and
auth-http.test.ts:149 still proves it (count unchanged).

A line with no ambient context emits with null ids rather than throwing
or vanishing: boot and shutdown lines are exactly the ones you need when
something is going wrong.

LOG_LEVEL (env.ts:16) is now actually read. <N>/<N> tests."
```

---

## Checkpoint 3 — Redaction, and the test that proves it (`BR-SEC-003`)

**Files:** `apps/api/src/observability/log-redaction.ts` (+ test),
`apps/api/test/integration/log-redaction.test.ts`; modify `apps/api/src/observability/logger.ts`

This is the single highest-value checkpoint in the node. `traceability-plan.yaml:295`:

> No log, metric or audit field may contain an unmasked recipient custom value, email body, session
> token or SMTP credential.

and `docs/operations/security-baseline.md`: *"Never log tokens, recipient custom values or email
bodies."*

- [ ] **Step 1: Write the failing unit test**

`apps/api/src/observability/log-redaction.test.ts`:

```ts
  it('BR-SEC-003: redacts secrets by key at any depth', () => {
    const line = serialize({
      secret: 'plaintext', password: 'p', smtp: { secret: 'x', username: 'u' },
      headers: { cookie: 'eow_session=abc', 'x-csrf-token': 't' },
      config: { secretRef: 'EOW_SENDER_SECRET_AB12' },
    });
    expect(line).not.toContain('plaintext');
    expect(line).not.toContain('eow_session=abc');
    expect(line).toContain('[REDACTED]');
    // A secret REFERENCE is not a secret and is the only handle an operator
    // has for correlating -- it stays, masked, exactly as
    // secret-store.ts's maskSecretReference already does in API responses.
    expect(line).toMatch(/EO••••12|EOW_SENDER_SECRET/);
  });

  it('BR-SEC-003: drops an email body and keeps only its size and hash', () => {
    const line = serialize({ html: '<p>Dear Alice, your invoice</p>', text: 'Dear Alice', subject: 'Invoice' });
    expect(line).not.toContain('Dear Alice');
    expect(line).not.toContain('Invoice');   // a subject is recipient-derived
    expect(line).toMatch(/"html_bytes":\d+/);
  });

  it('BR-SEC-003: drops recipient custom values but keeps the field NAMES', () => {
    // Field names are schema, not PII, and losing them makes a log useless
    // for debugging a merge failure -- which is exactly what BR-SEND-013
    // exists for. Values go; keys stay.
    const line = serialize({ customData: { plan: 'enterprise', ssn: '123-45-6789' } });
    expect(line).not.toContain('enterprise');
    expect(line).not.toContain('123-45-6789');
    expect(line).toContain('plan');
    expect(line).toContain('ssn');
  });

  it('BR-SEC-003: keeps every identifier the rule depends on', () => {
    const line = serialize({ campaignId: 'c1', tenantId: 't1', executionId: 'e1', recipientId: 'r1', jobId: 'j1' });
    for (const id of ['c1', 't1', 'e1', 'r1', 'j1']) expect(line).toContain(id);
  });

  it('BR-SEC-003: an unknown key holding a value that LOOKS like an address is still redacted', () => {
    // Key-based redaction alone fails open on a key nobody anticipated. A
    // value-shape pass over string leaves is what makes the guarantee hold
    // for code written after this node.
    const line = serialize({ someFutureField: 'alice@example.test' });
    expect(line).not.toContain('alice@example.test');
  });
```

- [ ] **Step 2: Write the failing integration test — the real evidence**

`apps/api/test/integration/log-redaction.test.ts`. A unit test over a serializer is not proof that
the running application never logs a secret. Capture the **real** logger's output while driving the
app through the paths most likely to leak:

```ts
  it('TC-SEC-003 / BR-SEC-003: no captured log line contains a planted secret, token, custom value or body', async () => {
    // Every planted value is unique per run so a match cannot be incidental.
    const planted = {
      smtpSecret: `PLANT-SMTP-${randomUUID()}`,
      customValue: `PLANT-CUSTOM-${randomUUID()}`,
      emailBody: `PLANT-BODY-${randomUUID()}`,
      subject: `PLANT-SUBJECT-${randomUUID()}`,
    };

    await createSenderConfigWithSecret(planted.smtpSecret);
    await createRecipientWithCustomValue(planted.customValue);
    await createAndSendTemplateContaining(planted.emailBody, planted.subject);
    await provokeUnhandledErrorOnSomeRoute();       // exercises http-exception.filter
    await loginAndRefreshAndLogout();               // exercises session cookies

    const captured = capturedLines.join('\n');
    for (const [name, value] of Object.entries(planted)) {
      expect(captured, `${name} leaked into a log line`).not.toContain(value);
    }
    // The session cookie value itself, taken from the live response.
    expect(captured).not.toContain(sessionCookieValue);

    // And prove the capture is actually working -- a redaction test that
    // captured nothing would pass vacuously, which is the exact failure mode
    // this whole checkpoint exists to prevent.
    expect(capturedLines.length).toBeGreaterThan(10);
    expect(captured).toContain('"trace_id"');
  }, 60_000);

  it('BR-SEC-003: the capture harness detects a deliberate leak', async () => {
    // Negative control. Without this, a broken capture makes the test above
    // green forever.
    const canary = `CANARY-${randomUUID()}`;
    rawLogger.info({ deliberatelyUnredactedKey: canary }, 'canary');
    expect(capturedLines.join('\n')).toContain(canary);
  }, 30_000);
```

The second test is not optional. Protocol §7.4 singles this suite out: *"A test that greps captured
log output for secrets is exactly the kind that passes vacuously if the capture wired up wrong."*

- [ ] **Step 3: Run and confirm failure**

```bash
pnpm --filter @eow/api test -- src/observability/log-redaction.test.ts test/integration/log-redaction.test.ts
```

- [ ] **Step 4: Implement**

`log-redaction.ts` exports `redactionOptions()` returning pino `redact` paths plus a
`serializers` map, combining three mechanisms — none is sufficient alone:

1. **Key denylist** (pino `redact.paths` with wildcards): `secret`, `password`, `passwordHash`,
   `token`, `refreshToken`, `sessionSecret`, `cookie`, `set-cookie`, `authorization`,
   `x-csrf-token`, `smtp.secret`, and their nested forms (`*.secret`, `req.headers.cookie`, …).
2. **Shape transforms** for known payloads: `html`/`text`/`body` → `{ html_bytes, html_sha256 }`;
   `subject` → dropped; `customData`/`customValues`/`mergeData` → keys kept, values replaced.
3. **A value-shape pass over string leaves**: anything matching an email address, a long
   base64/hex run (≥32 chars), or the `EOW_SENDER_SECRET_*` pattern is replaced. This is what makes
   the guarantee survive code written after this node — a key denylist fails open on a key nobody
   anticipated.

Cap the pass's depth and leaf count so a large object cannot make it quadratic, and unit-test that
cap.

Wire `redactionOptions()` into `createLogger` (the one-line change CP2 left a marker for).

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @eow/api test -- src/observability/ test/integration/log-redaction.test.ts
```

```bash
git add apps/api/src/observability/ apps/api/test/integration/log-redaction.test.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S3-observability.md
git commit -m "M7-S3 CP3: log redaction and the test that proves it (BR-SEC-003 half)

Three mechanisms, because none is sufficient alone: a key denylist, shape
transforms for known payloads (body -> bytes+sha256, subject dropped,
custom values replaced but their KEYS kept -- names are schema, not PII,
and losing them makes a merge-failure log useless), and a value-shape
pass over string leaves so the guarantee survives keys written after this
node.

The integration test plants four unique values, drives the app through
sender-config creation, a real send, an unhandled error and the full
session lifecycle, then greps the captured output. It carries a NEGATIVE
CONTROL asserting the harness detects a deliberate canary -- without it a
broken capture makes this test green forever, which is the exact failure
mode it exists to prevent.

BR-SEC-003 is proposed partially_closed, not closed: M7-S2 owns the
response/error-payload, export-expiry, injection and stored-XSS halves.

<N>/<N> tests."
```

---

## Checkpoint 4 — Correlation across processes: migration 036, worker and scheduler logging

**Files:** `database/migrations/036_outbox_trace_id.sql`, `apps/worker/src/observability/*`,
`apps/scheduler/src/observability/instrumentation.ts`,
`apps/api/test/integration/trace-propagation.test.ts`; modify `apps/api/src/outbox/outbox-writer.ts`,
`apps/worker/src/main.ts`, `apps/scheduler/src/main.ts`, `apps/worker/src/campaign-dispatcher.ts`,
`apps/worker/src/progress-reconcile.ts`, `database/migrations.lock.json`

- [ ] **Step 1: Write the failing test**

`apps/api/test/integration/trace-propagation.test.ts`:

```ts
  it('BR-SEND-013: an outbox event carries the trace_id of the request that wrote it', async () => {
    const traceId = randomUUID();
    await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send`)
      .set('Cookie', cookie).set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', randomUUID())
      .set('x-trace-id', traceId)     // trace-id.ts honours an inbound header
      .expect(202);

    const events = await dataSource.query(
      `SELECT trace_id FROM outbox_event WHERE tenant_id = $1 AND aggregate_id = $2`, [tenant.id, campaignId]);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].trace_id).toBe(traceId);
  }, 30_000);

  it('BR-SEND-013: the audit row written by the same request carries the same trace_id', async () => {
    // EXECPLAN D-26's guarantee, now extended across the outbox hop: one
    // request produces one id that appears in the Problem/response path, the
    // audit row and the outbox row alike.
    const audit = await dataSource.query(
      `SELECT trace_id FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.id, campaignId]);
    expect(audit[0].trace_id).toBe(traceId);
  }, 30_000);
```

And in `apps/worker`, a test that a job's log lines carry the propagated id:

```ts
  it('BR-SEND-013: a worker job logs under the trace_id it inherited, not a synthetic one', async () => {
    // campaign-dispatcher.ts:47 currently passes `dispatcher:${campaignId}`
    // and progress-reconcile.ts:147 passes `progress-reconcile:${executionId}`.
    // Those are placeholders, not correlation: you cannot follow a request
    // from the API into the job it caused.
    const lines = await runJobAndCaptureLogs();
    for (const line of lines) {
      expect(line.trace_id).toBe(inheritedTraceId);
      expect(line.trace_id).not.toMatch(/^dispatcher:/);
    }
  }, 30_000);
```

- [ ] **Step 2: Run, confirm failure, implement**

Migration `036_outbox_trace_id.sql` — plain SQL, no meta-commands, no transaction control:

```sql
-- 036_outbox_trace_id.sql
-- BR-SEND-013 / ADR-017: "correlation IDs propagate through outbox and jobs."
-- outbox_event (001_initial.sql:84-90) has no correlation column, so the
-- API -> outbox -> job hop has no id to carry. Nullable with no default: the
-- running api/worker containers execute older code against this same schema
-- while it rolls out (PARALLEL-EXECUTION-PROTOCOL-M7 §5), and an event written
-- by that older code legitimately has no trace id.
ALTER TABLE outbox_event ADD COLUMN IF NOT EXISTS trace_id text;

CREATE INDEX IF NOT EXISTS idx_outbox_event_trace ON outbox_event (trace_id) WHERE trace_id IS NOT NULL;
```

> Before writing this, check whether `M7-S2-security-hardening`'s migration `035` also alters
> `outbox_event` (it adds `dead_lettered_at` and `last_error`). Both are `ADD COLUMN IF NOT EXISTS`
> on the same table in different migrations, which is fine and merges cleanly — but if
> `relay_pending_outbox_events()` needs replacing, **that is M7-S2's change, not yours**
> (protocol §3.6: `apps/worker/src/outbox-relay.ts` is M7-S2's file). If you need the relay to read
> `trace_id`, write the reader in your own `apps/worker/src/observability/job-context.ts` and record
> in the inbox that one line in `outbox-relay.ts` must call it — **let the reviewing session apply
> that line during the merge.** Do not edit M7-S2's file.

Then:

- `apps/api/src/outbox/outbox-writer.ts`: `appendOutboxEvent` reads `getRequestContext()?.traceId`
  and writes it. Its signature gains an optional `traceId` for callers outside a request context.
  **Its `.orIgnore()` behaviour must not change** — that is the outbox's idempotency.
- `apps/worker/src/observability/job-context.ts`: `runWithJobContext({traceId, tenantId, jobName, jobId}, fn)`,
  the worker's ALS store, mirroring the API's.
- `apps/worker/src/main.ts`: wrap each `Worker`'s handler body in `runWithJobContext(...)`, seeding
  `traceId` from the job payload (falling back to a fresh `randomUUID()` when absent, so a job
  enqueued by older code still gets *an* id). **Touch line 1 (the instrumentation import) and the
  handler wrapping only — the `{connection, concurrency}` option objects belong to `M7-S4`**
  (protocol §3.6). Do not reformat the file.
- `apps/worker/src/campaign-dispatcher.ts:47` and `apps/worker/src/progress-reconcile.ts:147`:
  replace the synthetic `` `dispatcher:${campaignId}` `` / `` `progress-reconcile:${executionId}` ``
  trace ids with the propagated one from the job context, keeping the old value as a separate field
  (e.g. `scan: 'dispatcher'`) so nothing that looked for it loses information.
- `apps/scheduler/src/main.ts`: instrumentation import on line 1, and put the trace id into the job
  payload it enqueues, so the chain starts at the scheduler for scheduled work.

Apply the migration, `sha256sum`, append to `database/migrations.lock.json`, run
`ARCH-MIGRATION`.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @eow/api test -- test/integration/trace-propagation.test.ts
pnpm --filter @eow/worker test
pnpm --filter @eow/architecture-tests test -- src/migration-immutability.test.ts src/job-wiring.test.ts
```

Expected: PASS; worker count unchanged except your additions. `ARCH-JOB-WIRING` must stay green —
it asserts the worker's handled job-name set equals the scheduler's enqueued set, and wrapping
handlers is exactly the kind of edit that can break its scanner.

```bash
git add database/migrations/036_outbox_trace_id.sql database/migrations.lock.json \
        apps/worker/src/ apps/scheduler/src/ apps/api/src/outbox/ apps/api/test/integration/trace-propagation.test.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S3-observability.md
git commit -m "M7-S3 CP4: correlation across processes (migration 036)

ADR-017: 'correlation IDs propagate through outbox and jobs.' outbox_event
had no correlation column, so the API -> outbox -> job hop had nothing to
carry. 036 adds trace_id, nullable with no default because the running
containers execute older code against the same schema during rollout.

campaign-dispatcher.ts:47 and progress-reconcile.ts:147 were passing
synthetic ids ('dispatcher:<id>', 'progress-reconcile:<id>') -- those are
placeholders, not correlation. Replaced with the propagated id; the old
value is kept as a separate 'scan' field so nothing loses information.

outbox-relay.ts NOT edited (M7-S2 owns it this batch); the one line that
must read trace_id is handed to the reviewing session via the inbox.

ARCH-JOB-WIRING still green after wrapping the handlers."
```

---

## Checkpoint 5 — OpenTelemetry traces across the five hops

**Files:** `apps/api/src/observability/instrumentation.ts`,
`apps/worker/src/observability/instrumentation.ts`,
`apps/scheduler/src/observability/instrumentation.ts`; modify each `main.ts`,
`apps/api/src/outbox/outbox-writer.ts`, `apps/worker/src/campaign-send/run.ts`,
`apps/api/src/webhooks/webhooks.service.ts`

Success condition: *"OpenTelemetry traces span API → outbox → job → provider → webhook."*

- [ ] **Step 1: Write the failing test**

Use the OTel SDK's in-memory span exporter so the assertion is over real spans, not logs:

```ts
  it('BR-SEND-013: one campaign send produces a connected span chain across all five hops', async () => {
    const spans = memoryExporter.getFinishedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining([
      'POST /api/v1/campaigns/:campaignId/send', 'outbox.append', 'job.campaign-send-scan',
      'provider.send', 'webhook.receive',
    ]));
    // Connected, not merely present: a set of five orphan spans is not a trace.
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  }, 60_000);
```

- [ ] **Step 2: Implement**

`instrumentation.ts` in each app: an `NodeSDK` with `getNodeAutoInstrumentations()` (HTTP,
`pg`, `ioredis` come free), a resource naming the service (`api`/`worker`/`scheduler` from
`RUNTIME_PROFILE`), and `sdk.start()` executed **at import time**. Import it as the **first line**
of each `main.ts`, above `import 'reflect-metadata';` — auto-instrumentation must patch modules
before anything requires them.

Explicit spans at the four hops auto-instrumentation cannot infer:

- `outbox.append` — in `appendOutboxEvent`, with the trace id injected into the row (CP4 already
  writes `trace_id`; also write the W3C `traceparent` if you want true parent-child linkage across
  the process boundary — note that in the inbox as a decision either way).
- `job.<jobName>` — in the worker's handler wrapper from CP4, as the span the job context carries.
- `provider.send` — around the SMTP call in the send path. **`send.ts` is M7-S1's file**
  (protocol §3.6), so put the span in `run.ts` around the `sendClaimedBatch(...)` call at
  `run.ts:79` and name it `provider.send_batch`. Record in the inbox that a per-message span needs
  a one-line change inside `send.ts` after both branches merge.
- `webhook.receive` — in `apps/api/src/webhooks/webhooks.service.ts`, around the signature
  verification and the `delivery_event` insert.

`OTEL_EXPORTER_OTLP_ENDPOINT` unset must mean **traces are collected in-process and dropped, and
the app boots normally**. A deployment with no collector must not crash — that is the default
deployment today. Assert that with a test.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @eow/api test -- test/integration/
pnpm --filter @eow/worker test
pnpm --filter @eow/api build && pnpm --filter @eow/worker build && pnpm --filter @eow/scheduler build
```

`apps/api/test/integration/boot.test.ts` spawns the real compiled process — it is the test most
likely to catch an instrumentation bootstrap that hangs or crashes. Confirm it passes.

```bash
git commit -m "M7-S3 CP5: OpenTelemetry spans across API -> outbox -> job -> provider -> webhook

The SDK starts at import time on line 1 of each main.ts, above
'reflect-metadata', because auto-instrumentation must patch modules before
anything requires them.

Four explicit spans for the hops auto-instrumentation cannot infer. The
provider span sits in run.ts around sendClaimedBatch, not inside send.ts:
send.ts belongs to M7-S1 this batch. A per-message span is a one-line
follow-up after both branches merge -- recorded in the inbox.

OTEL_EXPORTER_OTLP_ENDPOINT unset means collect-and-drop, and the app
boots normally -- that is the default deployment today, and an
observability layer that crashes a stack with no collector is worse than
none. Asserted by its own test; boot.test.ts (real spawned process) green."
```

---

## Checkpoint 6 — Metrics registry and the `/metrics` endpoint

**Files:** `apps/api/src/observability/metrics-registry.ts` (+ test),
`apps/api/src/observability/metrics.controller.ts`,
`apps/api/test/integration/observability-metrics.test.ts`; modify `apps/api/src/config/env.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('BR-SEND-013: GET /api/v1/metrics returns a Prometheus exposition', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/metrics').expect(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toMatch(/^# HELP /m);
    expect(response.text).toMatch(/^# TYPE /m);
  }, 30_000);

  it('BR-SEC-003: the exposition carries no recipient address, no campaign name and no secret', async () => {
    // A metrics endpoint is a log line with a longer memory. Label
    // cardinality is also a real hazard: a recipient-id label would make
    // the series unbounded AND leak.
    const response = await request(app.getHttpServer()).get('/api/v1/metrics').expect(200);
    expect(response.text).not.toMatch(/@/);
    expect(response.text).not.toContain(plantedCampaignName);
    expect(response.text).not.toContain(plantedSecret);
  }, 30_000);

  it('is reachable without a session but not from outside the deployment network', async () => {
    // The route is @Public() because a scraper has no session. It is NOT
    // exposed publicly: deploy/nginx/default.conf proxies only /api/ and
    // /socket.io/, so /api/v1/metrics IS reachable through the edge --
    // record that and see the decision below.
  });
```

- [ ] **Step 2: Decide and record the exposure question as `DEC-157`**

This needs a real decision, not a default. `/api/v1/metrics` under the global prefix is proxied by
`deploy/nginx/default.conf`'s `location /api/`, which would make the exposition reachable from
outside. Options:

- Serve it on a **separate port** bound to the internal network only (a second Node listener in the
  api process, `METRICS_PORT`, not published in `compose.yaml`). Prometheus scrapes
  `api:9464/metrics` inside the `backend` network.
- Or keep it on `/api/v1/metrics` and require `SETTINGS_MANAGE`.

**Prefer the separate port**: a scraper cannot hold a session, so the second option forces either a
`@Public()` public endpoint or a service account, and `deploy/nginx/default.conf` is `M7-S4`'s file
so you cannot add an nginx deny rule. Record the choice, the rejected alternative and the reason.

If you take the separate port, `/metrics` still belongs in `contracts/openapi.yaml` **only if** it
is served under `/api/v1` — if it is on its own port it is outside the documented API surface, so
say so in the inbox and **do not** add the path. Adjust CP10 accordingly.

- [ ] **Step 3: Implement**

`metrics-registry.ts`: a module-level OTel `MeterProvider` with a `PrometheusExporter`, plus typed
helpers so a call site never touches the SDK directly:

```ts
export const metrics = {
  idempotentReplay: (resource: string) => counter('eow_idempotent_replay_total').add(1, { resource }),
  bulkRows: (result: 'succeeded' | 'failed' | 'skipped', n: number) => counter('eow_bulk_rows_total').add(n, { result }),
  scheduleMisfire: (outcome: 'missed' | 'blocked' | 'dispatched') => counter('eow_schedule_misfire_total').add(1, { outcome }),
  sendAttempt: (result: 'submitted' | 'retrying' | 'failed', n: number) => counter('eow_send_attempt_total').add(n, { result }),
  sendRetry: (n: number) => counter('eow_send_retry_total').add(n),
  providerReject: (n: number) => counter('eow_provider_reject_total').add(n),
  progressReconcileDrift: (drift: number) => gauge('eow_progress_reconcile_drift').record(drift),
  notificationCreated: () => counter('eow_notification_created_total').add(1),
  notificationDelivered: (channel: 'socket' | 'stored') => counter('eow_notification_delivered_total').add(1, { channel }),
  notificationRead: (n = 1) => counter('eow_notification_read_total').add(n),
  queueLagSeconds: (queue: string, seconds: number) => gauge('eow_queue_lag_seconds').record(seconds, { queue }),
  webhookLagSeconds: (provider: string, seconds: number) => histogram('eow_webhook_lag_seconds').record(seconds, { provider }),
  deadLetterDepth: (source: string, depth: number) => gauge('eow_dead_letter_depth').record(depth, { source }),
};
```

> **Label cardinality is a correctness constraint, not a style preference.** No label may carry a
> tenant id, campaign id, recipient id, execution id or job id — those are unbounded and would both
> explode the series count and leak identifiers into a store with a long memory. Identifiers belong
> in **logs and traces**, which are already correlated by `trace_id` and (from CP8) `campaign_id`.
> Write that constraint as a comment at the top of the file and assert it with a unit test that
> fails if any helper accepts a raw id as a label.

> `eow_quota_usage_ratio` is **absent by design** — `M7-S1` owns it (Scope). Leave a comment saying
> where it will be added, so the post-merge follow-up is obvious.

> `eow_dead_letter_depth` is **`M7-S2`'s metric**, emitted from its own module. Declaring the helper
> here is harmless and makes the merge a one-line change; check M7-S2's inbox for the name it
> actually used and match it, or leave it out and record why.

`metrics.controller.ts` (or the separate-port listener, per `DEC-157`). If it is a controller, it
needs `@Public()` — `ARCH-RBAC` fails any route with neither `@Public()` nor
`@RequirePermission()`.

Append `METRICS_PORT` (and `OTEL_EXPORTER_OTLP_ENDPOINT` if used) to `apps/api/src/config/env.ts`,
**inside** the `z.object`, above its closing `});`, with the rule-id doc comment style the file
uses. Do not reorder existing keys.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @eow/api test -- src/observability/ test/integration/observability-metrics.test.ts
pnpm --filter @eow/architecture-tests test -- src/rbac-coverage.test.ts
```

```bash
git commit -m "M7-S3 CP6: OTel metrics registry and a real scrape target

DEC-157: <the exposure decision, its rejected alternative and why>.

Label cardinality is enforced as a correctness constraint, not a
convention: no helper accepts a tenant/campaign/recipient/execution/job
id as a label, and a unit test fails if one does. Unbounded labels would
both explode the series count and leak identifiers into a store with a
much longer memory than a log. Identifiers stay in logs and traces, where
trace_id and campaign_id already correlate them.

eow_quota_usage_ratio is deliberately absent -- M7-S1 owns it, and its
ledger does not exist until that branch lands."
```

---

## Checkpoint 7 — Wire the metrics at their real event sites

**Files:** modify `apps/api/src/common/idempotency.service.ts`,
`apps/worker/src/bulk-processor.ts`, `apps/worker/src/import-processor.ts`,
`apps/worker/src/campaign-dispatcher.ts`, `apps/worker/src/campaign-send/run.ts`,
`apps/worker/src/progress-reconcile.ts`, `apps/api/src/notifications/notifications.service.ts`,
`apps/worker/src/notification-writer.ts`

- [ ] **Step 1: Write one failing test per metric family**

For each, drive the real code path and assert the counter moved. Example shape:

```ts
  it('BR-SEND-013: a replayed Idempotency-Key increments eow_idempotent_replay_total{resource}', async () => {
    const before = await readCounter('eow_idempotent_replay_total', { resource: 'campaign_snapshot' });
    const key = randomUUID();
    await sendCampaignWithKey(key);
    await sendCampaignWithKey(key);   // the replay
    expect(await readCounter('eow_idempotent_replay_total', { resource: 'campaign_snapshot' })).toBe(before + 1);
  }, 30_000);

  it('BR-SEND-013: a 409 key-reuse conflict does NOT increment the replay counter', async () => {
    // idempotency.service.ts's 409 branches (:64, :69, :92, :98) are a
    // different outcome from a replay. Counting them together would make the
    // metric mean "something happened with a key", which is not a signal.
    const before = await readCounter('eow_idempotent_replay_total', { resource: 'campaign_snapshot' });
    await sendCampaignWithKeyAndDifferentPayload(key).catch(() => undefined);
    expect(await readCounter('eow_idempotent_replay_total', { resource: 'campaign_snapshot' })).toBe(before);
  }, 30_000);
```

- [ ] **Step 2: Wire each site**

| Metric | Exact site |
|---|---|
| `eow_idempotent_replay_total{resource}` | `idempotency.service.ts` lines **67** and **95** (the two `replayed: true` returns). **Not** the 409 branches. |
| `eow_bulk_rows_total{result}` | `bulk-processor.ts` **:110** / **:114**, or once per job from `bulkCounters()` **:219-235** (cheaper; prefer it and say why). Import path: `import-processor.ts:285, 299`. |
| `eow_schedule_misfire_total{outcome}` | `campaign-dispatcher.ts` **:101** (`missed`), **:123** (`blocked`), **:144** (`dispatched`). |
| `eow_send_attempt_total{result}`, `eow_send_retry_total`, `eow_provider_reject_total` | **`run.ts`**, from the `SendBatchOutcome` returned at **:79**. Not `send.ts` — M7-S1's file. |
| `eow_progress_reconcile_drift` | `progress-reconcile.ts` **:171-173**. Keep `progressReconcileDriftMetric` as the log payload **and** record the gauge — the log line is what `EXECPLAN` D-40-era debugging relies on, and removing it would lose information. |
| `eow_notification_created_total` | `notifications.service.ts` **:105** (already emits `action:'created'`) **and** `notification-writer.ts` **:51-59** (currently emits nothing). |
| `eow_notification_delivered_total{channel}` | `notification-writer.ts` **:60-65** (the `user_notification` fan-out) and the realtime emit path. This finally makes the `'socket_delivered'`/`'channel_attempt'` actions `notification-metrics.ts:1` has declared since M6 real. |
| `eow_notification_read_total` | `notifications.service.ts` **:111**, **and `markAllRead()` at :113 which currently emits nothing** — record that gap as a `D-*`. |

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @eow/api test && pnpm --filter @eow/worker test
```

Expected: PASS, no existing count falls.

```bash
git commit -m "M7-S3 CP7: ten runtime_evidence metrics wired at their real event sites

Each is emitted where the event actually happens, not inferred from a
neighbouring one. Three deliberate distinctions:

- idempotency.service.ts's 409 key-reuse branches are NOT counted as
  replays; counting them together would make the metric mean 'something
  happened with a key', which is not a signal.
- notifications.service.ts's markAllRead() at :113 emitted nothing before
  this commit -- a real gap, recorded as D-<NNN>.
- notification-metrics.ts has declared 'socket_delivered' and
  'channel_attempt' actions since M6 that no code ever passed. They are
  now real.

Send metrics come from run.ts's SendBatchOutcome, not from inside
send.ts, which belongs to M7-S1 this batch. Consequence recorded as
D-<NNN>: send.ts:214 folds rate-limit deferrals into `retrying` alongside
real error retries, so eow_send_retry_total conflates two causes until a
send.ts change separates them.

progress-reconcile.ts keeps its log payload as well as the new gauge --
removing the line would lose information debugging already relies on."
```

---

## Checkpoint 8 — `BR-SEND-013`'s four dashboard dimensions

**Files:** modify `apps/worker/src/main.ts`, `apps/api/src/webhooks/webhooks.service.ts`,
and the send/campaign log call sites

The acceptance names four things the eleven `runtime_evidence` metrics do not cover: *"dashboard
queue lag, throughput, error rate, webhook lag; tìm log theo campaign_id."*

- [ ] **Step 1: Write the failing tests**

```ts
  it('BR-SEND-013: eow_queue_lag_seconds reports the age of the oldest waiting job per queue', async () => { /* ... */ });

  it('BR-SEND-013: eow_webhook_lag_seconds records provider-timestamp-to-receipt latency', async () => {
    // webhook-signature.ts already parses `t=<unix>` out of the signature
    // header and returns it as timestampSeconds -- the provider's own send
    // time. now() minus that IS the webhook lag, with no new plumbing.
  });

  it('BR-SEND-013: every send-path and webhook log line carries campaign_id', async () => {
    const lines = await captureDuringOneCampaignSend();
    const withCampaign = lines.filter((l) => l.campaign_id);
    expect(withCampaign.length).toBeGreaterThan(0);
    // "tim log theo campaign_id" means you can filter to one campaign and
    // still see the whole story, so the id must be on the send lines, the
    // dispatcher lines and the webhook lines -- not just one of them.
    expect(new Set(withCampaign.map((l) => l.module))).toEqual(
      expect.arrayContaining(['campaign-send', 'campaign-dispatcher', 'webhooks']),
    );
  });
```

- [ ] **Step 2: Implement**

- **Queue lag:** in `apps/worker/src/main.ts`, on each scan tick, read the oldest waiting job's
  timestamp per queue via BullMQ's API and record `eow_queue_lag_seconds{queue}`. **Touch only the
  handler bodies, not the `Worker` option objects** (M7-S4's — protocol §3.6).
- **Webhook lag:** `webhooks.service.ts` — `verifyWebhookSignature` already returns
  `timestampSeconds` from the `t=` component (`apps/api/src/webhooks/webhook-signature.ts`). Record
  `now - timestampSeconds` as `eow_webhook_lag_seconds{provider}`. No new plumbing needed.
- **Throughput and error rate:** derived in the dashboard from `eow_send_attempt_total{result}`
  (`rate()` over `submitted` for throughput, `failed / total` for error rate). Do **not** add
  separate metrics for them — a derived rate is more honest than a pre-aggregated one, and the
  dashboard is where that belongs. Say so in the inbox.
- **`campaign_id` in logs:** add `campaignId` to the ALS context (`RequestContext` and
  `JobContext`) so the mixin emits `campaign_id` on every line written inside a campaign's
  processing, rather than adding it at ~30 call sites.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @eow/api test && pnpm --filter @eow/worker test
grep -c "campaign_id" <(captured log sample)   # the CP0 "before" was 1 site
```

```bash
git commit -m "M7-S3 CP8: queue lag, webhook lag, and campaign_id in every relevant log line

BR-SEND-013's acceptance names four dashboard dimensions the eleven
runtime_evidence metrics do not cover. Queue lag and webhook lag are new
metrics; throughput and error rate are DERIVED in the dashboard from
eow_send_attempt_total{result} rather than pre-aggregated, because a
derived rate is more honest than a stored one.

Webhook lag needed no new plumbing: verifyWebhookSignature already
returns the provider's own t=<unix> as timestampSeconds.

campaign_id reaches log lines through the ALS context, not through ~30
call sites. At CP0 exactly one log line in the backend carried it
(progress-reconcile.ts:173); it is now on the send, dispatcher and
webhook paths, which is what 'tim log theo campaign_id' actually
requires -- one filter, the whole story."
```

---

## Checkpoint 9 — Dashboard and the runbook alert set

**Files:** `deploy/observability/dashboard.json`, `deploy/observability/prometheus.yml`,
`docs/architecture/observability.md`; modify `docs/operations/runbook.md`, `compose.yaml`,
`.env.deploy.example`, `docs/deployment/environment-variables.md`

- [ ] **Step 1: Write the dashboard and scrape config**

`deploy/observability/prometheus.yml` scraping `api:9464` (or whatever `DEC-157` chose) inside the
`backend` network. `deploy/observability/dashboard.json` — a Grafana dashboard with the four
`BR-SEND-013` panels (queue lag, throughput, error rate, webhook lag) plus reconciliation drift,
notification delivery and dead-letter depth.

- [ ] **Step 2: Add an OPTIONAL compose profile — record as `DEC-158`**

Adding Prometheus and Grafana to the default stack changes the one-command deployment contract:
`docker compose --env-file .env up -d --build --wait` would then require two more images and two
more healthy containers before it returns. Use a **profile** so the default is unchanged:

```yaml
  prometheus:
    profiles: ["observability"]
    image: prom/prometheus:v3.6.0
    ...
  grafana:
    profiles: ["observability"]
    ...
```

`DEC-158`: the observability stack is opt-in via `--profile observability`; the default
one-command deploy is byte-for-byte unchanged in behaviour. Rejected alternative: adding them to
the default stack — it would slow every deploy and make `--wait` depend on two containers that are
not part of the product. Verify:

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env --profile observability config --quiet
```

Both must exit 0. **`M7-S4` also appends to `compose.yaml`/`.env.deploy.example`** — expect a merge
conflict, resolved as "keep both sides" (protocol §7.3). Append your variables in the same order in
all three files.

- [ ] **Step 3: Write the runbook alert set — this is a success condition**

`docs/operations/runbook.md` is 12 lines today and names six alert *subjects* in prose with no
thresholds. **You own this file.** Replace the prose sentence with a real alert set: one row per
alert, each with metric expression, threshold, `for` duration, severity, and the runbook action.
Cover at minimum the six subjects it already names — queue age, failed-job rate, provider
rejection, webhook lag, progress reconciliation drift, notification delivery failures — plus
`eow_dead_letter_depth` (M7-S2's metric; check its inbox for the suggested threshold).

**Name `BR-SEC-005` explicitly** in the section heading or a note: `M7-S4` cites this alert set as
half of *"SLO dashboard và alert tồn tại"* (Scope). Make the citation findable.

`docs/architecture/observability.md` — the new architecture doc: the ALS context, the log field
contract, the redaction rules, the metric list with label constraints, the trace hops, and how to
find a campaign's story from an id. `docs/architecture/system-architecture.md` is 21 lines with no
observability section — add a one-line pointer to the new doc there.

Write every file as **UTF-8** (`ARCH-ENCODING`).

- [ ] **Step 4: Verify and commit**

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env --profile observability config --quiet
pnpm --filter @eow/architecture-tests test -- src/text-encoding.test.ts
```

```bash
git commit -m "M7-S3 CP9: dashboard, scrape config and the runbook alert set

DEC-158: Prometheus and Grafana are behind a compose profile
('--profile observability'), not in the default stack. Adding them to the
default would make 'docker compose up -d --build --wait' depend on two
more healthy containers that are not part of the product, changing the
one-command deployment contract. Both config forms validate.

runbook.md previously named six alert SUBJECTS in one prose sentence with
no thresholds. It now has one row per alert with expression, threshold,
for-duration, severity and action. BR-SEC-005 is named explicitly there:
M7-S4 cites this set as half of 'SLO dashboard va alert ton tai'.

ARCH-ENCODING green."
```

---

## Checkpoint 10 — Full verification and node handoff

- [ ] **Step 1: Contract, if applicable**

If `DEC-157` put `/metrics` under `/api/v1`, append it to `contracts/openapi.yaml` now — one
commit, alone, with a pre-edit copy and `node scripts/openapi-compat-check.mjs` (protocol §3.3). If
it is on a separate port, **do not** add the path; record why in the inbox.

- [ ] **Step 2: Full workspace check, twice, in a quiet window**

```bash
pnpm --filter @eow/api build
pnpm check
pnpm check
```

Compare test **and skip** counts against your CP0 baseline. This node touches more files than any
other in the batch, so a fallen count here is the most likely place for a silently-disabled suite.
Skips must be 0.

- [ ] **Step 3: Deployment contract**

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env --profile observability config --quiet
```

Both exit 0. Confirm every new `EOW_*` in `.env.deploy.example` has a matching `compose.yaml`
mapping **and** a matching `apps/api/src/config/env.ts` key — a variable in one but not the others
boots a half-configured container.

- [ ] **Step 4: Architecture rules**

```bash
pnpm --filter @eow/architecture-tests test
```

Confirm `ARCH-RBAC`, `ARCH-TENANT`, `ARCH-MIGRATION`, `ARCH-JOB-WIRING`, `ARCH-MODULE`,
`ARCH-LAYERING`, `ARCH-TEST-HYGIENE`, `ARCH-ENCODING`, `ARCH-ASYNCAPI-CONFORMANCE` green.

- [ ] **Step 5: Write the final inbox section**

Status **`ready-for-review`**. Rows to propose:

| rule_id | slice | status | notes |
|---|---|---|---|
| `BR-SEND-013` | M7-S3-observability | **test_passing** | All five success conditions evidenced. `log_or_metric_or_audit` column: the full metric list plus "pino structured logs carry tenant_id/trace_id/campaign_id; OTel spans API→outbox→job→provider→webhook; runbook alert set with thresholds". |
| `BR-SEC-003` | M7-S3-observability (log half) | **partially_closed** | Your redaction test in `test_files`. State that `M7-S2` supplies the response/payload half and that a reviewer merging both may flip it to `closed`. |

Also record:

- Both `pnpm check` count sets and the CP0 baseline.
- `DEC-156` (dependencies), `DEC-157` (metrics exposure), `DEC-158` (compose profile), and any
  further decisions from DEC-159/160 (overflow: DEC-166+).
- `D-*` findings. Expect at least: `markAllRead()` emitting no metric;
  `eow_send_retry_total` conflating rate-limit deferrals with error retries (`send.ts:214`);
  the synthetic worker trace ids you replaced; `notification-metrics.ts`'s two never-passed actions;
  and `health.service.ts` returning a hardcoded `'ready'` that probes nothing (**disclose only —
  `M7-S4` owns that directory**).
- **The two one-line follow-ups you deliberately did not make**, addressed to the reviewing
  session: (a) `apps/worker/src/outbox-relay.ts` must read `trace_id` into the job payload — M7-S2
  owns that file; (b) a per-message `provider.send` span inside
  `apps/worker/src/campaign-send/send.ts` — M7-S1 owns that file. Give the exact line and the exact
  code for each so the merge is mechanical.
- **`eow_quota_usage_ratio` is not emitted by this node**, with a pointer to where the registry
  helper should be added once `M7-S1` lands.
- The `BR-SEC-005` link: the runbook alert set is half of `M7-S4`'s citation.

- [ ] **Step 6: Commit and push**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S3-observability.md
git commit -m "M7-S3 CP10: verification complete, ready for review

pnpm check twice: apps/api <F>/<T>, apps/worker <F>/<T>, apps/web <F>/<T>,
packages/architecture-tests <F>/<T>, 0 skipped both runs. CP0 baseline
<...>; no count fell. Both compose config forms exit 0.

BR-SEND-013 proposed test_passing. BR-SEC-003 proposed partially_closed:
this node supplies the log-redaction half (traceability-plan.yaml:293),
M7-S2 supplies the payload half; a reviewer merging both may close it.

Two one-line follow-ups deliberately NOT made because another node owns
the file, with exact code in the inbox for a mechanical merge:
outbox-relay.ts reading trace_id (M7-S2's file), and a per-message
provider.send span in send.ts (M7-S1's file)."
git push -u origin m7-s3-observability
```

**Do not merge into `main`. Do not rebase onto `main`. Do not delete the worktree.**

---

## DEFERRED UI / VISUAL HANDOFF — not for Codex

Protocol §1.1: this node touches no front-end file and takes no screenshot.

1. **`apps/web` has no logging, tracing or metrics work in this node.** `BR-SEND-013`'s statement
   is about campaign/job/message correlation on the server. Client-side error reporting is not in
   its acceptance and was not added.

2. **The trace id is not surfaced in the UI.** An operator reading a Problem body already sees
   `traceId` (it has been in `mapErrorToProblem`'s output since M1), but no screen displays it
   prominently for a support hand-off. Whether an error state should show a copyable trace id is a
   UI-handoff-fidelity question for `M7-S5`.

3. **The Grafana dashboard is not an application screen.** It lives in `deploy/observability/` and
   is served by an opt-in container. It is not in `screen-catalog.yaml`, needs no viewport
   evidence, and is not part of the 13 screens `M7-S5` sweeps.

4. **`screen-catalog.yaml` was not edited**; no `states_covered` was written and no capture was
   taken.
