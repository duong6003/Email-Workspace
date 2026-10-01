# Parallel execution protocol — M7-S1, M7-S2, M7-S3, M7-S4

Written 2026-08-19, after `M6-GATE` closed and was pushed to `origin/main` (`eb5a835`).
Governs the four M7 nodes the human has asked to run concurrently, executed by **Codex**,
reviewed and merged by **Claude** in a later session.

This document supersedes nothing. It is the **second** parallel-execution protocol in this run.
Read [`PARALLEL-EXECUTION-PROTOCOL.md`](PARALLEL-EXECUTION-PROTOCOL.md) (M4-S2/M5-S1/M6-S2) first
and treat it as the foundation: §1 (division of labour), §4 (inbox pattern), §5 (one database),
§6 (what "done" means) and §7.2-§7.4 (merge order, expected conflicts, what must be re-proven)
carry over **unchanged in principle**. This document changes only two things:

- **§2 — the isolation model.** One root clone on the remote machine, with Codex creating its
  own `git worktree` per node. Not four separate clones.
- **§7.1 — what must come back.** Four pushed branches, one per node, from worktrees Codex
  manages itself.

Everything else — reservations, the inbox pattern, one-node-at-a-time merging, independent
re-verification on this machine — is inherited and still binding.

---

## 0. Why this document exists at all

AGENTS.md §2, verbatim:

> Git gives recovery and visibility; it does not give mutual exclusion. When two agents may be
> active, still do not write the same contract, migration or shared config file concurrently —
> both agents share one working tree, so the second write silently wins and the loss is only
> recoverable if the first was already committed.

Four concurrent M7 nodes have a **wider shared-file surface than any previous parallel batch in
this run**. M4-S2/M5-S1/M6-S2 were three feature slices that mostly added new directories. M7 is
hardening: it reaches into `main.ts` of three apps, `compose.yaml`, `.env.deploy.example`,
`env.ts`, `app.module.ts`, `runbook.md`, `ci.yml` and the worker send path — files that already
exist and that more than one node has a legitimate reason to touch. §3 exists to make that
surface disjoint **before** anyone starts, not to discover it at merge time.

---

## 1. Division of labour (set by the human, unchanged from the M4 protocol)

| Who | Owns |
|-----|------|
| **Codex** | All code, migrations, contracts, unit/integration/security/recovery test *authoring*, and the non-visual parts of verification for its assigned node. |
| **Claude** (this machine, a later session) | Post-run review of each node, independent re-verification, all image work, and every merge into the four shared run artifacts (§4). |

### 1.1 Codex does no image work at all — and for M7 that is not a limitation

**HARD CONSTRAINT: none of the four nodes may modify `apps/web/**`, and none may write
`states_covered` in `screen-catalog.yaml`.**

This was checked against the source, not assumed. Each node's `successConditions` in
`state.json` were read directly:

| Node | Visual requirement in its own success conditions? |
|---|---|
| `M7-S1-quota` | **No.** Quota enforcement, threshold event + notification, 429 + Problem body. All backend/contract. |
| `M7-S2-security-hardening` | **No.** Cross-tenant negatives, RBAC/CSRF/session/webhook/injection/rate-limit tests. All API-layer. |
| `M7-S3-observability` | **No.** Logs, traces, metrics, redaction test, runbook alert set. All backend/docs. |
| `M7-S4-deployment-backup` | **No.** `.env`, compose boot, smoke test, DEPLOY-001..010, `pg_dump`/restore, RPO/RTO. All infrastructure. |

The visual sweep is a **separate, later node**: `M7-S5-perf-a11y-visual`, which depends on all
four of these and owns "All 13 screens verified at 1440x900, 768x1024 and 390x844 with axe
clean" and `BR-SEC-006`. It is not in this batch.

Two nodes nevertheless have a natural pull toward the UI, and both are explicitly refused:

- **M7-S1.** `screen-catalog.yaml`'s `UI-CFG-002` (Settings — default sending policy) already
  lists `business_rules: [BR-CFG-006, ...]` and `realtime_events: [quota.threshold_reached]`,
  and its `status` is already `migrated` with all five states captured. Adding a quota surface
  there would invalidate captured evidence Codex cannot re-take.
- **M7-S2.** `TC-SEC-014` (stored XSS) has an `API + UI` layer in `catalog/test-cases.json`.
  Codex authors only the API half.

Each plan therefore ends with a **DEFERRED UI / VISUAL HANDOFF** section naming exactly what
front-end work its rule implies, so the reviewing session can schedule it into `M7-S5` rather
than rediscover it. Codex writes that section as prose; it writes no `apps/web` code and takes
no screenshots.

---

## 2. Isolation model — one root, four Codex-managed worktrees (CHANGED)

The M4 protocol offered four options (A: queued, B: worktrees, C: one shared tree, D: separate
machine) and selected (D) with the condition "one node per clone on the remote machine too".

**Selected 2026-08-19: (D) separate machine, satisfied by (B) git worktrees inside a single
root clone, created and managed by Codex itself.**

The human has pulled `origin/main` into one root clone on a second machine. Codex works there.
This satisfies the M4 protocol's condition 1 ("Either three clones (or three git worktrees)
there, or run them sequentially there") by the worktree route rather than the multi-clone route.

### 2.1 What Codex must do, exactly

