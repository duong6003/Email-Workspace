# M7-S4 Deployment, backup and restore — Implementation Plan

> **For Codex, working in the `m7-s4-deployment-backup` git worktree on a machine that does not
> have this conversation.** Every checkpoint is self-contained. Read
> [`PARALLEL-EXECUTION-PROTOCOL-M7.md`](PARALLEL-EXECUTION-PROTOCOL-M7.md) **first** — it is
> binding, and §2.3's **destructive-stack rule** applies to this node specifically. Read
> [`PARALLEL-EXECUTION-PROTOCOL.md`](PARALLEL-EXECUTION-PROTOCOL.md) §4 for the inbox pattern.

**Node:** `M7-S4-deployment-backup` · **Branch:** `m7-s4-deployment-backup`
**Rules:** `BR-SEC-004` (P1), `BR-SEC-005` (P1, **one half only** — see Scope)
**Test cases:** `TC-SEC-004`, `TC-SEC-015`, `TC-SEC-005`, `TC-SEND-018`, `TC-SEC-016` (disclosed,
not run) · **Deployment cases:** `DEPLOY-001` … `DEPLOY-010`
**Migration reserved:** `037` — **expected to stay unused** (second, if needed: `067`)
**`DEC-*` block:** DEC-161…DEC-165 · **`D-*` block:** D-156…D-160
**OpenAPI prefix owned:** `/health/ready` · **AsyncAPI:** edits nothing

---

## Goal

The one-command deployment contract is proven, not assumed: all ten `DEPLOY-*` cases have real
recorded evidence; a PostgreSQL backup is taken and restored into an isolated Compose project with
measured RPO and RTO against `BR-SEC-004`'s 15-minute / 4-hour targets; and the worker survives a
real kill mid-batch without losing or duplicating a send.

## Scope — read this before writing anything

### The two rules and their real acceptance text

Quoted from `catalog/ba-rules.json`:

| Rule | Statement | Acceptance |
|---|---|---|
| `BR-SEC-004` | "PostgreSQL backup PITR; mục tiêu đề xuất RPO 15 phút, RTO 4 giờ." | "Diễn tập restore định kỳ đạt mục tiêu **hoặc có biên bản chênh lệch**." |
| `BR-SEC-005` | "API nghiệp vụ mục tiêu 99,9% tháng; gửi bất đồng bộ chịu được restart worker." | "Job không mất/không trùng sau restart; SLO dashboard và alert tồn tại." |

**`BR-SEC-004`'s "hoặc có biên bản chênh lệch" is load-bearing.** The rule does not demand the
targets be met — it demands the rehearsal happen and the result be recorded, including a written
variance report if the targets are missed on this hardware. A rehearsal that misses RTO on a
laptop and says so honestly **satisfies** this rule. A rehearsal that was not run does not, and
neither does a claimed number with no measurement behind it.

### `BR-SEC-005` closes across two nodes — you own one half

Its acceptance has two clauses:

- **"Job không mất/không trùng sau restart"** — yours (CP7, `TC-SEND-018`).
- **"SLO dashboard và alert tồn tại"** — **`M7-S3-observability`'s.** The alert set with thresholds
  lives in `docs/operations/runbook.md`, which M7-S3 owns exclusively (protocol §3.6), and the
  dashboard lives in `deploy/observability/` which M7-S3 creates. You **cite** it; you do not write
  it, and you must not edit `runbook.md`'s alert section.

**So propose `BR-SEC-005` as `partially_closed`, never `closed`,** naming M7-S3 as the owner of the
missing half. Protocol §8.2.

### `TC-SEC-016` is yours — and it stays honest

`traceability.csv` maps `TC-SEC-016` (SSE 10,000 connections, 1,000 events/s) to `BR-SEND-004`
(M6, `partially_closed`) and `BR-SEC-005` (yours). `EXECPLAN` `DEC-143` attributes `BR-SEC-005` to
`M7-S2` in its prose — **that is a slip**, contradicted by the node definition it cites;
`state.json`'s `M7-S4` success conditions read "BR-SEC-004, BR-SEC-005 closed". Protocol §8.1.

The case needs staging infrastructure neither this machine nor the remote one has. `DEC-143`
already established the honest disposition and it does not change:

> **Do not run it. Do not simulate it. Do not claim it.** Record in your inbox that `TC-SEC-016`
> was not executed, why, and what infrastructure it would need. `BR-SEND-004` stays
> `partially_closed`; `BR-SEC-005` closes on its other evidence with `TC-SEC-016` disclosed as not
> run.

A reviewing session should also record a short `DEC-*` correcting `DEC-143`'s attribution. **You do
not edit `EXECPLAN.md`** — put the finding in your inbox.

### You author `TC-SEND-018`; `M7-S2` does not