From the root clone, on `main`, up to date with `origin/main`:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git worktree add -b m7-s1-quota                ../eow-m7-s1 main
git worktree add -b m7-s2-security-hardening   ../eow-m7-s2 main
git worktree add -b m7-s3-observability        ../eow-m7-s3 main
git worktree add -b m7-s4-deployment-backup    ../eow-m7-s4 main
```

Branch names are fixed and are part of this protocol; the reviewing session looks for exactly
these four names. Worktree *paths* are Codex's choice — `../eow-m7-s1` is a suggestion, and any
path outside the root clone works. Do **not** place worktrees under `.claude/worktrees/` in this
run: that directory already holds an unrelated, uncommitted worktree
(`kind-wozniak-055662`, see `EXECPLAN.md` DEC-144) and mixing them invites a wrong-tree commit.

### 2.2 What each worktree costs, and how to pay it once

A fresh worktree shares `.git` but has **no `node_modules/` and no `.env`** (both gitignored).
Measured during M4-S1 and re-confirmed by `eb5a835`'s commit body ("from a from-scratch pnpm
install in this worktree, previously never bootstrapped"):

- `pnpm install --frozen-lockfile` in each worktree — a few minutes each, unavoidable.
- `.env` must be **copied** from the root clone into each worktree. It is gitignored and holds
  the local PostgreSQL/Redis passwords; without it,
  `apps/api/test/integration/test-database-url.ts` throws
  `EOW_POSTGRES_PASSWORD is not set. Run 'pnpm infra:up' with a local .env first.` and
  `apps/worker/src/test-urls.ts` throws
  `EOW_POSTGRES_PASSWORD is required for worker fixture setup.`
  Copying it is authorised for this batch; committing it is not (AGENTS.md §2).

### 2.3 The consequence this model creates, and its one mitigation

Four worktrees on one machine share **one Docker daemon, one PostgreSQL, one Redis, one Mailpit**
— exactly the "one database, N nodes" hazard of the M4 protocol's §5, which therefore applies in
full and is **not** softened by the worktrees:

- Every added column needs a `DEFAULT`. The running containers execute older code against the
  same schema.
- Integration tests must create and clean their own tenants. Copy the `beforeAll`/`afterAll`
  shape from `apps/api/test/integration/sender-config-http.test.ts` (unique tenant name via
  `randomUUID()`, FK-ordered teardown scoped to `tenant.id`, explicit `30_000` timeout).
- **Do not run the full workspace suite while another node's suite is running.**
  `apps/api/test/integration/boot.test.ts` spawns a real compiled process and times out under
  CPU contention (`EXECPLAN` D-40); `packages/architecture-tests/src/migration-runner-behavior.test.ts`
  starts real `postgres:17-alpine` containers and already produced two transient host-load
  timeouts during `eb5a835` (D-132). Targeted suites during development; **full
  `pnpm check` only in a quiet window, one node at a time.**

**M7-S4 is the sharp exception and needs its own rule.** It runs
`docker compose --env-file .env up -d --build --wait`, `down`, port-conflict simulations,
`pg_dump`/restore and a deliberately-broken-`.env` boot. Every one of those disrupts the shared
stack the other three nodes' integration tests connect to.

> **M7-S4 destructive-stack rule.** Before any checkpoint that starts, stops, rebuilds or breaks
> the Compose stack, M7-S4 must (a) use a **separate Compose project name** where the case allows
> it (`COMPOSE_PROJECT_NAME=eow-m7s4` — mandatory for the restore rehearsal, which
> `docs/deployment/operations.md:24-25` already says must run "in an isolated project name"), and
> (b) where the case genuinely requires the primary project (DEPLOY-002/004/006/007/008/009),
> announce a stack window in its inbox file and run those checkpoints when the other three nodes
> are not executing integration tests. M7-S4's plan marks these checkpoints **[STACK WINDOW]**.

### 2.4 What Codex must NOT do

- **Not merge into `main`.** Not from any worktree, not at any checkpoint.
- **Not rebase onto `main`.** `main` will not move while this batch runs — the only thing that
  will land there before Codex starts is this protocol plus the four plans. Rebasing destroys the
  per-checkpoint history the review depends on.
- **Not merge one node's branch into another's.** The four are independent by construction (§8
  lists the two rule-level couplings, and neither requires code from another branch).
- **Not delete a worktree before its branch is pushed and the human confirms.**

---

## 3. Reservations — allocated up front so nothing has to be renumbered later

Every number in this section was re-derived from the repository at `eb5a835`, not taken on
report. The commands that produced them are given so the reviewing session can re-derive them.

### 3.1 Migration numbers

Verified: `ls database/migrations/` → 32 files, `001_initial.sql` … `033_export_artifact_purge.sql`.
**Highest on `main` is 033.** `019` does not exist (018 jumps to 020 — an intentional, committed
gap from the M4 protocol's own reservation table, and `database/migrations.lock.json` matches, so
`ARCH-MIGRATION` is green with it). Gaps are harmless: `database/migrate.sh` iterates
`database/migrations/*.sql` in filename order.

| Node | Reserved | Expected use |
|------|----------|--------------|
| `M7-S1-quota` | **034** | `quota_reservation` ledger + tenant quota configuration columns. Certain — the ledger does not exist (`apps/api/src/campaigns/campaigns.service.ts:221` and `:783-784` both say so in prose: "no quota ledger exists until M7-S1 (DEC-088)"). |
| `M7-S2-security-hardening` | **035** | `dead_letter_event` table + an attempts ceiling on `outbox_event`. Certain — no DLQ exists anywhere. |
| `M7-S3-observability` | **036** | `outbox_event.trace_id` (nullable, no default needed beyond `NULL`). `001_initial.sql:84-90` has no correlation column, so the API→outbox→job trace hop has no id to carry. Likely, not certain — if M7-S3 finds it can propagate without a column, **leave 036 unused** rather than reassigning it. |
| `M7-S4-deployment-backup` | **037** | Possibly none. Backup/restore is scripts + docs + Compose, not schema. **Leave 037 unused** rather than reassigning it. |

A node needing a **second** migration takes `NNN+30` — **064, 065, 066, 067** — not the next free
number, so a late migration in one node can never collide with an early one in another.

`database/migrations.lock.json` is append-only per node and is the one shared file where a
last-writer-wins loss is *detectable*: `ARCH-MIGRATION`
(`packages/architecture-tests/src/migration-immutability.test.ts:18`) recomputes SHA-256 over every
`database/migrations/*.sql` and requires exact filename-set **and** hash equality with the lock.
If it fails after a merge, re-add the missing entry; never regenerate the file wholesale.

**Never edit a published migration** (AGENTS.md §5). `database/migrate.sh:218-223` enforces this
at deploy time too: a changed checksum aborts with
`Published migration <id> changed; add a forward migration instead.`

### 3.2 Decision and discovery numbers

Verified by scanning `EXECPLAN.md` for every `DEC-\d+` and `\bD-\d+`:
**last used `DEC-144`, `D-139`.** Existing unused gaps (`DEC-066`…`DEC-070`, `D-056`…`D-060`, from
the M4 protocol's M6-S2 reservation) are **left alone** — do not backfill them.

| Node | `DEC-*` | `D-*` |
|------|---------|-------|
| (this protocol + the four plans) | DEC-145 | D-140 |
| `M7-S1-quota` | DEC-146 … DEC-150 | D-141 … D-145 |
| `M7-S2-security-hardening` | DEC-151 … DEC-155 | D-146 … D-150 |
| `M7-S3-observability` | DEC-156 … DEC-160 | D-151 … D-155 |
| `M7-S4-deployment-backup` | DEC-161 … DEC-165 | D-156 … D-160 |

Exceeding a block is fine and expected for M7-S3 (the widest node): take the next free number
*above all four blocks* — **DEC-166+, D-161+** — and say so in the inbox file, rather than
reusing a neighbour's reserved number.

Codex writes these into its **inbox file only** (§4). It does not edit `EXECPLAN.md`.

### 3.3 `contracts/openapi.yaml`

Verified: 65 paths at `eb5a835`. This is the sharpest contention point after the run artifacts,
because it is one flat `paths:` map that every node appends to.

**Reserved prefixes — disjoint by construction, and they must stay so:**

| Node | Owns | Planned operations |
|------|------|--------------------|
| `M7-S1` | `/sending-quota`, `/sending-quota/usage` | `getSendingQuota`, `putSendingQuota`, `getSendingQuotaUsage` |
| `M7-S2` | `/dead-letter-events`, `/dead-letter-events/{deadLetterEventId}`, `/dead-letter-events/{deadLetterEventId}/replay` | `listDeadLetterEvents`, `getDeadLetterEvent`, `replayDeadLetterEvent` |
| `M7-S3` | `/metrics` | `getMetrics` |
| `M7-S4` | `/health/ready` | `getReadiness` (note: `/health` itself already exists at line 54 and is **not** to be modified — add a sibling path, do not restructure the existing one) |

Rules, inherited verbatim from the M4 protocol §3.3:

- Each node edits `contracts/openapi.yaml` **once**, as late as possible (its contract
  checkpoint), and **commits immediately** — not batched with other work.
- Before editing, save a pre-edit copy outside the repo; after editing, prove additive-only:
  `node scripts/openapi-compat-check.mjs <before> contracts/openapi.yaml`.
- `packages/contracts/src/openapi.d.ts` is generated and gitignored. Regenerate with
  `pnpm contracts:generate` after every merge; **never hand-edit**.
- Adding a path or field is allowed; removing or narrowing anything requires a superseding ADR
  (AGENTS.md §5).

### 3.4 `contracts/asyncapi.yaml` — no node edits it

This is a deliberate, checked decision and it removes an entire class of merge conflict.

- **M7-S1** needs `quota.threshold_reached`. It is **already declared** at
  `contracts/asyncapi.yaml:131-135` (`address: quota.threshold_reached`, `$ref` to the shared
  `EventEnvelope`) and already present in `catalog/realtime-events.json` (channel
  `org:{organization_id}`, dedupe `quota_period+threshold`, priority P1). M7-S1 **implements** the
  declared channel; it adds nothing to the contract.
- **M7-S2** does **not** introduce a realtime event for the DLQ. `project.manifest.yaml` freezes
  `realtime_events: 20` and `notification_rules: 16` as reviewed baselines, and
  `packages/architecture-tests/src/asyncapi-conformance.test.ts` asserts
  `catalog/realtime-events.json` and `contracts/asyncapi.yaml` agree. DLQ alerting is a
  **log line + metric + runbook alert**, not a realtime event and not a notification
  (`NOTIFICATION_TRIGGERS` gains no new entry either — `BR-NOT-014`'s trigger catalogue does not
  name a DLQ trigger, and `apps/api/src/notifications/notification-rules.test.ts:32-34` asserts
  that list). Recorded as a decision in M7-S2's plan.
- **M7-S3, M7-S4** emit no realtime events.

**One shared architecture-test file is nonetheless touched, by M7-S1 only:**
`packages/architecture-tests/src/asyncapi-conformance.test.ts`, whose `ENVELOPE_SOURCES`
allow-list (lines 28-34) enumerates the five files permitted to build envelopes. M7-S1's new
publisher must be appended there or the conformance check will not see it. **No other node
appends to that list.**

### 3.5 Naming conflict M7-S1 must resolve, not paper over

Two names for one concept already exist on `main`:

| Source | Name |
|---|---|
| `contracts/asyncapi.yaml:132`, `catalog/realtime-events.json` | `quota.threshold_reached` |
| `apps/api/src/notifications/notification-rules.ts:37` | `sourceEvent: 'quota.threshold'` (with `type: 'quota_threshold'`, `severity: 'warning'`, `category: 'quota'`, `wired: false`, `owner: 'M7'`) |

The contract wins: the emitted `event_type` is **`quota.threshold_reached`**, because
`ARCH-ASYNCAPI-CONFORMANCE` matches every emitted event type against a declared channel and would
fail on `quota.threshold`. M7-S1 updates the `NOTIFICATION_TRIGGERS` entry's `sourceEvent` to
`quota.threshold_reached` and flips `wired` to `true` when it wires it, and records the change as
a `DEC-*` in its inbox. `apps/api/src/notifications/notification-rules.test.ts` will need its
BR-NOT-014 assertion updated in the same commit.

### 3.6 Other shared source files

Ownership is exclusive unless the row says otherwise. "Append only" means: add at the end of the
existing list/object, never reorder or reformat neighbouring entries — that is what makes a
same-file merge resolve as "keep both sides".

| File | Who touches it | Rule |
|------|----------------|------|
| `apps/api/src/app.module.ts` | M7-S1 (`QuotaModule`), M7-S2 (`DeadLetterModule`), M7-S3 (`ObservabilityModule`) | Append the import + the `imports: []` entry only. Never reorder existing entries. Expected 3-way merge; resolution is always "keep all sides". |
| `apps/api/src/config/env.ts` | M7-S1, M7-S3, M7-S4 | Append new keys **inside** the `z.object({...})`, immediately above its closing `});`, each with the doc-comment style the file already uses (rule id + why the default is that number). Never reorder. |
| `apps/api/src/common/permissions.ts` | **M7-S2 only** | Appends one key for DLQ inspect/replay. M7-S1 reuses the existing `SETTINGS_MANAGE`; M7-S3's `/metrics` and M7-S4's `/health/ready` are `@Public()`. A new permission key also needs a seed/grant row — take it in your **own** reserved migration (035), never in a shared one. |
| `apps/api/src/main.ts` | **M7-S3 only** | OTel/pino bootstrap must be the **first import**, above `import 'reflect-metadata';`. |
| `apps/worker/src/main.ts` | M7-S3 (first-line instrumentation import; job-result metric emission) **and** M7-S4 (BullMQ `Worker` option objects: `attempts`, `backoff`, `lockDuration`, `maxStalledCount`) | The only two-owner source file in the batch. Kept tractable by separation in the file: M7-S3 touches line 1 and the `switch` arms' return handling; M7-S4 touches the three `new Worker(..., { connection, concurrency })` option objects at lines ~126/135/144. Expected conflict, mechanically resolvable. **Neither node reformats the file.** |
| `apps/scheduler/src/main.ts` | M7-S3 (first-line instrumentation import) **and** M7-S4 (`queue.add` job options) | Same shape as above; same rule. |
| `apps/worker/src/campaign-send/send.ts` | **M7-S1 only** | The quota gate goes in the per-recipient loop (lines 140-160), beside the existing `dailyRemaining <= 0` and `checkRateLimits(...)` gates. M7-S3 must not add metric call sites here — see the next row. |
| `apps/worker/src/campaign-send/run.ts` | **M7-S3 only** | `eow_send_attempt_total{result}`, `eow_send_retry_total` and `eow_provider_reject_total` are emitted here from the `SendBatchOutcome` (`{submitted, retrying, failed}`) that `sendClaimedBatch` already returns at `run.ts:79`, **not** from inside `send.ts`. This is what keeps M7-S1 and M7-S3 out of the same file. |
| `apps/worker/src/outbox-relay.ts` | **M7-S2 only** | Its permanent-failure path is a real defect M7-S2 owns (§8.3). |
| `apps/api/src/health/**` | **M7-S4 only** | |
| `apps/api/src/common/http-exception.filter.ts` | **M7-S3 only** | Replaces the `console.error` at line 29 with a structured, redacted log line. M7-S1 needs **no** edit here: `TooManyRequestsException` and its `Retry-After` header already exist (`too-many-requests.exception.ts`, filter lines 32-34) and `mapErrorToProblem` already carries a `code` extension through `extensionsFrom`. |
| `compose.yaml`, `.env.deploy.example`, `docs/deployment/environment-variables.md` | M7-S3 (its own new variables) **and** M7-S4 (deployment work) | Each appends its own variables in **one late commit**, in the same order in all three files, and says so in its inbox. Expected conflict in the services' `environment:` blocks; resolution is always "keep both sides". AGENTS.md §2's one-command-deployment clause means all three files change **together** or not at all. |
| `docs/operations/runbook.md` | **M7-S3 only** | The alert set with thresholds is M7-S3's success condition. M7-S4's `BR-SEC-005` "SLO dashboard and alert tồn tại" **cites** it — see §8.2. |
| `docs/operations/security-baseline.md` | **M7-S2 only** | |
| `docs/deployment/*.md`, `docs/operations/runbook.md`'s backup section, `.github/workflows/ci.yml`, `Dockerfile`, `deploy/**`, root `package.json` scripts | **M7-S4 only** | |
| `docs/adr/` | Any node may **add** a new ADR. No node edits an Accepted one (AGENTS.md §5); add a superseding ADR instead. `adr-017-observability.md` is Accepted and already names "Pino structured logs + OpenTelemetry traces/metrics" — M7-S3 **implements** it and does not supersede it. |
| `apps/web/**`, `apps/web/e2e/visual-capture.spec.ts` | **NOBODY** | Hard constraint, §1.1. |
| `packages/architecture-tests/src/asyncapi-conformance.test.ts` | **M7-S1 only** | `ENVELOPE_SOURCES` append, §3.4. |
| `packages/architecture-tests/src/*` (new files) | Each node adds its **own new** rule file. No node edits another's. Expect: M7-S2 → a cross-tenant-coverage rule; M7-S4 → a deployment-contract rule (see §8.4). |
| `vitest.shared.ts` | **NOBODY** | If a node believes it needs a timeout change, it says so in its inbox and stops. |

---

## 4. The four shared run artifacts — inbox pattern, unchanged

`state.json`, `traceability.csv`, `screen-catalog.yaml` and `EXECPLAN.md` are written by *every*
node at *every* checkpoint, and are the four files whose corruption is hardest to see. M4-S1's
checkpoint 6 shifted three CSV columns so `status` silently read blank while the commit claimed
`closed`, and nothing caught it because nothing parsed the file (`EXECPLAN` D-42).

**Codex must not write these four files directly.** Each node appends to its own file:

```
.agents/runs/2026-08-10-eow-master-execplan/inbox/<node-id>.md
```

where `<node-id>` is exactly `M7-S1-quota`, `M7-S2-security-hardening`, `M7-S3-observability`,
`M7-S4-deployment-backup`. One section per checkpoint, in the shape
`inbox/M5-S1-sender-config.md` already uses:

```markdown
## Checkpoint N — <name>
**Status after this checkpoint:** running | blocked | ready-for-review
**nextAction:** <one line>

### Evidence (verbatim, for state.json)
- <one bullet per claim, each independently re-runnable by someone else>
- <include the exact command and the exact counts it printed>

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|

### screen-catalog.yaml changes
<screen/overlay id, fields to set — never `states_covered`; that is Claude's>

### EXECPLAN entries
- D-NNN: <discovery>
- DEC-NNN: <decision | rationale | alternative rejected>
```

`inbox/` is committed, not scratch. It is deleted only after its node's evidence has been merged
and the node is terminal.

**A node is never marked `completed` by Codex.** `state.json`'s four M7 node statuses stay
`pending` until a reviewing Claude session has merged the inbox, re-verified on this machine and
set them itself.

---

## 5. One database, four nodes

Inherited in full from the M4 protocol §5, plus the M7-S4 destructive-stack rule in §2.3 above.
The three rules that matter most here, restated because M7 will test them harder:

1. Every added column needs a `DEFAULT` (or is nullable). Running containers execute older code.
2. Integration tests create and clean their own tenants, using `testDatabaseUrl()` /
   `testAppDatabaseUrl()` from `apps/api/test/integration/test-database-url.ts` and
   `testOwnerDatabaseUrl()` / `testAppDatabaseUrl()` from `apps/worker/src/test-urls.ts`.
   `ARCH-TEST-HYGIENE` enforces this — hardcoded connection strings fail the build.
   Test against the **`eow_app` role**, not the owner: testing as owner silently bypasses RLS and
   would pass a missing `GRANT` (`EXECPLAN` D-51).
3. No two nodes run `pnpm check` simultaneously.

Prerequisite in every worktree, once: `pnpm install --frozen-lockfile`, copy `.env`, then
`pnpm infra:up` (`docker compose up -d postgres redis mailpit --wait`). Migrations must already
be applied — the Compose `migrate` service does it, or run `database/migrate.sh`.

---

## 6. What "done" means for a node under this protocol

Unchanged from the M4 protocol §6, with one addition. A node reaches `completed` only when
**Claude, on this machine,** has:

1. Merged its inbox evidence into the four shared artifacts.
2. **Re-run the verification independently** — not trusted the inbox's claims. M4-S1's two most
   serious defects were both found this way, in work that self-reported as passing.
3. Run and individually inspected any visual capture the node's rules require. *(For this batch:
   none — §1.1. The deferred-UI sections are read and scheduled into M7-S5 instead.)*
4. Confirmed `validate_plan.py` is clean. Current baseline at `eb5a835`: **ERRORS 0, WARNINGS 1**
   (the known D-133 blank-`log_or_metric_or_audit` warning over 34 pre-M7 rows). A second warning
   or any error is a regression.
5. Confirmed the full workspace suite twice, comparing test **and skip** counts.
6. **(new)** Confirmed `docker compose --env-file .env config --quiet` still exits 0 for any node
   that touched ports, env vars, migrations, startup or static assets — i.e. M7-S3 and M7-S4 at
   minimum. See §8.4 for the pre-existing failure this will surface.

Codex reporting "done" is an input to that judgement, not the judgement.

**Baseline test counts to beat.** From `eb5a835`'s own commit body (the most recent measured
numbers, and more current than `M6-GATE-HANDOFF.md`'s):

| Package | Files | Tests | Source |
|---|---|---|---|
| `apps/api` | 89 | 644 | `eb5a835` commit body |
| `apps/worker` | 30 | 143 | `eb5a835` commit body |
| `packages/architecture-tests` | **16** | **119** | **measured on the review machine at `eb5a835`, 2026-08-19** — supersedes that commit body's 15/114, which was measured in a worktree and disagrees. `M6-GATE-HANDOFF.md` also says 16/119. |
| `apps/web` | 23 | 73 | `M6-GATE-HANDOFF.md`; not re-measured in `eb5a835` |

That the `architecture-tests` row needed correcting is itself the point: two recorded numbers for
the same package at the same commit disagreed, and only re-running settled it. These numbers are
**not** to be trusted as-is. Every node's **checkpoint 0** is to run
`pnpm check` once in its own freshly-installed worktree and record what it actually printed. That
number, not this table, is the node's baseline. `apps/api` requires
`pnpm --filter @eow/api build` once before its suite, because `boot.test.ts` spawns the real
compiled process.

Skipped tests are not merely discouraged — `scripts/no-skipped-tests-reporter.mjs` **fails the
run** on any skipped test, so `.skip`/`.todo` is not available as an escape hatch.

---

## 7. Bringing the work back (CHANGED — worktree branches, not clones)

### 7.1 What must come back

**Four pushed branches on `origin`, one per node**, with per-checkpoint commits intact and each
node's `inbox/<node-id>.md` committed:

```bash
# from inside each worktree, when the node is finished or stopped at a checkpoint
git push -u origin m7-s1-quota
git push -u origin m7-s2-security-hardening
git push -u origin m7-s3-observability
git push -u origin m7-s4-deployment-backup
```

- **One branch per node.** Never a branch carrying two nodes' work.
- **Never merged into `main` from Codex's side, never rebased onto `main`.**
- **Not** a zip, not a folder of changed files, not `git format-patch` unless a push is
  impossible — the per-checkpoint history is what makes review possible, and it is what lets the
  reviewing session bisect a red suite to a single checkpoint.
- A node that stops mid-way still pushes. Its last inbox section must say `running` (not
  `ready-for-review`) with an honest `nextAction`. AGENTS.md §2: never leave a node `running`
  when you stop working without checkpointing what is done and what is not.

### 7.2 Merge order — one at a time, order not fixed

**Changed from the M4 protocol.** There, `M4-S2-audience` had to merge first because
`M4-S3 → M4-S4 → M4-GATE` all waited on it. Here, all four nodes have `dependsOn: ["M6-GATE"]`
and nothing between them: `M7-S5-perf-a11y-visual` and `M7-GATE` wait on all four equally.

So there is **no mandatory order**. What is mandatory is unchanged:

> **Merge one node at a time, fully verifying each before starting the next. Never merge two and
> verify once.** If the suite goes red, the whole point is to know which branch did it.

A reasonable order, if the reviewer wants one, is by blast radius ascending —
`M7-S1` → `M7-S2` → `M7-S4` → `M7-S3` — because M7-S3 touches the most shared files and is
cheapest to rebase-resolve last. That is a convenience, not a rule.

### 7.3 Expected conflicts, and how each resolves

| File | Conflict | Resolution |
|------|----------|-----------|
| `database/migrations/` | None if 034/035/036/037 were honoured — distinct filenames | If two branches created the same number, the **second to merge renames its file** to its reserved number and re-applies; never edit the already-merged one. |
| `database/migrations.lock.json` | Near-certain — up to four branches each add one key to one JSON object | **Keep every line from every side**, then re-run `ARCH-MIGRATION`; it recomputes and says plainly if a checksum is wrong. |
| `contracts/openapi.yaml` | Possible, low — the four reserved prefixes land in different regions | Keep all additions. Then re-run `node scripts/openapi-compat-check.mjs <pre-merge main copy> contracts/openapi.yaml`; a merge that silently dropped one node's paths shows up as a **missing operation**, not as a conflict marker. |
| `contracts/asyncapi.yaml` | **None by construction** (§3.4) | — |
| `packages/contracts/src/openapi.d.ts` | None — gitignored | Regenerate with `pnpm contracts:generate` after every merge. Never hand-resolve. |
| `apps/api/src/app.module.ts`, `apps/api/src/config/env.ts`, `apps/api/src/common/permissions.ts` | Append-only collisions | Keep all sides; these are lists. Then `pnpm typecheck`. |
| `apps/worker/src/main.ts`, `apps/scheduler/src/main.ts` | **Likely** — the only genuinely two-owner source files (§3.6) | Keep both sides: M7-S3's instrumentation import at the top, M7-S4's `Worker`/`queue.add` option objects below. Then `pnpm --filter @eow/worker test` and check `ARCH-JOB-WIRING` (`job-wiring.test.ts`) is still green — it asserts the worker's handled job-name set equals the scheduler's enqueued set. |
| `compose.yaml`, `.env.deploy.example`, `docs/deployment/environment-variables.md` | **Likely** — M7-S3 and M7-S4 both append variables | Keep both sides in all three files, in the same order in each. Then `docker compose --env-file .env config --quiet` and re-read §8.4. |
| `apps/api/src/config/env.ts` + the three files above | A variable added to `compose.yaml` but not `env.ts` boots a half-configured container | After the merge, confirm every new `EOW_*` in `.env.deploy.example` has a matching Compose mapping **and** a matching `env.ts` key. |
| `inbox/*.md` | **None by construction** — each node writes only its own file | This is why the inbox pattern matters more under worktrees, not less. |
| `state.json`, `traceability.csv`, `screen-catalog.yaml`, `EXECPLAN.md` | **None, if the protocol was followed** — Codex never touched them | Claude merges each node's inbox into them here, after that node's verification passes. |

### 7.4 What must be re-proven on this machine, not trusted from theirs

Their evidence was produced against a **different database and a different host**. Every one of
these is unverified here until re-run locally:

- **Migrations apply forward and re-run idempotently** against *this* PostgreSQL, which already
  has 001-033 applied and real M1-M6 data in it. A migration clean on an empty database can still
  fail on a populated one; that is the interesting case, and only this machine has it.
- **The full workspace suite**, twice, comparing test **and skip** counts against the checkpoint-0
  baseline each node recorded in its own inbox.
- **`validate_plan.py`**: ERRORS 0, WARNINGS 1 (§6.4).
- **`docker compose --env-file .env config --quiet`** and the one-command deployment contract.
- **M7-S4's DEPLOY-* evidence specifically.** Container health, volume persistence, port-conflict
  messages and restore timings are host-specific. `docs/deployment/acceptance-tests.md:16-17`
  already says DEPLOY-002/004/006/007/009 "require a real Docker runtime and are release
  evidence". Re-run them here.
- **M7-S3's redaction test specifically.** A test that greps captured log output for secrets is
  exactly the kind that passes vacuously if the capture wired up wrong. Re-run it and check it
  fails when a secret is deliberately introduced.

A node's rules do not flip to `closed` until its re-verification passes **here**.

---

## 8. Findings from writing this protocol that change what the nodes must do

These were discovered while reconciling `state.json`, `traceability.csv`, the catalogs and the
source at `eb5a835`. Each is carried into the plan it affects. They are recorded here because
they cross node boundaries and a single plan is the wrong place for them.

### 8.1 `TC-SEC-016` belongs to M7-S4, not M7-S2

`traceability.csv` maps `TC-SEC-016` (SSE 10,000 connections) to two rules: `BR-SEND-004`
(M6, `partially_closed`) and `BR-SEC-005` (M7, `not_started`). `state.json` allocates
`BR-SEC-005` to **`M7-S4-deployment-backup`** ("BR-SEC-004, BR-SEC-005 closed").

`EXECPLAN.md`'s `DEC-143` says `BR-SEC-005` "belongs to `M7-S2-security-hardening`". **That is a
slip in DEC-143's prose**, contradicted by the node definition it cites. The node
`successConditions` in `state.json` are the operative allocation, so:

- **`TC-SEC-016` is M7-S4's**, and M7-S4's plan owns it.
- The substance of `DEC-143` is unaffected: the case needs staging infrastructure (10,000
  concurrent connections, 1,000 events/s) that neither this host nor the remote one has, so
  `BR-SEND-004` stays `partially_closed` and `BR-SEC-005` closes on its other evidence with
  `TC-SEC-016` disclosed as not run. M7-S4's plan says exactly this and does not fake it.
- A reviewing session should record a short `DEC-*` correcting DEC-143's attribution.

### 8.2 Two rules close across two nodes each — this is expected, not a protocol violation

The four nodes are independent **in code**. Two of their **rules** are not.

| Rule | Half owned by | Other half owned by | Consequence |
|---|---|---|---|
| `BR-SEC-003` (PII) | **M7-S2** — response/error-payload safety, export expiry, injection/XSS: `TC-SEC-003` (API surface), `TC-CFG-008`, `TC-SEC-013`, `TC-SEC-014` | **M7-S3** — the log-redaction half. `traceability-plan.yaml:293` names it: *"a redaction test asserting recipient custom values and email bodies never appear in logs"*. There is no logger on `main` to redact, so M7-S2 **cannot** write that test. | After M7-S2 merges alone, `BR-SEC-003` is `partially_closed`. It becomes `closed` only after M7-S3 also merges. |
| `BR-SEC-005` (Availability) | **M7-S4** — worker-restart durability, `TC-SEND-018`, `TC-SEC-005`, and `TC-SEC-016`'s disclosure | **M7-S3** — "SLO dashboard và alert tồn tại". The alert set with thresholds is M7-S3's own success condition and lives in `docs/operations/runbook.md`, which M7-S3 owns exclusively (§3.6). | Same shape: `partially_closed` after M7-S4 alone, `closed` after both. |

Each affected plan states this in its own scope section so Codex does not claim a closure it
cannot support, and each writes `partially_closed` (never `closed`) into its inbox's
traceability rows for these two rules.

`eow_quota_usage_ratio` is the mirror case in the other direction: `traceability-plan.yaml:292`
lists it under `BR-CFG-006` (M7-S1), but the metric **registry** is M7-S3's. Resolution: **M7-S1
emits it** using the existing log-payload metric precedent
(`apps/worker/src/progress-metrics.ts` — an exported pure function returning
`{metric: 'eow_...', ..., value: n}`), which requires nothing from M7-S3. M7-S3 wires it into the
real registry after both branches merge, as a follow-up, and its plan lists it as explicitly
out of scope.

### 8.3 A real defect M7-S2 inherits: the outbox relay's poison-event loop

`apps/worker/src/outbox-relay.ts:35-38` and `:65-68`, both paths:

```ts
} catch {
  await pool.query(`SELECT relay_mark_outbox_attempt($1)`, [row.id]);
  throw new Error(`Unable to publish import outbox event ${row.id}.`);
}
```

It increments `outbox_event.attempts` and **rethrows immediately, aborting the rest of the
batch**. `published_at` stays `NULL`, so `relay_pending_outbox_events()` re-selects the row on the
next tick — forever. There is no attempts ceiling, no dead-letter transition and no alert. A
single poison event blocks every event behind it, silently.

This is squarely `BR-SEC-007`'s acceptance ("DLQ có alert, inspect và replay có kiểm soát") and
M7-S2 owns it. It is a genuine bug, not a hypothetical, and M7-S2's plan opens with a RED test
that reproduces it.

### 8.4 A real defect M7-S4 inherits: CI's `.env` fill is missing a required variable

Reproduced on this machine at `eb5a835`, not inferred:

```
error while interpolating services.migrate.environment.EOW_POSTGRES_APP_PASSWORD:
required variable EOW_POSTGRES_APP_PASSWORD is missing a value: Set EOW_POSTGRES_APP_PASSWORD in .env
```

`.github/workflows/ci.yml` copies `.env.deploy.example` and `sed`-fills **three** secrets
(`EOW_POSTGRES_PASSWORD`, `EOW_REDIS_PASSWORD`, `EOW_SESSION_SECRET`), then runs
`docker compose --env-file .env config --quiet`. But `.env.deploy.example:10` leaves
`EOW_POSTGRES_APP_PASSWORD` blank and `compose.yaml` requires it at lines 56, 75, 117, 118 and
153 with `${...:?}` — which errors on **blank as well as unset**. CI's last step fails.

Two things follow, and M7-S4's plan does both:

1. **This is DEPLOY-001 working correctly.** "Blank required secret → Compose fails before
   container startup and names the variable" is exactly the observed behaviour. M7-S4's
   DEPLOY-001 checkpoint captures this as evidence rather than treating it as an obstacle.
2. **CI is nonetheless broken and M7-S4 fixes it** — it owns `.github/workflows/ci.yml`
   exclusively (§3.6) — by adding the fourth `sed` line.

### 8.5 What `state.json`'s M7-S1 success condition asserts, and where it actually comes from

M7-S1's success condition reads: *"Tenant sending quota enforced; 80/90/100 percent thresholds
emit quota.threshold_reached and a notification"*. `BR-CFG-006`'s **own** acceptance text in both
`catalog/ba-rules.json` and `traceability.csv` says only: *"Không oversubscribe khi nhiều campaign
song song; reservation được release khi cancel."* — no thresholds at all.

Three sources were checked to settle where the threshold requirement is authoritative:

| Source | Says |
|---|---|
| `catalog/ba-rules.json` → `BR-CFG-006` | statement: *"Mỗi sender/tenant có quota và rate limit cấu hình; quota được kiểm khi review và thực thi."* acceptance: no thresholds. |
| **`catalog/realtime-events.json`** | `{"event": "quota.threshold_reached", "channel": "org:{organization_id}", "purpose": "Configured 80/90/100 percent sending quota threshold", "cadence": "Per threshold", "dedupe": "quota_period+threshold", "priority": "P1"}` — **this is where 80/90/100 is written down.** |
| `apps/api/src/notifications/notification-rules.ts:37` | `{ sourceEvent: 'quota.threshold', type: 'quota_threshold', severity: 'warning', category: 'quota', wired: false, owner: 'M7' }` — the notification half, pre-registered as M7's. |
| `contracts/asyncapi.yaml:131-135` | the channel is declared, unimplemented. |

**Correction to the framing this batch was commissioned under:** the thresholds are **not** in
`catalog/notification-rules.json`. That file holds sixteen `BR-NOT-*` prose rules with no
`trigger`/`wired`/`owner` fields at all; only `BR-NOT-014` mentions quota, and only as
*"…and quota thresholds have explicit trigger definitions"*. The `wired:false, owner:'M7'`
registry the framing referred to is **source code** — `apps/api/src/notifications/notification-rules.ts` —
and the 80/90/100 numbers are in **`catalog/realtime-events.json`**.

The requirement is real and catalogued either way, so **M7-S1's scope is unchanged**: it
implements both `BR-CFG-006`'s own acceptance (no oversubscription under concurrency; release on
cancel) **and** the threshold event + notification. M7-S1's plan cites
`catalog/realtime-events.json` as the threshold authority so the next reader does not repeat this
reconciliation.

### 8.6 The 17 `TC-SEC-*` cases do not all belong to M7-S2

M7-S2's success condition says *"TC-SEC-* (17 cases) executing"*. Mapped against
`traceability.csv` row by row, the 17 cases fall to five different owners:

| Case | Rule(s) | Owner | Current status |
|---|---|---|---|
| TC-SEC-001 | BR-SEC-001 | **M7-S2** | not_started |
| TC-SEC-002 | BR-SEC-002 | M1 | **closed** |
| TC-SEC-003 | BR-SEC-003 | **M7-S2** (+ M7-S3 log half) | not_started |
| TC-SEC-004 | BR-SEC-004 | **M7-S4** | not_started |
| TC-SEC-005 | BR-SEC-005 | **M7-S4** | not_started |
| TC-SEC-006 | BR-SEC-006 | M7-S5 | not_started |
| TC-SEC-007 | BR-SEC-007 | **M7-S2** | not_started |
| TC-SEC-008 | BR-SEC-008 | M1 | **waived** |
| TC-SEC-009 | BR-GEN-002, BR-AUTH-004 | M1 | **closed** |
| TC-SEC-010 | BR-SEC-007 | **M7-S2** | not_started |
| TC-SEC-011 | BR-SEC-006 | M7-S5 | not_started |
| TC-SEC-012 | BR-AUTH-005 | M1 | **closed** |
| TC-SEC-013 | BR-SEC-001, BR-SEC-003 | **M7-S2** | not_started |
| TC-SEC-014 | BR-TPL-006 (M3, closed), BR-SEC-003 | **M7-S2** (BR-SEC-003 half) | not_started |
| TC-SEC-015 | BR-SEC-004 | **M7-S4** | not_started |
| TC-SEC-016 | BR-SEND-004 (M6, partial), BR-SEC-005 | **M7-S4** (§8.1) | not_started |
| TC-SEC-017 | BR-HIS-003, BR-HIS-007 | M6 | **closed** |

So M7-S2 owns **six** (001, 003, 007, 010, 013, 014) plus `TC-CFG-008`; M7-S4 owns four (004,
005, 015, 016); M7-S5 owns two (006, 011); four are already closed and one is waived.

A reviewing session should record a `DEC-*` restating M7-S2's success condition as
*"the six TC-SEC-* cases M7-S2's three rules own are executing; the remaining eleven are
allocated to M7-S4, M7-S5, or already terminal"* — the same correct-the-stale-condition-text
precedent M4-GATE, M5-GATE and M6-GATE (DEC-143) all set. Codex does **not** make that edit;
it records the finding in its inbox.

### 8.7 `TC-SEND-018` is co-owned; one node authors it

`TC-SEND-018` (worker restart, no lost/duplicate job) maps to `BR-SEC-005` (M7-S4) **and**
`BR-SEC-007` (M7-S2). To keep one test file with one owner:

- **M7-S4 authors it**, because its dimension is a real process restart and M7-S4 is the node
  with the Compose stack in hand.
- **M7-S2 does not write a restart test.** Its `BR-SEC-007` evidence is `TC-SEC-007` (replay does
  not change counts) and `TC-SEC-010` (DLQ replay is idempotent), which are DLQ-level and
  independent of process lifecycle.
- Both inbox files cite `TC-SEND-018`; only M7-S4's names a `test_files` path for it.