`TC-SEND-018` is co-owned by `BR-SEC-005` (yours) and `BR-SEC-007` (`M7-S2`'s). You author it,
because its dimension is a real process restart and you are the node with the Compose stack in hand
(protocol §8.7). Its preconditions in `catalog/test-cases.json` are specific: *"Kill worker sau
provider accepted nhưng trước ack queue"*, steps *"1. Khởi động lại worker. 2. Cho message được
redeliver. 3. Reconcile provider/message state."*, expected *"Không gửi trùng nhờ provider/message
idempotency; job tiếp tục và hoàn tất."*

### The destructive-stack rule applies to you (protocol §2.3)

Three other nodes' integration tests connect to the same PostgreSQL, Redis and Mailpit on this
machine. Your checkpoints stop, rebuild and deliberately break that stack.

- Use a **separate Compose project name** wherever the case allows:
  `COMPOSE_PROJECT_NAME=eow-m7s4`. **Mandatory** for the restore rehearsal —
  `docs/deployment/operations.md:24-25` already says it must run "in an isolated project name".
- Where a case genuinely needs the primary project, the checkpoint below is marked
  **`[STACK WINDOW]`**. Announce the window in your inbox and run it when the other three nodes are
  not executing integration tests.

## The live defect you inherit — `D-156`, reproduce it first

Reproduced on the review machine at `eb5a835`, verbatim:

```
error while interpolating services.migrate.environment.EOW_POSTGRES_APP_PASSWORD:
required variable EOW_POSTGRES_APP_PASSWORD is missing a value: Set EOW_POSTGRES_APP_PASSWORD in .env
```

`.github/workflows/ci.yml` copies `.env.deploy.example` and `sed`-fills **three** secrets
(`EOW_POSTGRES_PASSWORD`, `EOW_REDIS_PASSWORD`, `EOW_SESSION_SECRET`), then runs
`docker compose --env-file .env config --quiet`. But `.env.deploy.example:10` leaves
`EOW_POSTGRES_APP_PASSWORD` blank and `compose.yaml` requires it at lines **56, 75, 117, 118, 153**
with `${...:?}`, which errors on **blank as well as unset**. CI's last step fails.

Two consequences, and you act on both:

1. **This is `DEPLOY-001` working exactly as specified** — "Blank required secret → Compose fails
   before container startup and names the variable". CP1 captures it as evidence rather than
   treating it as an obstacle.
2. **CI is nonetheless broken, and you own `.github/workflows/ci.yml`** (protocol §3.6). You fix it,
   and you add a mechanical guard (CP2) so this class of drift cannot recur silently.

## What already exists (verified at `eb5a835` — do not rebuild it)

| Thing | Where | Note |
|---|---|---|
| `compose.yaml` (197 lines) | 7 services: `postgres` (17-alpine), `redis` (8-alpine), `mailpit` (v1.27), `migrate` (**one-shot**, `restart: 'no'`, `depends_on: postgres service_healthy`), `api`, `worker`, `scheduler`, `web` (nginx). Volumes `postgres_data`, `redis_data`; network `backend`. | **6 long-running + 1 one-shot.** `docs/deployment/acceptance-tests.md:6` says "All **seven** long-running services" — that is wrong and is a `D-*` worth recording. |
| Healthchecks | `postgres`: `pg_isready` 5s/5s/20/10s. `redis`: `redis-cli -a ... ping \| grep PONG`. `api`: `node -e "fetch('http://127.0.0.1:3000/api/v1/health')…"` 10s/5s/12/10s. `worker`/`scheduler`: `node -e 'process.kill(1,0)'` — **PID-1 liveness only**. `web`: `wget … /healthz` 10s/5s/12/5s. **`mailpit` has none.** | `api`/`worker`/`scheduler` depend on `migrate: service_completed_successfully` and `redis: service_healthy`; `web` on `api: service_healthy`. |
| Ports | PG `${EOW_POSTGRES_BIND:-127.0.0.1}:${EOW_POSTGRES_PORT:-55432}:5432`, Redis `:56379`, Mailpit `8025`/`1025`, web `${EOW_HTTP_BIND:-0.0.0.0}:${EOW_HTTP_PORT:-8080}:8080`. `api`/`worker`/`scheduler` publish **nothing**. | |
| `Dockerfile` | Targets `dependencies`, `build`, `api`, `worker`, `scheduler`, `web` (nginx:1.29-alpine, copies `deploy/nginx/default.conf`). Base `node:22.22.0-alpine`, pnpm 11.21.0, `USER node`. | |
| `.env.deploy.example` | 45 lines, 30 variables. **Exactly four are required-with-no-default**: `EOW_POSTGRES_PASSWORD` (L9), `EOW_POSTGRES_APP_PASSWORD` (L10), `EOW_REDIS_PASSWORD` (L13), `EOW_SESSION_SECRET` (L16). `EOW_PROVIDER_WEBHOOK_SECRET` (L44) is blank but **optional** — compose uses `${...:-}` for it (D-111). | |
| `scripts/smoke_deploy.py` | **25 lines.** No CLI args; sole input `EOW_SMOKE_BASE_URL` (default `http://localhost:8080`). Checks **two** URLs: `{base}/healthz`, `{base}/api/v1/health`. 20 retries × 1s, 3s timeout. Prints `PASS {name}: {url} ({status})`; exits `1` on failure. | Maps to **`DEPLOY-003` only**. Checks no service health, no volume, no migration exit, no logs. |
| `docs/deployment/acceptance-tests.md` | **16 lines** — one table, scenario + expected per case. **No procedures, no commands, no evidence format.** L16-17: "DEPLOY-002, 004, 006, 007 and 009 require a real Docker runtime and are release evidence, not checks that may be replaced by YAML parsing alone." | |
| `database/migrate.sh` (241 lines, POSIX `sh`, `set -eu`) | `migration_checksum()` (L8-47), `migration_source_is_safe()` (L52-195, an `awk` guard rejecting psql meta-commands and transaction control), then a `for … *.sql` loop (L197-241) piping one generated script per file through `psql -X -w -v ON_ERROR_STOP=1`. | Guards `EOW_POSTGRES_APP_PASSWORD` itself at **L6** — but inside a started container, not before startup. |
| Checksum drift (`DEPLOY-005`) | In-database, not against the lock file: `schema_migrations` table (L213-217); mismatch detected at L218 and forced to fail at L219-223 by casting text to integer under `ON_ERROR_STOP=1`, message *"Published migration \<id\> changed; add a forward migration instead."*; serialised by `pg_advisory_xact_lock(hashtext('eow:schema_migrations'))` at L212. | `database/migrations.lock.json` is **not read by `migrate.sh` at all** — it is consumed only by `ARCH-MIGRATION`. |
| Existing `DEPLOY-005` automation | `migration-immutability.test.ts:18`, `migration-runner-atomicity.test.ts:9`, `migration-execution-safety.test.ts:236`, and **`migration-runner-behavior.test.ts:888`** — `describe('DEPLOY-005: migration runner behavior')`, ~28 cases including `:1195` "fails checksum mismatch and does not apply later migration" and `:1049` "reruns cleanly" | `migration-runner-behavior.test.ts` **requires a live Docker daemon** (`beforeAll` L324-336 runs `docker version` and **throws**, does not skip) and starts real `postgres:17-alpine` containers and temp Compose projects. It is host-load sensitive — `EXECPLAN` D-132. |
| Migrations | 32 files, `001` … `033`. **`019` does not exist** (018 → 020, an intentional committed gap; the lock file matches, `ARCH-MIGRATION` is green with it). | |
| Backup / restore / PITR | **Nothing exists.** Exhaustive search for `pg_dump\|pg_basebackup\|pgbackrest\|wal-g\|barman\|wal_level\|archive_command\|PITR\|RPO\|RTO` outside `node_modules`/`.git` finds only: `docs/deployment/operations.md:17-25` (a `mkdir` + one `pg_dump -Fc` command, then L24-25 "Restore is intentionally not automated because it overwrites data. Rehearse it in an isolated project name and record RPO/RTO evidence before production launch."), plus rule/test/plan text. | No `deploy/backup*`, no `scripts/backup*`, no WAL archiving (the `postgres` service has no `command:`, no `wal_level`, no `archive_command`, no archive volume), no restore automation, no RPO/RTO harness, no scheduled backup job. `deploy/` contains exactly one file: `deploy/nginx/default.conf`. |
| BullMQ durability | `apps/worker/src/main.ts`: three `Worker`s at :23 (`campaign-execution`, 7 job names via `switch`), :127 (`IMPORT_QUEUE`), :136 (`BULK_QUEUE`), each with **only** `{connection, concurrency}` (L126/135/144). **No `attempts`, no `backoff`, no `lockDuration`, no `maxStalledCount`, no stalled handler.** Producer side: `apps/scheduler/src/main.ts:15-21` uses `{jobId: '<name>-<bucket>', removeOnComplete: 100, removeOnFail: 500}` — the deterministic `jobId` from `Math.floor(Date.now()/tickMs)` is what makes ticks non-duplicating. | Graceful shutdown at `main.ts:145-146` (`SIGTERM`/`SIGINT` → close all workers/queues → `connection.quit()` → `exit(0)`). |
| Real durability mechanism | PostgreSQL row claiming in `apps/worker/src/campaign-send/send.ts`: `STALE_CLAIM_MINUTES = 5` (:50); `reserveBatch` claims `FOR UPDATE SKIP LOCKED` with `claimed_at IS NULL OR claimed_at <= now() - interval` (:295-311); `INSERT INTO message_attempt … ON CONFLICT (campaign_recipient_id, attempt_no) DO NOTHING` (:382-384, :410); verdict paths reset `claimed_at = NULL` (:352, :367, :427) | Doc at :91-94: the `message_attempt` row is written outside any transaction that could roll it back, "so a crash between provider accept and commit re-sends under the same Message-ID (DEC-104), never a silent duplicate". **`send.ts` is `M7-S1`'s file this batch** — you do not edit it. |
| Existing crash-simulation tests (none kills a process) | `send.integration.test.ts:367` A15 (reserved-but-never-recorded, simulated by `UPDATE … claimed_at`), `:384`/`:396` (Redis unreachable / mid-run disconnect), `:270` (idempotent claim); `partition.integration.test.ts:132` A16; `import-processor.integration.test.ts:95` ("on restart reclaims only stale unfinished work") | Every one **mutates DB state to imitate** the post-crash condition. Nothing spawns and kills a real worker. That is exactly `TC-SEND-018`'s gap. |
| Health | `apps/api/src/health/` — 4 files. `health.service.ts` returns a **hardcoded literal** `{status:'ready', service:'api', time}` and probes nothing. `GET /api/v1/health` is the only endpoint; **there is no `/ready`**. | This contradicts `docs/operations/runbook.md:3-4` ("API readiness requires PostgreSQL; worker readiness requires queue backend"). **You own this directory** (protocol §3.6). |
| Proxy | `deploy/nginx/default.conf` (43 lines): `location = /healthz` returns a **static** `200 'ok'` (does not touch the API); `location /api/` → `proxy_pass http://$api_upstream` with `set $api_upstream api:3000` and `resolver 127.0.0.11 valid=10s`; `/socket.io/` upgrade with `proxy_read_timeout 65s`; SPA fallback; `client_max_body_size 18m`. | **You own this file.** |
| CI | `.github/workflows/ci.yml`, one job `verify`: install → OpenAPI compat check → `pnpm check` → `ui_handoff.py status --allow-pending` → `validate_bundle.py` → `cp .env.deploy.example .env` → three `sed` fills → `docker compose --env-file .env config --quiet`. **No compose boot job.** | **You own this file.** |
| Architecture rules | 17 rules across `packages/architecture-tests/src/`: `ARCH-ASYNCAPI-CONFORMANCE`, `ARCH-CSV-SHAPE`, `ARCH-ENCODING`, `ARCH-EXPORT-PARITY`, `ARCH-HANDOFF`, `ARCH-JOB-WIRING`, `ARCH-LAYERING`, `ARCH-MIGRATION`, `ARCH-MODULE`, `ARCH-NO-LOOSE-FEATURES`, `ARCH-NO-ORPHANS`, `ARCH-PROGRESS-PARITY`, `ARCH-RBAC`, `ARCH-SUPPRESSION-PARITY`, `ARCH-TENANT`, `ARCH-TEST-HYGIENE`, `ARCH-WEB-STRUCTURE` | **There is no rule about the compose/env/deployment contract.** Nothing asserts `.env.deploy.example` covers every `${…}` in `compose.yaml`, or that `environment-variables.md` matches either. That absence is what let `D-156` ship. CP2 fills it. `ARCH-JOB-WIRING` (`job-wiring.test.ts:19-25`) asserts the worker's `case '<name>':` set equals the scheduler's `queue.add('<name>'` set — relevant to you because CP7 edits both. |
| `docs/deployment/` | `quick-deploy.md` (43 lines: prerequisites, 4-step first deployment, canonical `docker compose --env-file .env up -d --build --wait` at L15, PowerShell variant L29-33, "Production boundary" L38-43 naming managed/backed-up PostgreSQL+Redis as **not yet done**); `operations.md` (36 lines); `environment-variables.md` (57 lines, Required/Default/Purpose table); `acceptance-tests.md` (16 lines). | **You own all four.** |
| Root scripts | `deploy:config` (`docker compose --env-file .env config --quiet`), `deploy:up` (`… up -d --build --wait`), `deploy:down`, `deploy:logs`, `deploy:smoke` (`python scripts/smoke_deploy.py`), `infra:up`/`infra:down`. | **You own the deployment-related root `package.json` scripts.** |

## Architecture

Three workstreams:

1. **CP1-CP2 — make the deployment contract mechanically checkable.** Fix `D-156`, then add
   `ARCH-DEPLOY-CONTRACT`: every `${VAR}` in `compose.yaml` exists in `.env.deploy.example`, every
   `${VAR:?}` is documented as Required in `environment-variables.md`, and CI's `.env` fill covers
   every required-with-no-default variable. The defect that shipped is a symptom of a missing rule,
   and AGENTS.md §5 is explicit that the suite should be extended whenever a convention proves to
   have been violated silently.

2. **CP3-CP6 — execute and record all ten `DEPLOY-*` cases,** automating what can be automated
   (extending `smoke_deploy.py` from 25 lines and two URLs into something that actually covers its
   cases) and capturing real terminal evidence for what cannot.

3. **CP7-CP9 — durability and disaster recovery.** BullMQ job options that actually exist; a real
   worker kill mid-batch (`TC-SEND-018`); a backup script; and a restore rehearsal in an isolated
   Compose project with measured RPO and RTO.

Migration `037` is reserved and **expected to stay unused** — backup and restore are scripts, docs
and Compose, not schema. Leave the number unused rather than reassigning it (protocol §3.1).

## File structure

**Create:** `packages/architecture-tests/src/deployment-contract.test.ts`;
`scripts/backup_db.py`; `scripts/restore_db.py`; `scripts/deploy_acceptance.py`;
`apps/api/src/health/readiness.service.ts` (+ test); `apps/api/src/health/dto/readiness.dto.ts`;
`apps/worker/src/campaign-send/worker-restart.integration.test.ts`;
`docs/operations/backup-restore.md`;
`.agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/` (the ten cases' captured output).

**Modify:** `.github/workflows/ci.yml`; `scripts/smoke_deploy.py`; `compose.yaml`;
`.env.deploy.example`; `docs/deployment/{quick-deploy,operations,environment-variables,acceptance-tests}.md`;
`apps/api/src/health/{health.controller,health.service,health.module}.ts`;
`apps/worker/src/main.ts` *(the `Worker` option objects only)*;
`apps/scheduler/src/main.ts` *(the `queue.add` options only)*; `contracts/openapi.yaml`;
root `package.json` (deployment scripts); the inbox file.

**Must NOT touch:** `apps/web/**` (protocol §1.1), `contracts/asyncapi.yaml`, `catalog/**`,
`state.json`, `traceability.csv`, `screen-catalog.yaml`, `EXECPLAN.md`,
`apps/worker/src/campaign-send/send.ts` (M7-S1's), `apps/worker/src/campaign-send/run.ts` (M7-S3's),
`apps/worker/src/outbox-relay.ts` (M7-S2's), `apps/api/src/common/permissions.ts` (M7-S2's),
`docs/operations/runbook.md`'s alert section and `docs/operations/security-baseline.md`
(M7-S3's / M7-S2's), line 1 of the three `main.ts` files (M7-S3's instrumentation import),
`database/migrations/**` unless you genuinely need `037`.

---

## Checkpoint 0 — Baseline and the `D-156` reproduction

- [ ] **Step 1: Worktree and bootstrap**

```bash
git fetch origin && git checkout main && git pull --ff-only origin main
git worktree add -b m7-s4-deployment-backup ../eow-m7-s4 main
```

In `../eow-m7-s4`: `pnpm install --frozen-lockfile`, copy `.env` from the root clone,
`pnpm infra:up`.

- [ ] **Step 2: Record the real baseline**

```bash
pnpm --filter @eow/api build
pnpm check
```

Record per-package file and test counts **as printed**. If
`migration-runner-behavior.test.ts` times out, re-run it alone before treating it as a failure —
it starts real containers and is host-load sensitive (`EXECPLAN` D-132).

- [ ] **Step 3: Reproduce `D-156` and capture the evidence**

Do exactly what CI does, into a scratch file so your real `.env` is untouched:

```bash
mkdir -p ../m7s4-scratch
cp .env.deploy.example ../m7s4-scratch/ci.env
sed -i 's/^EOW_POSTGRES_PASSWORD=$/EOW_POSTGRES_PASSWORD=ci-postgres-password/' ../m7s4-scratch/ci.env
sed -i 's/^EOW_REDIS_PASSWORD=$/EOW_REDIS_PASSWORD=ci-redis-password/' ../m7s4-scratch/ci.env
sed -i 's/^EOW_SESSION_SECRET=$/EOW_SESSION_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/' ../m7s4-scratch/ci.env
docker compose --env-file ../m7s4-scratch/ci.env config --quiet ; echo "exit=$?"
```

Expected output:

```
error while interpolating services.migrate.environment.EOW_POSTGRES_APP_PASSWORD:
required variable EOW_POSTGRES_APP_PASSWORD is missing a value: Set EOW_POSTGRES_APP_PASSWORD in .env
exit=1
```

Save the verbatim output to
`.agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-001-blank-required-secret.txt`.
**This is `DEPLOY-001`'s evidence** and simultaneously the `D-156` reproduction.

- [ ] **Step 4: Open the inbox and commit**

Write `D-156` into `## Checkpoint 0 — baseline` with the verbatim error, the five `compose.yaml`
line numbers (56, 75, 117, 118, 153), `.env.deploy.example:10`, and the note that `${VAR:?}` errors
on blank as well as unset.

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S4-deployment-backup.md \
        .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-001-blank-required-secret.txt
git commit -m "M7-S4 CP0: baseline; D-156 reproduced and captured as DEPLOY-001 evidence

pnpm check exit 0. Counts: apps/api <F>/<T>, apps/worker <F>/<T>,
apps/web <F>/<T>, packages/architecture-tests <F>/<T>, 0 skipped.

D-156: ci.yml sed-fills three secrets; compose.yaml requires four with
\${VAR:?}, which errors on BLANK as well as unset. CI's last step
(docker compose config --quiet) fails. Reproduced verbatim.

The same run is DEPLOY-001's evidence: blank required secret fails before
container startup and names the variable. The case works; CI does not."
```

---

## Checkpoint 1 — Fix CI, and `DEPLOY-010`'s log-secret half

**Files:** `.github/workflows/ci.yml`

- [ ] **Step 1: Add the missing fill**

In `.github/workflows/ci.yml`, in the `sed` step, add:

```yaml
          sed -i 's/^EOW_POSTGRES_APP_PASSWORD=$/EOW_POSTGRES_APP_PASSWORD=ci-postgres-app-password/' .env
```

- [ ] **Step 2: Prove the fix locally**

```bash
cp ../m7s4-scratch/ci.env ../m7s4-scratch/ci-fixed.env
sed -i 's/^EOW_POSTGRES_APP_PASSWORD=$/EOW_POSTGRES_APP_PASSWORD=ci-postgres-app-password/' ../m7s4-scratch/ci-fixed.env
docker compose --env-file ../m7s4-scratch/ci-fixed.env config --quiet ; echo "exit=$?"
```

Expected: no output, `exit=0`.

- [ ] **Step 3: Check the resolved config leaks no secret — `DEPLOY-010` half**

`DEPLOY-010` is "Config and log inspection → Config is valid and logs contain no secrets". The
config half is checkable now; the log half needs a running stack and lands at CP5.

```bash
docker compose --env-file ../m7s4-scratch/ci-fixed.env config | grep -c "ci-postgres-app-password"
```

`docker compose config` **does** print resolved values, so this will be non-zero — which is why
`--quiet` exists and why CI uses it. Record that as the finding, and note in
`docs/deployment/operations.md` that `docker compose config` without `--quiet` prints secrets and
must not be pasted into a ticket. That is a genuinely useful operational warning and it is
currently nowhere.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S4-deployment-backup.md
git commit -m "M7-S4 CP1: fix D-156 -- CI never filled EOW_POSTGRES_APP_PASSWORD

One sed line. compose.yaml has required it at five places since the
baseline commit (6afedde) and ci.yml has filled only three secrets since
the same commit, so the final step has been failing for the whole run.

Verified locally: the four-secret fill makes
'docker compose --env-file .env config --quiet' exit 0.

Also recorded: 'docker compose config' WITHOUT --quiet prints resolved
secret values, which is why CI uses --quiet. Documented in
operations.md so nobody pastes one into a ticket."
```

---

## Checkpoint 2 — `ARCH-DEPLOY-CONTRACT`: stop this class of drift recurring

**Files:** `packages/architecture-tests/src/deployment-contract.test.ts`

AGENTS.md §5: *"Extend the suite whenever a convention proves to have been violated silently — that
is the cheapest point at which the next agent learns it."* `D-156` is exactly that.

- [ ] **Step 1: Write the rule**

```ts
/**
 * ARCH-DEPLOY-CONTRACT.
 *
 * AGENTS.md §2: "Any change to runtime dependencies, ports, environment
 * variables, migrations, startup, health/readiness or static assets must
 * preserve the one-command deployment contract. Update compose.yaml,
 * .env.deploy.example, Docker targets and deployment docs together."
 *
 * That was prose until D-156: compose.yaml required EOW_POSTGRES_APP_PASSWORD
 * at five places, .env.deploy.example left it blank, and ci.yml filled only
 * three of the four required secrets -- so CI's final step failed silently
 * from the baseline commit onward. Seventeen architecture rules existed and
 * none of them covered this surface.
 *
 * Four tests, each one a thing that was true and unchecked:
 */
```

The four tests:

1. **Every `${VAR...}` referenced in `compose.yaml` appears in `.env.deploy.example`.** Parse
   `compose.yaml` for `\$\{([A-Z0-9_]+)` and diff against the example's `^([A-Z0-9_]+)=` keys.
   Failure message lists the missing names.
2. **Every `${VAR:?...}` (required) variable is documented as `Required: Yes` in
   `docs/deployment/environment-variables.md`,** and every variable the doc marks required is
   actually `:?` in compose. Both directions — a doc that over-claims is as misleading as one that
   under-claims.
3. **CI's `.env` fill covers every variable that is `:?`-required in compose AND blank in
   `.env.deploy.example`.** Parse `.github/workflows/ci.yml` for the `sed` fills. **This is the
   exact test that would have caught `D-156`.**
4. **Every service in `compose.yaml` that is long-running has a healthcheck**, with a reasoned
   allowlist for the ones that legitimately do not (`mailpit` is a dev-only mail sink; `migrate` is
   one-shot with `restart: 'no'`). Each allowlist entry carries a written reason, the same pattern
   `ARCH-TENANT` and `ARCH-RBAC` already use.

- [ ] **Step 2: Run it — test 3 must have failed before CP1**

```bash
git stash && pnpm --filter @eow/architecture-tests test -- src/deployment-contract.test.ts ; git stash pop
```

Confirm test 3 fails against the pre-CP1 `ci.yml` and passes after. **Record both runs in the
inbox** — a rule that has never been observed failing is a rule you have not tested.

```bash
pnpm --filter @eow/architecture-tests test -- src/deployment-contract.test.ts
```

Expected now: PASS, 4 tests. If test 1 or 2 also fails, you have found more drift — record each as
a `D-*` and fix the docs (you own them).

- [ ] **Step 3: Commit**

```bash
git add packages/architecture-tests/src/deployment-contract.test.ts \
        docs/deployment/ .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S4-deployment-backup.md
git commit -m "M7-S4 CP2: ARCH-DEPLOY-CONTRACT

Seventeen architecture rules existed and none covered compose/env/docs
agreement, which is how D-156 shipped and stayed shipped. AGENTS.md §5:
extend the suite when a convention proves to have been violated silently.

Four tests: every compose \${VAR} exists in .env.deploy.example; every
\${VAR:?} is documented Required (both directions -- a doc that
over-claims misleads as much as one that under-claims); CI's .env fill
covers every required-and-blank variable (the test that would have caught
D-156); every long-running service has a healthcheck, with reasoned
allowlist entries for mailpit and the one-shot migrate.

Verified the third test FAILS against the pre-CP1 ci.yml and passes after
-- a rule never observed failing is a rule not yet tested.

<additional drift found, or 'tests 1, 2 and 4 were already green'>"
```

---

## Checkpoint 3 — `DEPLOY-002`, `-003`, `-004`: clean boot, smoke, idempotent second boot **[STACK WINDOW]**

Announce the window in your inbox before starting. These use the **primary** project because
`DEPLOY-004`'s whole point is that the *same* named volumes survive.

- [ ] **Step 1: Create a real `.env` with locally generated secrets**

`state.json`'s first success condition: *".env created from .env.deploy.example with locally
generated secrets, never committed."*

```bash
cp .env.deploy.example .env.deploy.local
```

Fill the four required secrets with **locally generated** values (e.g.
`openssl rand -hex 32` for `EOW_SESSION_SECRET`, which must be ≥32 characters per
`apps/api/src/config/env.ts`). **`.env.deploy.local` must never be committed** — confirm
`.gitignore` covers it, and if it does not, add the pattern in this commit. AGENTS.md §2: an
override of `.gitignore` is a signal to stop and re-read what you are staging.

```bash
git status --porcelain | grep -i env   # must show nothing but a .gitignore change
```

- [ ] **Step 2: `DEPLOY-002` — clean one-command boot**

```bash
docker compose --env-file .env.deploy.local up -d --build --wait ; echo "exit=$?"
docker compose --env-file .env.deploy.local ps --format json > \
  .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-002-ps.json
docker compose --env-file .env.deploy.local logs migrate > \
  .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-002-migrate.log
```

Expected: `exit=0`; the six long-running services `healthy` or `running`; `migrate` exited `0`.
Note in the evidence that `mailpit` has no healthcheck so `--wait` does not gate on it.

- [ ] **Step 3: `DEPLOY-003` — public smoke test**

```bash
EOW_SMOKE_BASE_URL=http://localhost:8080 python scripts/smoke_deploy.py | tee \
  .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-003-smoke.txt
```

Expected: `PASS` for both `/healthz` and `/api/v1/health`, exit 0.

- [ ] **Step 4: `DEPLOY-004` — idempotent second boot**

Seed a row first, so "no volume data loss" is an observation and not an assumption:

```bash
docker compose --env-file .env.deploy.local exec -T postgres \
  psql -U eow -d eow -c "INSERT INTO tenant (name) VALUES ('deploy-004-marker') RETURNING id;" | tee \
  .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-004-seed.txt

docker compose --env-file .env.deploy.local up -d --build --wait ; echo "exit=$?"

docker compose --env-file .env.deploy.local exec -T postgres \
  psql -U eow -d eow -c "SELECT count(*) FROM tenant WHERE name = 'deploy-004-marker';" | tee \
  .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-004-after.txt
docker compose --env-file .env.deploy.local logs migrate | tail -40 >> \
  .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-004-after.txt
```

Expected: `exit=0`; the marker row still there (count 1); `migrate` reporting every migration
already applied with no "changed" error and no re-creation failure.

- [ ] **Step 5: Commit the evidence**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/ \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S4-deployment-backup.md .gitignore
git commit -m "M7-S4 CP3: DEPLOY-002/003/004 evidence [stack window]

Real Docker runtime, primary compose project (DEPLOY-004 needs the SAME
named volumes). .env.deploy.local holds locally generated secrets and is
gitignored, never committed.

DEPLOY-004 seeds a marker row BEFORE the second boot, so 'no volume data
loss' is an observation rather than an assumption.

Recorded: mailpit has no healthcheck, so --wait does not gate on it --
six of the seven services are what 'all healthy' actually means here,
against acceptance-tests.md:6's claim of seven long-running services."
```

---

## Checkpoint 4 — Make `smoke_deploy.py` cover its cases; add real readiness

**Files:** `scripts/smoke_deploy.py`, `apps/api/src/health/*`, `contracts/openapi.yaml` (deferred to
CP9), `deploy/nginx/default.conf`

`scripts/smoke_deploy.py` is 25 lines checking two URLs. `state.json` requires it to pass, and
`DEPLOY-003` is the only case it touches. Both it and the health endpoint are weaker than the docs
claim.

- [ ] **Step 1: Write the failing readiness test**

`apps/api/src/health/readiness.service.test.ts`:

```ts
  it('BR-SEC-005: readiness is unready when PostgreSQL is unreachable', async () => {
    // runbook.md:3-4 claims "API readiness requires PostgreSQL; worker
    // readiness requires queue backend". health.service.ts returns a
    // hardcoded {status:'ready'} and probes nothing, so the claim has been
    // false for the whole run. DEPLOY-006 ("Database unavailable ->
    // dependent services never report a ready stack") depends on it.
    const service = new ReadinessService(failingDataSource, workingRedis);
    const result = await service.check();
    expect(result.status).toBe('unready');
    expect(result.checks.database.ok).toBe(false);
    expect(result.checks.redis.ok).toBe(true);
  });

  it('BR-SEC-005: readiness is unready when Redis is unreachable', async () => { /* ... */ });
  it('BR-SEC-005: readiness is ready when both are reachable', async () => { /* ... */ });

  it('BR-SEC-003: an unready response names the failing dependency but no connection string', async () => {
    const result = await new ReadinessService(failingDataSource, workingRedis).check();
    expect(JSON.stringify(result)).not.toMatch(/postgresql:\/\//);
    expect(JSON.stringify(result)).not.toContain('password');
  });
```

- [ ] **Step 2: Implement**

- `readiness.service.ts`: `SELECT 1` against the DataSource and a Redis `PING`, each with a short
  timeout, returning `{status, checks: {database: {ok, latencyMs}, redis: {ok, latencyMs}}}`.
- `health.controller.ts`: add `@Get('ready') @Public()`. **Leave `GET /health` exactly as it is** —
  `compose.yaml:100`'s healthcheck hits it and `smoke_deploy.py` checks it; changing its semantics
  mid-batch would break the other three nodes' stacks. Liveness and readiness are different
  questions and now have different endpoints. Record that as `DEC-161`.
- `compose.yaml`: point the `api` healthcheck at `/api/v1/health/ready` so
  `service_healthy` — which `worker`, `scheduler` and `web` all gate on — means something.
- `deploy/nginx/default.conf`: leave `/healthz`'s static `200` as the **edge** liveness probe
  (that is correct — it proves nginx is up independent of the API) but say so in a comment, because
  the current file makes it look like an application health check.

- [ ] **Step 3: Extend `smoke_deploy.py`**

Keep it dependency-free (`urllib`, no `requests` — it runs on a bare host). Add, as **named checks
each mapped to its `DEPLOY-*` id in the output**:

- `/healthz` and `/api/v1/health` (existing, `DEPLOY-003`).
- `/api/v1/health/ready` returning `status: ready` (`DEPLOY-003`, `DEPLOY-006`).
- Every long-running service reporting `healthy`/`running` and `migrate` exit 0, via
  `docker compose ps --format json` (`DEPLOY-002`).
- A `--json` flag writing a machine-readable result, and a `--case DEPLOY-00N` filter so a single
  case can be re-run.
- A non-zero exit that **names which check failed**, not just `1`.

Update `docs/deployment/acceptance-tests.md` from a 16-line table into real procedures: per case,
the exact command, the expected output, and where the evidence file lives. Fix its line 6 claim of
"seven long-running services" (it is six plus a one-shot).

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @eow/api test -- src/health/
python scripts/smoke_deploy.py --json
pnpm --filter @eow/architecture-tests test -- src/deployment-contract.test.ts
```

```bash
git commit -m "M7-S4 CP4: real readiness probe and a smoke test that covers its cases

DEC-161: /api/v1/health keeps its exact current semantics (liveness) and
readiness gets its own endpoint. runbook.md:3-4 has claimed 'API
readiness requires PostgreSQL' for the whole run while health.service.ts
returned a hardcoded 'ready' and probed nothing -- DEPLOY-006 is
unprovable against that. Changing /health in place would have altered the
healthcheck the other three nodes' stacks depend on mid-batch.

The api healthcheck now targets /health/ready, so service_healthy -- which
worker, scheduler and web all gate on -- finally means something.

smoke_deploy.py grew from two URLs to named per-DEPLOY-case checks with
--json and --case, and a non-zero exit that names the failing check.
acceptance-tests.md is now procedures, not a one-line table; its 'seven
long-running services' claim is corrected to six plus a one-shot migrate.

<N>/<N> tests."
```

---

## Checkpoint 5 — `DEPLOY-005`, `-006`, `-008`, `-010`

- [ ] **Step 1: `DEPLOY-005` — migration drift**

Already automated by `migration-runner-behavior.test.ts:1195` ("fails checksum mismatch and does
not apply later migration"). Capture it as evidence rather than re-implementing:

```bash
pnpm --filter @eow/architecture-tests test -- src/migration-runner-behavior.test.ts 2>&1 | tee \
  .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-005-runner-behavior.txt
```

Then prove it end-to-end against a real deployment, in an **isolated project** so the primary
database is never left with a drifted checksum:

```bash
COMPOSE_PROJECT_NAME=eow-m7s4-drift docker compose --env-file .env.deploy.local up -d postgres --wait
# apply migrations, then modify a published file's bytes in a scratch copy and re-run migrate
```

Expected: the runner aborts with
`Published migration <id> changed; add a forward migration instead.` Capture verbatim. Then
`COMPOSE_PROJECT_NAME=eow-m7s4-drift docker compose down -v`.

- [ ] **Step 2: `DEPLOY-006` — database unavailable [STACK WINDOW]**

```bash
docker compose --env-file .env.deploy.local stop postgres
docker compose --env-file .env.deploy.local ps --format json | tee \
  .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-006-ps.json
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/v1/health/ready | tee -a \
  .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-006-ready.txt
docker compose --env-file .env.deploy.local start postgres
```

Expected: readiness returns non-200 (choose `503` and state the choice), and `api` goes
`unhealthy`. **This is the case CP4's readiness work exists for** — against the old hardcoded
`/health` it would have reported a healthy stack over a dead database.

- [ ] **Step 3: `DEPLOY-008` — host port conflict**

```bash
python -c "import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR,1); s.bind(('0.0.0.0',8080)); s.listen(1); time.sleep(120)" &
docker compose --env-file .env.deploy.local up -d web 2>&1 | tee \
  .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-008-port-conflict.txt
```

Expected: an actionable bind failure naming port 8080. Kill the holder afterwards.

- [ ] **Step 4: `DEPLOY-010` — config and log inspection**

```bash
docker compose --env-file .env.deploy.local config --quiet ; echo "exit=$?"
docker compose --env-file .env.deploy.local logs --no-color > ../m7s4-scratch/all.log
for v in "$EOW_POSTGRES_PASSWORD" "$EOW_POSTGRES_APP_PASSWORD" "$EOW_REDIS_PASSWORD" "$EOW_SESSION_SECRET"; do
  grep -c -- "$v" ../m7s4-scratch/all.log
done
```

Expected: config exits 0; **every grep returns 0**. Capture the counts (not the log) as evidence —
the log itself must never be committed.

> **If a secret appears in the logs, that is a real `BR-SEC-003` defect.** Record it as a `D-*`,
> report it, and note that `M7-S3-observability` owns the logger and the redaction layer — the fix
> belongs there, not here. Do not implement redaction in this node.

- [ ] **Step 5: Commit**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/ \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S4-deployment-backup.md
git commit -m "M7-S4 CP5: DEPLOY-005/006/008/010 evidence

DEPLOY-005 captured from the existing migration-runner-behavior suite AND
proven end-to-end against a real deployment in an ISOLATED project, so
the primary database is never left holding a drifted checksum.

DEPLOY-006 is the case CP4's readiness work exists for: against the old
hardcoded /health it would have reported a healthy stack over a stopped
database.

DEPLOY-010: config exits 0 and none of the four secrets appears in any
container log. Counts captured; the log itself is not committed."
```

---

## Checkpoint 6 — `DEPLOY-007`, `-009` **[STACK WINDOW]**

- [ ] **Step 1: `DEPLOY-007` — Redis restart**

Expected: "Runtime recovers or exposes unhealthy state without business-truth loss."

Start a real campaign send, restart Redis mid-flight, and check the canonical facts:

```bash
docker compose --env-file .env.deploy.local restart redis
```

Then assert, from PostgreSQL: no `campaign_recipient` row is lost; no duplicate `message_attempt`
row exists (`ON CONFLICT (campaign_recipient_id, attempt_no) DO NOTHING` is the guarantee); and
progress counters still reconcile. `send.integration.test.ts:384` and `:396` already cover Redis
unreachable and mid-run disconnect at the unit level — this is the deployment-level counterpart, so
cite them and capture the container-level evidence.

Note the pre-existing behaviour honestly: `checkRateLimits` **fails closed** on a Redis error
(`send.ts:239-241`, `EXECPLAN` DEC-103), so during the outage recipients are **deferred**, not
failed — which is business-truth-preserving and is the correct outcome. Say so.

- [ ] **Step 2: `DEPLOY-009` — stop and redeploy**

```bash
docker compose --env-file .env.deploy.local down          # NOT -v: volumes must persist
docker compose --env-file .env.deploy.local up -d --build --wait
python scripts/smoke_deploy.py --json | tee \
  .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/DEPLOY-009-smoke.json
docker compose --env-file .env.deploy.local exec -T postgres \
  psql -U eow -d eow -c "SELECT count(*) FROM tenant WHERE name = 'deploy-004-marker';"
```

Expected: named volumes persist (the CP3 marker row is still there), smoke passes.

> **`down` without `-v` is the whole case.** `down -v` would delete `postgres_data` and
> `redis_data` and turn a persistence test into a fresh install. Write that warning into
> `docs/deployment/operations.md`.

- [ ] **Step 3: Commit**

```bash
git commit -m "M7-S4 CP6: DEPLOY-007/009 evidence [stack window]

DEPLOY-007 asserts business truth in PostgreSQL, not container liveness:
no recipient row lost, no duplicate message_attempt (the ON CONFLICT
(campaign_recipient_id, attempt_no) guarantee), counters still reconcile.
Recorded honestly that checkRateLimits fails CLOSED on a Redis error
(DEC-103), so recipients are deferred rather than failed during the
outage -- which is the business-truth-preserving outcome, not a defect.

DEPLOY-009 uses 'down' without -v deliberately: -v would delete
postgres_data and turn a persistence test into a fresh install. Warning
added to operations.md. The CP3 marker row survived."
```

---

## Checkpoint 7 — `TC-SEND-018`: BullMQ durability and a real worker kill

**Files:** `apps/worker/src/main.ts` *(option objects only)*, `apps/scheduler/src/main.ts`
*(`queue.add` options only)*, `apps/worker/src/campaign-send/worker-restart.integration.test.ts`

`BR-SEC-005`: *"Job không mất/không trùng sau restart."* Every existing test **mutates DB state to
imitate** a crash. None kills a process.

- [ ] **Step 1: Write the failing test**

`apps/worker/src/campaign-send/worker-restart.integration.test.ts`. It must spawn a **real** worker
process and `SIGKILL` it mid-batch — `SIGTERM` would run the graceful shutdown at
`main.ts:145-146` and prove nothing.

```ts
  it('TC-SEND-018: a worker SIGKILLed mid-batch loses no recipient and duplicates no send', async () => {
    // catalog/test-cases.json's precondition: "Kill worker sau provider
    // accepted nhung truoc ack queue". SIGKILL, not SIGTERM -- SIGTERM runs
    // main.ts:145-146's graceful close and would prove nothing.
    const worker = spawn(process.execPath, ['dist/main.js'], { cwd: workerDir, env: workerEnv });
    await waitUntilAtLeastNSubmitted(3);
    worker.kill('SIGKILL');
    await once(worker, 'exit');

    const midpoint = await countMessageAttempts(executionId);
    expect(midpoint).toBeGreaterThan(0);

    const restarted = spawn(process.execPath, ['dist/main.js'], { cwd: workerDir, env: workerEnv });
    await waitUntilExecutionCompletes(executionId, 120_000);
    restarted.kill('SIGTERM');

    // "Khong gui trung nho provider/message idempotency": exactly one
    // attempt per (recipient, attempt_no), and every recipient reached a
    // terminal state -- job tiep tuc va hoan tat.
    const duplicates = await pool.query(
      `SELECT campaign_recipient_id, attempt_no, count(*) FROM message_attempt
        WHERE execution_id = $1 GROUP BY 1, 2 HAVING count(*) > 1`, [executionId]);
    expect(duplicates.rows).toEqual([]);

    const stranded = await pool.query(
      `SELECT id FROM campaign_recipient WHERE execution_id = $1 AND status IN ('pending','queued')`,
      [executionId]);
    expect(stranded.rows).toEqual([]);
  }, 180_000);

  it('TC-SEND-018: a row claimed by the killed process is reclaimed after STALE_CLAIM_MINUTES, not before', async () => {
    // send.ts:50's STALE_CLAIM_MINUTES = 5 is what prevents a second worker
    // racing a still-live one. Assert both halves: not before, and after.
  }, 180_000);

  it('BR-SEC-005: a BullMQ job whose worker died is redelivered rather than lost', async () => {
    // With no lockDuration/maxStalledCount configured today, this is
    // untested territory. It is the half of "job khong mat" that lives in
    // the queue rather than in PostgreSQL.
  }, 180_000);
```

The test needs a compiled worker (`pnpm --filter @eow/worker build`) and a `sendFn` that is slow
enough to be interrupted — inject one via env (a fake SMTP target with a delay), or point
`SMTP_HOST` at Mailpit and use a large enough batch.

- [ ] **Step 2: Run it and record what actually happens**

```bash
pnpm --filter @eow/worker build
pnpm --filter @eow/worker test -- src/campaign-send/worker-restart.integration.test.ts
```

The first two tests may well **pass immediately** — the PostgreSQL claim/`ON CONFLICT` design is
sound and `send.ts:91-94` documents exactly this scenario. That is a good outcome and is worth
saying: it converts a design claim into a measured one. The third is the likely failure.

- [ ] **Step 3: Configure BullMQ durability**

In `apps/worker/src/main.ts`, **the three `Worker` option objects only** (lines ~126, 135, 144 —
`{connection, concurrency}`), add `lockDuration` and `maxStalledCount`, and a `worker.on('stalled')`
handler that logs. In `apps/scheduler/src/main.ts`, add `attempts` and `backoff` to the
`queue.add(...)` options (currently `{jobId, removeOnComplete: 100, removeOnFail: 500}`), so a
throwing job retries instead of going straight to `failed` on BullMQ's default of one attempt.

> **Protocol §3.6: `M7-S3-observability` also edits both files** — line 1 (its instrumentation
> import) and the handler bodies. You touch **only** the option objects. Do not reformat either
> file; a reformat turns a mechanically-resolvable merge into a manual one.

> Choose `lockDuration` **longer than the slowest realistic batch**, or BullMQ will consider a
> healthy long-running job stalled and redeliver it — which manufactures the duplicate this rule
> forbids. State the number you chose and your reasoning in the inbox.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @eow/worker test
pnpm --filter @eow/architecture-tests test -- src/job-wiring.test.ts
```

`ARCH-JOB-WIRING` asserts the worker's handled job-name set equals the scheduler's enqueued set —
editing both files is exactly what can break its scanner.

```bash
git commit -m "M7-S4 CP7: TC-SEND-018 with a real SIGKILL, and BullMQ durability options

Every existing crash test in this repo mutates DB state to IMITATE a
crash (send.integration.test.ts:367 A15, import-processor:95). This one
spawns a real compiled worker and SIGKILLs it mid-batch -- SIGTERM would
run main.ts:145-146's graceful close and prove nothing.

The PostgreSQL half held on first run: no duplicate (campaign_recipient_id,
attempt_no) and no stranded recipient, which converts send.ts:91-94's
design claim (DEC-104) into a measured one.

The queue half did not: no lockDuration, maxStalledCount, attempts or
backoff was configured anywhere, so a job whose worker died was untested
territory. lockDuration is set LONGER than the slowest realistic batch --
a shorter one makes BullMQ redeliver a healthy long-running job and
manufactures the duplicate this rule forbids.

Only the option objects were touched in main.ts; M7-S3 owns line 1 and
the handler bodies. ARCH-JOB-WIRING green.

<N>/<N> tests."
```

---

## Checkpoint 8 — `BR-SEC-004`: backup, restore rehearsal, RPO and RTO

**Files:** `scripts/backup_db.py`, `scripts/restore_db.py`, `docs/operations/backup-restore.md`;
modify `docs/deployment/operations.md`, root `package.json`

Nothing exists today beyond two commands in `operations.md`. `TC-SEC-004` and `TC-SEC-015`.

- [ ] **Step 1: Write `scripts/backup_db.py`**

Dependency-free (stdlib + `docker compose`). It must:

- Take `--env-file`, `--project`, `--out` and default sensibly.
- Run `pg_dump -Fc` inside the `postgres` container (the custom format `operations.md` already
  uses), stream to the output path, and **fail loudly on a non-zero exit** rather than leaving a
  truncated file that looks like a backup.
- Record a sidecar JSON: timestamp, database, dump size, `sha256`, the migration count from
  `schema_migrations`, and the wall-clock duration. **Duration is the RPO input** — a backup that
  takes longer than the RPO window cannot meet it.
- Verify the dump is readable (`pg_restore --list` into `/dev/null`) before declaring success. An
  unverified backup is not a backup.

- [ ] **Step 2: Write `scripts/restore_db.py`**

- Take `--dump`, `--project` (**required, no default**) and refuse to run against the project name
  in the current `.env`. `operations.md:24-25` already says restore "is intentionally not
  automated because it overwrites data" — this script does not change that judgement, it **enforces
  it**: it only ever targets an isolated project it brings up itself.
- Bring up a fresh `postgres` under the given project, `pg_restore`, then run a verification query
  set (row counts for `tenant`, `campaign`, `recipient`, `message_attempt`, and the
  `schema_migrations` count) and compare against the backup's sidecar.
- Print measured **RTO** (wall clock from invocation to verified-restored) and the **RPO** implied
  by the backup's timestamp.

Add `deploy:backup` and `deploy:restore` to the root `package.json` scripts, beside the existing
`deploy:*` family.

- [ ] **Step 3: Run the rehearsal — this is `TC-SEC-015`'s evidence**

```bash
python scripts/backup_db.py --env-file .env.deploy.local --out ../m7s4-scratch/eow-$(date -u +%Y%m%dT%H%M%SZ).dump
python scripts/restore_db.py --dump ../m7s4-scratch/eow-<stamp>.dump --project eow-m7s4-restore
COMPOSE_PROJECT_NAME=eow-m7s4-restore docker compose --env-file .env.deploy.local down -v
```

Capture both scripts' output verbatim into
`.agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/TC-SEC-015-restore-rehearsal.txt`.
**Do not commit the dump file** — it contains real local data. Confirm `.gitignore` covers
`*.dump`.

- [ ] **Step 4: Write `docs/operations/backup-restore.md` — including the variance report**

Document: the backup command and schedule recommendation; the restore procedure and its
isolated-project requirement; the **measured** RPO and RTO from your rehearsal; and, against
`BR-SEC-004`'s 15-minute / 4-hour targets, an explicit statement of whether they were met.

**`BR-SEC-004`'s acceptance is "đạt mục tiêu HOẶC có biên bản chênh lệch".** So if the targets are
not met — and on a developer machine with a `pg_dump`-based flow rather than WAL archiving, the
RPO almost certainly is not — write the variance report. It must state plainly:

- `pg_dump` gives an RPO equal to the **backup interval**, not 15 minutes, unless the job runs
  every 15 minutes. True PITR needs `wal_level = replica` plus `archive_command` or a tool like
  `pgBackRest`/`wal-g`, none of which exists and none of which is configured in `compose.yaml`'s
  `postgres` service (it has no `command:` at all).
- The measured RTO on this hardware, and what it would be at production data volume.
- What would have to change to meet the targets, concretely.

That written variance **satisfies** the rule. A fabricated "targets met" would not, and would be
exactly the class of unevidenced claim this run has already had to correct.

`docs/deployment/quick-deploy.md`'s "Production boundary" section (L38-43) already names managed or
backed-up PostgreSQL/Redis as not yet done — update it to point at the new doc rather than leaving
two statements of the same gap.

- [ ] **Step 5: Commit**

```bash
git add scripts/backup_db.py scripts/restore_db.py docs/operations/backup-restore.md \
        docs/deployment/ package.json .gitignore \
        .agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/ \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S4-deployment-backup.md
git commit -m "M7-S4 CP8: backup, restore rehearsal, and the RPO/RTO variance report

No backup or restore automation existed anywhere in the repo -- only two
commands in operations.md and its own note that restore is deliberately
not automated because it overwrites data. restore_db.py does not overturn
that judgement, it enforces it: --project is required, it refuses the
project in the current .env, and it only ever targets an isolated project
it brings up itself.

backup_db.py verifies the dump with pg_restore --list before declaring
success -- an unverified backup is not a backup -- and records duration,
size, sha256 and the migration count as a sidecar.

BR-SEC-004's acceptance is 'dat muc tieu HOAC co bien ban chenh lech'.
Measured RPO <X>, RTO <Y> against the 15-minute / 4-hour targets. The
variance report states plainly that pg_dump gives an RPO equal to the
backup INTERVAL, not 15 minutes; true PITR needs wal_level=replica plus
an archive_command, and compose.yaml's postgres service has no command:
at all. That written variance is what the rule asks for; a fabricated
'targets met' is not.

Dumps are gitignored and not committed."
```

---

## Checkpoint 9 — Contract, `TC-SEC-005`, `TC-SEC-016` disclosure

- [ ] **Step 1: OpenAPI (single late commit)**

```bash
cp contracts/openapi.yaml ../openapi-before-m7-s4.yaml
```

Append `/health/ready` (operation `getReadiness`, 200 and 503 responses, `ReadinessResponse`
schema) as a **sibling** of the existing `/health` at line 54. **Do not modify `/health`**
(protocol §3.3).

```bash
node scripts/openapi-compat-check.mjs ../openapi-before-m7-s4.yaml contracts/openapi.yaml
pnpm contracts:generate && pnpm --filter @eow/api typecheck
git add contracts/openapi.yaml
git commit -m "M7-S4 CP9a: /health/ready contract, additive only

Sibling of the existing /health, which is untouched: its semantics gate
the compose healthcheck the other three nodes' stacks depend on.
openapi-compat-check against the pre-edit copy: additive only."
```

- [ ] **Step 2: `TC-SEC-005` evidence**

*"Job không mất/không trùng sau restart; SLO dashboard và alert tồn tại."* The first clause is
CP7's. For the second, **cite `M7-S3-observability`'s `docs/operations/runbook.md` alert set and
`deploy/observability/dashboard.json`** — do not write them (protocol §3.6, Scope). Record in your
inbox that `BR-SEC-005` is `partially_closed` pending M7-S3's merge, and check M7-S3's inbox for the
alert names so your citation is accurate rather than aspirational.

- [ ] **Step 3: `TC-SEC-016` disclosure — write it, do not run it**

In the inbox, verbatim and unambiguous:

```markdown
### TC-SEC-016 — NOT RUN, NOT CLAIMED

TC-SEC-016 (SSE 10,000 concurrent connections, 1,000 events/s, p95 event lag < 5s) requires
staging infrastructure that neither the execution host nor the review host has. It was not
executed, not simulated and is not claimed passing. This is the same disposition EXECPLAN
DEC-143 already recorded for it under BR-SEND-004.

Consequences:
- BR-SEND-004 (M6) stays partially_closed. Unchanged by this node.
- BR-SEC-005 is proposed partially_closed, for two independent reasons: TC-SEC-016 was not
  run, and its "SLO dashboard va alert ton tai" clause is M7-S3-observability's work.

What it would need: a host able to hold 10,000 concurrent socket.io connections (file-descriptor
limits, ephemeral port range, and enough memory for the per-connection buffers), a load generator
on a separate host so the client is not the bottleneck, and a Redis able to sustain 1,000
pub/sub messages per second to the gateway.

Attribution note: EXECPLAN DEC-143's prose says BR-SEC-005 "belongs to M7-S2-security-hardening".
state.json's M7-S4 success conditions read "BR-SEC-004, BR-SEC-005 closed", so the node
definition and DEC-143 disagree. The node definition is the operative allocation and this node
acted on it. A reviewing session may want a DEC-* correcting DEC-143's sentence. This node did
not edit EXECPLAN.md.
```

---

## Checkpoint 10 — Full verification and node handoff

- [ ] **Step 1: Restore the shared stack**

You have stopped, restarted and rebuilt the primary project. Before the final verification, put it
back the way the other nodes expect:

```bash
docker compose --env-file .env.deploy.local down
pnpm infra:up
COMPOSE_PROJECT_NAME=eow-m7s4-drift docker compose down -v 2>/dev/null || true
COMPOSE_PROJECT_NAME=eow-m7s4-restore docker compose down -v 2>/dev/null || true
docker volume ls | grep eow-m7s4    # must be empty
```

- [ ] **Step 2: Full workspace check, twice, in a quiet window**

```bash
pnpm --filter @eow/api build
pnpm check
pnpm check
```

Compare test **and skip** counts against your CP0 baseline. Skips must be 0.

- [ ] **Step 3: Deployment contract and architecture rules**

```bash
docker compose --env-file .env config --quiet
pnpm --filter @eow/architecture-tests test
```

Confirm `ARCH-DEPLOY-CONTRACT` (yours), `ARCH-MIGRATION`, `ARCH-JOB-WIRING`, `ARCH-RBAC`,
`ARCH-ENCODING`, `ARCH-TEST-HYGIENE` green.

- [ ] **Step 4: Confirm no secret and no dump was committed**

```bash
git log --stat origin/main..HEAD | grep -iE "\.env($|\.)|\.dump|\.sql\.gz" ; echo "exit=$?"
git diff origin/main..HEAD -- . | grep -cE "EOW_(POSTGRES|REDIS|SESSION)[A-Z_]*=[^\s]" 
```

Expected: nothing but a `.gitignore` change; the grep count `0`. AGENTS.md §2: never commit `.env`
or credentials, and an override is a signal to stop.

- [ ] **Step 5: Write the final inbox section**

Status **`ready-for-review`**. Rows to propose:

| rule_id | slice | status | notes |
|---|---|---|---|
| `BR-SEC-004` | M7-S4-deployment-backup | **test_passing** | Backup taken and verified, restore rehearsed in an isolated Compose project, RPO/RTO measured, and — where the targets were missed — a written variance report, which is what the acceptance's "hoặc có biên bản chênh lệch" asks for. `test_case_ids: TC-SEC-004;TC-SEC-015`. |
| `BR-SEC-005` | M7-S4-deployment-backup | **partially_closed** | Restart durability proven with a real `SIGKILL` (`TC-SEND-018`, `TC-SEC-005` first clause). Missing: the "SLO dashboard và alert tồn tại" clause, owned by `M7-S3-observability`; and `TC-SEC-016`, not run for lack of staging infrastructure. State both reasons. |

Fill `deploy_case_ids: DEPLOY-001;…;DEPLOY-010` on both rows, and `log_or_metric_or_audit` with the
readiness endpoint and the backup sidecar.

Also record:

- Both `pnpm check` count sets and the CP0 baseline.
- The per-case `DEPLOY-*` evidence table: case, command, result, evidence file path.
- `D-156` (CI's missing fill, reproduced and fixed) and every other `D-*` from D-156…D-160.
  Expect: `acceptance-tests.md:6`'s "seven long-running services" (six + one-shot);
  `health.service.ts` returning a hardcoded `'ready'` that contradicted `runbook.md:3-4` for the
  whole run; `mailpit` having no healthcheck so `--wait` does not gate on it; `docker compose config`
  without `--quiet` printing secrets; and whatever CP5's log-secret grep found.
- `DEC-161` (readiness as a sibling endpoint, `/health` untouched) and any further decisions
  (DEC-162…165), including the `lockDuration` value and its reasoning.
- The `TC-SEC-016` disclosure block from CP9 verbatim.
- The `BR-SEC-005` citation link to M7-S3's runbook alert set.
- **Migration `037` was reserved and is unused.** Say so explicitly so the reviewing session knows
  the gap is intentional, exactly as `019` is.

- [ ] **Step 6: Commit and push**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S4-deployment-backup.md
git commit -m "M7-S4 CP10: verification complete, ready for review

pnpm check twice: apps/api <F>/<T>, apps/worker <F>/<T>, apps/web <F>/<T>,
packages/architecture-tests <F>/<T>, 0 skipped both runs. CP0 baseline
<...>; no count fell. docker compose config --quiet exit 0. Shared stack
restored; the two isolated projects are torn down with their volumes.

All ten DEPLOY-* cases have real recorded evidence, one file each.

BR-SEC-004 proposed test_passing WITH a written RPO/RTO variance report,
which its acceptance explicitly accepts ('dat muc tieu HOAC co bien ban
chenh lech').

BR-SEC-005 proposed PARTIALLY_CLOSED for two independent reasons: its
'SLO dashboard va alert ton tai' clause is M7-S3's work, and TC-SEC-016
was not run for lack of staging infrastructure -- not run, not simulated,
not claimed.

Migration 037 was reserved and is deliberately unused.

No .env, no dump and no credential is in this branch."
git push -u origin m7-s4-deployment-backup
```

**Do not merge into `main`. Do not rebase onto `main`. Do not delete the worktree.**

---

## DEFERRED UI / VISUAL HANDOFF — not for Codex

Protocol §1.1: this node touches no front-end file and takes no screenshot.

1. **`TC-SEC-005`, `TC-SEC-015` and `TC-SEND-018` are catalogued as `API + UI`.** Only the
   infrastructure and API halves are authored here. The UI half of `TC-SEND-018` — that a campaign
   in flight through a worker restart shows a coherent, non-regressing progress state to a watching
   user — is Playwright work for `M7-S5`. The backend guarantee it would rest on is proven at CP7,
   and `BR-SEND-003`'s "progress counters never decrease" is already closed from M6, so the UI
   assertion has solid ground.

2. **No screen shows deployment or backup state,** and none should — these are operator concerns
   served by `docs/operations/backup-restore.md`, the smoke script and the readiness endpoint. No
   `screen-catalog.yaml` entry was added.

3. **`/health/ready` has no UI surface** and needs none. It exists for the Compose healthcheck and
   for an external monitor.

4. **`screen-catalog.yaml` was not edited**; no `states_covered` was written and no capture was
   taken.
