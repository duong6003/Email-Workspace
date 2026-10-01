# M6-S4 History Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking. This plan follows the same
> shape as `M6-S3-HISTORY-RECOVERY-PLAN.md`: RED before GREEN in every task,
> one commit per checkpoint, evidence before status.

**Goal:** Close `BR-HIS-006` — a scheduled, audited, tenant-configurable purge of
detailed message events (`message_attempt`, `delivery_event`) that provably does
not change any aggregate report.

**Architecture:** A new `retention_policy` table (one row per tenant, absent row =
env default) plus two SECURITY DEFINER functions in migration `032`: a bounded
cross-tenant scan that returns only tenants whose oldest event is already past
their own effective window, and a bounded purge that deletes past-cutoff rows and
returns exact counts. The worker runs both from a new `history-purge-scan` job on
the existing scheduler tick, writing one `audit_log` row per tenant per run that
actually deleted something. A new API module exposes `GET/PUT /retention-policy`
behind `settings:manage`. Nothing else is deleted: `campaign`,
`campaign_execution`, `campaign_snapshot` and `campaign_recipient` are untouched,
which is what keeps the aggregate report byte-identical across a purge.

**Tech Stack:** PostgreSQL 16 (RLS, SECURITY DEFINER boundary functions, plpgsql),
NestJS 11 + TypeORM + Zod (API), BullMQ + node-postgres (worker/scheduler),
Vitest (all layers), `packages/architecture-tests` (mechanical conventions).

---

## 0. Read this before touching anything

Everything in this section was verified against the working tree during planning.
Do not re-derive it; do not assume the opposite.

### (a) The next migration number is **032**, not 031

`database/migrations/` currently ends at `030_campaign_snapshot_lineage_immutability.sql`.
`031` is **already claimed** by the open background task `task_fc02ed64` (D-127),
which is working in a *separate git worktree*:

```text
.claude/worktrees/reverent-wiles-aa8740   branch claude/reverent-wiles-aa8740
(still at 9843e6e, nothing committed yet)
  M  apps/worker/src/progress-reconcile.ts
  M  database/migrations.lock.json
  ?? apps/worker/src/progress-reconcile-scan-order.integration.test.ts
  ?? database/migrations/031_reconcile_scan_newest_first.sql
```

Two consequences, both binding:

1. This node's migration is `032_history_retention.sql`.
2. **Do not touch `apps/worker/src/progress-reconcile.ts` or
   `apps/worker/src/progress-reconcile.integration.test.ts`.** That file is
   another agent's live work in a shared checkout; AGENTS.md §2's "do not write
   the same file concurrently" applies.

Re-check that worktree at CP0 with
`git -C .claude/worktrees/reverent-wiles-aa8740 status --porcelain`. If that
session has since committed and merged `031`, this node still uses `032` —
migration numbers are never reused, only advanced.

### (b) `message_attempt` and `delivery_event` deliberately have **no DELETE grant**

`026_campaign_execution.sql`: `GRANT SELECT, INSERT ON TABLE message_attempt TO eow_app;`
`027_delivery_events.sql`: `-- Append-only: no UPDATE, no DELETE grant. A correction is a new event row.`

So the purge cannot be an ordinary `DELETE` inside a tenant transaction the way
`notifications.service.ts`'s `purgeExpired()` is. It runs through a SECURITY
DEFINER function (§3.2) and `eow_app` never receives DELETE on either ledger.
This is a decision, not an accident — record it as `DEC-140` at CP1.

### (c) `campaign_snapshot` cannot be deleted at all

`campaign_snapshot_immutable()` (022/023, last replaced by `030`) raises on
`TG_OP = 'DELETE'`: *"Campaign snapshots are immutable and cannot be deleted"*.
Any design that purges snapshots needs an ADR superseding M4-S4's immutability.
This node does not go there — it is explicitly out of scope (§1).

### (d) The aggregate report does **not** recompute from detail rows

`apps/api/src/campaigns/history-query.ts:108` (`buildHistoryProgressSql`) reads the
stored `028` counters straight off `campaign_execution` joined to
`campaign_snapshot`, with its own comment: *"read from the stored 028 summary
(never recomputed)"*. `campaigns.service.ts:445` (`getCampaignProgress`) reads the
same mirror. Only `readProgressFacts`
(`apps/api/src/campaigns/progress-snapshot.ts:33`) counts from
`campaign_recipient`, and it serves the send/reconcile paths, not history
reporting.

That is exactly why the purge scope in §1 is safe: deleting `message_attempt` and
`delivery_event` rows cannot move a single number on a history list, a progress
drawer, or an export's status column. A2 turns this into a test rather than a
claim.

### (e) The reconcile window is 7 days; this purge's hard floor is 30 days

`reconcilable_campaign_executions()` (`028_progress_counters.sql:42-54`) returns
only executions that are `status='sending'` or finished within 7 days.
`purge_message_events()` refuses any cutoff newer than `now() - interval '30 days'`
(§3.2). The two windows cannot overlap, so a purge can never race the
reconciliation of a live campaign. The floor lives *inside the database function*,
so a wrong caller — including a future one — cannot delete recent evidence.

### (f) There is no tenant settings table to extend, and no approved screen to put this on

The only per-tenant configuration tables are `sender_config`, `sending_policy`
(one row per tenant, `UNIQUE (tenant_id)`) and `notification_preference`. There is
no generic `tenant_config`. `sending_policy` is the backing row of the approved
screen `UI-CFG-002` ("Settings — default sending policy",
`.agents/runs/2026-08-10-eow-master-execplan/screen-catalog.yaml:510`), and the
catalog records that the handoff's Settings component has only
sender-config/default-policy tabs.

So: a new `retention_policy` table (§3.1), API-only configuration, and **no new
screen**. Adding one would drift from the approved handoff, which
`packages/architecture-tests/src/handoff-fidelity.test.ts` guards.

### (g) `audit_log` accepts a system actor and is append-only

`001_initial.sql:91-95`: `actor_id uuid` (nullable), `action`, `entity_type`,
`entity_id`, `trace_id text NOT NULL`, `metadata jsonb NOT NULL DEFAULT '{}'`.
`005_audit_log_immutability.sql` rejects UPDATE and DELETE on every row.
`apps/worker/src/progress-reconcile.ts:144-148` is the established system-actor
shape: `actor_id = NULL`, a synthetic `trace_id`, everything else in `metadata`.

Because purged rows are gone forever, this audit row is the *only* remaining
evidence of what was deleted. That is why it carries counts, cutoff, the retention
value used, and where that value came from (§3.4).

### (h) The live docker worker shares this database with host-run tests (D-118), and after this node it also purges

`apps/worker`'s integration tests run host-side against the same PostgreSQL the
docker `worker`/`scheduler` containers poll (`eow` on 127.0.0.1:55432). Once this
node ships and those containers are rebuilt, the live worker will purge *any*
tenant's past-cutoff events, including fixtures a test just created.

Test discipline that follows, and that every test in this plan obeys:

- Assertions of the form "this row still exists" may only be made about rows
  **newer than the 30-day floor**. No policy value can reach them.
- Assertions of the form "this row is gone" are made only against the test's own
  tenant id, immediately after the test itself called the purge.
- Never assert a global count of `message_attempt`/`delivery_event`.

### (i) `apps/worker`'s suite has a known, disclosed, pre-existing 2-test failure

`progress-reconcile.integration.test.ts` A15/A17 fail deterministically (D-127).
Not a regression from this node; fixing it belongs to `task_fc02ed64` (see (a)).
Expect `26 files / 128 tests passing, 1 file / 2 tests failing` at CP0 — unless
that task has landed by then, in which case record the new clean baseline and say
so in `state.json`.

### (j) Expired `export_job.artifact_bytes` is a real gap, and it is not this node's job

`export_job.expires_at` (029) gates download, but nothing ever clears
`artifact_bytes`, so completed export artifacts accumulate in PostgreSQL forever.
User decision during this node's design: **out of scope**, disclosed as a `D-*`
entry plus a spawned background task (the D-125/D-127 precedent), not fixed
inline. Its lifecycle is driven by `EXPORT_ARTIFACT_TTL_HOURS`, not by any
tenant's retention policy, so folding it in would conflate two policies.

### (k) There is no inbound FK to either ledger

`grep -rn "REFERENCES message_attempt\|REFERENCES delivery_event" database/migrations/*.sql`
returns nothing. Deleting from either table cannot violate a foreign key, and no
`ON DELETE CASCADE` fans out from it. `delivery_event.campaign_recipient_id` and
`.execution_id` point *outward* at rows this node never deletes.

---

## 1. What this slice turns from definition into fact

### The rule, in its own words

`BR-HIS-006` (P2, `catalog/ba-rules.json`):

- statement: *"Campaign summary giữ tối thiểu 24 tháng; message event chi tiết
  theo chính sách tenant, mặc định 12 tháng."*
- acceptance: *"Job purge có audit và không phá aggregate report; chính sách cấu
  hình được."*

`TC-HIS-006` (`catalog/test-cases.json`, layer `API/Integration`, automation `Có`)
expects the same in test form.

`state.json`'s own `M6-S4-history-retention` success conditions:

1. Purge job has audit and does not break aggregate reporting
2. Retention policy is tenant-configurable
3. `BR-HIS-006` closed

### What the rule's halves map to

| Rule phrase | Mechanism in this plan |
| --- | --- |
| "message event chi tiết" | `message_attempt` + `delivery_event` rows |
| "theo chính sách tenant" | `retention_policy.message_event_retention_days`, per tenant |
| "mặc định 12 tháng" | `HISTORY_EVENT_RETENTION_DAYS=365` when a tenant has no row |
| "Campaign summary giữ tối thiểu 24 tháng" | `campaign`, `campaign_execution`, `campaign_snapshot`, `campaign_recipient` are never purged — the floor holds by construction |
| "Job purge có audit" | one `audit_log` row per tenant per run that deleted something |
| "không phá aggregate report" | A2: identical history/progress payload before and after a purge |
| "chính sách cấu hình được" | `GET/PUT /retention-policy`, `settings:manage` |

### Hard non-goals

- **No purge of `campaign`, `campaign_execution`, `campaign_snapshot` or
  `campaign_recipient`.** §0(c)/(d) explain why; a 24-month summary tier would
  need its own ADR and FK work and is not required to close this rule.
- **No `export_job` cleanup** (§0(j)) — disclosed and spawned, not implemented.
- **No UI screen and no change to `apps/web`** (§0(f)).
- **No change to `progress-reconcile.ts`** (§0(a)).
- **No new BullMQ queue.** The purge is a job name on the existing
  `campaign-execution` queue, exactly like `export-scan` (M6-S3 CP8).
- **No restore/undelete path.** Purged rows are gone; the audit row is the record.

---

## 2. Acceptance criteria

| ID | Criterion | Written in |
| --- | --- | --- |
| A1 | `purge_message_events` deletes `message_attempt`/`delivery_event` rows older than the cutoff for exactly one tenant, and leaves another tenant's identical-age rows untouched | CP5 |
| A2 | The history progress payload (`buildHistoryProgressSql` columns) and `campaign_execution`'s nine counters are **identical before and after** a purge that deleted rows | CP5 |
| A3 | `purge_message_events` raises SQLSTATE `55000` for a cutoff newer than `now() - 30 days`, and deletes nothing | CP2 |
| A4 | A tenant with `message_event_retention_days = 30` has its 60-day-old events purged while a tenant with no policy row (365-day default) keeps them | CP5 |
| A5 | Exactly one `audit_log` row per tenant per purging run: `action='history.purged'`, `actor_id IS NULL`, metadata with `retentionDays`, `source`, `cutoff` and the three counts | CP5 |
| A6 | A second immediate run deletes 0 rows and writes **no** audit row (idempotent, non-spamming) | CP5 |
| A7 | `purgeable_retention_tenants` returns a tenant whose oldest event is past its own window, oldest-first, and omits tenants inside their window | CP2 |
| A8 | `retention_policy` rejects `29` and `3651` at the database CHECK | CP2 |
| A9 | `GET /retention-policy` returns `{messageEventRetentionDays: 365, source: 'default'}` with no row, and the stored value with `source: 'policy'` after a PUT | CP3 |
| A10 | `PUT /retention-policy` is `403` for operator and viewer, `200` for admin, and `400` (not 500) for `29` | CP3 |
| A11 | `PUT /retention-policy` writes `audit_log` `action='retention_policy.updated'` | CP3 |
| A12 | Tenant A's PUT is invisible to tenant B (`GET` still `default`) | CP3 |
| A13 | The worker handles `history-purge-scan` and the scheduler enqueues it — no job name exists on only one side | CP6 (ARCH-JOB-WIRING) |
| A14 | `HISTORY_EVENT_RETENTION_DAYS`: `29` rejected at API boot, absent defaults to `365` | CP4 |
| A15 | `retentionCutoff`/`historyRetentionDefaultDays` are pure and unit-tested without a database | CP4 |

---

## 3. Locked design

### 3.1 Migration `032_history_retention.sql` — the table

One row per tenant; absence means "use the env default". `30 .. 3650` mirrors the
floor enforced by `purge_message_events` and by the API's Zod schema, so the three
layers cannot disagree. `SELECT, INSERT, UPDATE` only — a tenant never deletes its
policy row, it raises the number instead.

```sql
CREATE TABLE retention_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenant(id),
  message_event_retention_days integer NOT NULL,
  updated_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_policy_days_bounded
    CHECK (message_event_retention_days BETWEEN 30 AND 3650)
);

GRANT SELECT, INSERT, UPDATE ON TABLE retention_policy TO eow_app;
ALTER TABLE retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_policy_tenant_isolation ON retention_policy
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
```

Two supporting indexes, because both scan predicates are `(tenant_id, <time>)` and
neither table has one today (`message_attempt` indexes lead with
`(tenant_id, execution_id, ...)`; `delivery_event` with
`(tenant_id, campaign_recipient_id, occurred_at)`):

```sql
CREATE INDEX idx_message_attempt_tenant_attempted ON message_attempt (tenant_id, attempted_at);
CREATE INDEX idx_delivery_event_tenant_received ON delivery_event (tenant_id, received_at);
```

`delivery_event` is aged by `received_at`, not `occurred_at`: `occurred_at` is
provider-supplied and can be skewed or backdated, `received_at` is this system's
own clock at ingest. Retention must be a fact about our storage, not about a
third party's timestamp.

### 3.2 Migration `032` — the two boundary functions

The same narrow SECURITY DEFINER shape as `013/025/026/027/028/029`: a fixed query
returning only what the caller needs, so `eow_app` stays `NOBYPASSRLS` and gains
no DELETE privilege (§0(b)).

```sql
CREATE OR REPLACE FUNCTION purgeable_retention_tenants(p_default_days integer, p_limit integer)
RETURNS TABLE (tenant_id uuid, retention_days integer, from_policy boolean, oldest_event_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH effective AS (
    SELECT t.id AS tenant_id,
           GREATEST(COALESCE(rp.message_event_retention_days, p_default_days), 30)::integer AS retention_days,
           (rp.message_event_retention_days IS NOT NULL) AS from_policy
    FROM tenant t
    LEFT JOIN retention_policy rp ON rp.tenant_id = t.id
  ),
  oldest AS (
    SELECT e.tenant_id, e.retention_days, e.from_policy,
           LEAST(
             (SELECT min(ma.attempted_at) FROM message_attempt ma WHERE ma.tenant_id = e.tenant_id),
             (SELECT min(de.received_at) FROM delivery_event de WHERE de.tenant_id = e.tenant_id)
           ) AS oldest_event_at
    FROM effective e
  )
  SELECT oldest.tenant_id, oldest.retention_days, oldest.from_policy, oldest.oldest_event_at
  FROM oldest
  WHERE oldest.oldest_event_at IS NOT NULL
    AND oldest.oldest_event_at < now() - make_interval(days => oldest.retention_days)
  ORDER BY oldest.oldest_event_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION purgeable_retention_tenants(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purgeable_retention_tenants(integer, integer) TO eow_app;
```

`LEAST` ignores NULLs in PostgreSQL, so a tenant with attempts but no delivery
events (or the reverse) still reports its true oldest event.

`ORDER BY oldest_event_at` is **oldest-first on purpose**, and it is the opposite
of D-127's bug rather than a repeat of it: this scan's own work *removes* the rows
it ordered by, so a tenant cannot be starved — each run drains the oldest data and
the next run sees a different head. D-127's scan re-listed the same aged rows
forever because reconciliation never deleted anything.

```sql
CREATE OR REPLACE FUNCTION purge_message_events(p_tenant_id uuid, p_cutoff timestamptz, p_limit integer)
RETURNS TABLE (message_attempts_deleted integer, delivery_events_deleted integer, executions_affected integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(p_limit, 1), 100000);
  v_attempts integer := 0;
  v_events integer := 0;
  v_executions integer := 0;
BEGIN
  IF p_cutoff > now() - interval '30 days' THEN
    RAISE EXCEPTION 'Retention cutoff % is inside the 30-day floor; message events younger than 30 days are never purged', p_cutoff
      USING ERRCODE = '55000';
  END IF;

  WITH doomed AS (
    SELECT ma.id FROM message_attempt ma
    WHERE ma.tenant_id = p_tenant_id AND ma.attempted_at < p_cutoff
    ORDER BY ma.attempted_at
    LIMIT v_limit
  ), removed AS (
    DELETE FROM message_attempt ma USING doomed
    WHERE ma.id = doomed.id
    RETURNING ma.execution_id
  )
  SELECT count(*)::integer, count(DISTINCT removed.execution_id)::integer
    INTO v_attempts, v_executions
  FROM removed;

  WITH doomed AS (
    SELECT de.id FROM delivery_event de
    WHERE de.tenant_id = p_tenant_id AND de.received_at < p_cutoff
    ORDER BY de.received_at
    LIMIT v_limit
  ), removed AS (
    DELETE FROM delivery_event de USING doomed
    WHERE de.id = doomed.id
    RETURNING de.id
  )
  SELECT count(*)::integer INTO v_events FROM removed;

  RETURN QUERY SELECT v_attempts, v_events, v_executions;
END;
$$;
REVOKE ALL ON FUNCTION purge_message_events(uuid, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_message_events(uuid, timestamptz, integer) TO eow_app;
```

The `LIMIT` makes a first run over a multi-year backlog many bounded transactions
rather than one lock-holding statement; the next tick continues where this one
stopped, because the rows it deleted no longer qualify.

### 3.3 The worker job

Two new files, no change to any existing worker module except `main.ts`'s switch.

`apps/worker/src/retention-window.ts` — pure, database-free, exhaustively unit
testable (A15):

```ts
export const RETENTION_FLOOR_DAYS = 30;
export const DEFAULT_HISTORY_EVENT_RETENTION_DAYS = 365;

/** Reads HISTORY_EVENT_RETENTION_DAYS, defaulting and bounding it the same way apps/api's env schema does. */
export function historyRetentionDefaultDays(configured: string | undefined): number;

/** The instant before which detail rows are purgeable. Never newer than the floor. */
export function retentionCutoff(retentionDays: number, now: Date): Date;
```

`apps/worker/src/history-purge.ts` — the orchestrator, same shape as
`reconcileProgress`/`export-scan`: an unlocked scan over the narrow boundary
function, then one tenant transaction per tenant.

```ts
export type HistoryPurgeResult = {
  tenantId: string;
  retentionDays: number;
  source: 'policy' | 'default';
  cutoff: Date;
  messageAttemptsDeleted: number;
  deliveryEventsDeleted: number;
  executionsAffected: number;
};

export async function purgeHistoryEvents(
  databaseUrl: string,
  defaultRetentionDays: number,
  now?: Date,
): Promise<HistoryPurgeResult[]>;
```

Constants live in the module, not in the environment (YAGNI): 
`TENANT_SCAN_LIMIT = 25`, `PURGE_BATCH_ROWS = 5000`.

Per tenant, inside `runInTenantTransaction`: call `purge_message_events`, and only
if `messageAttemptsDeleted + deliveryEventsDeleted > 0` insert the audit row, then
push the result. A tenant that deleted nothing is not returned.

### 3.4 The audit row

One row per tenant per purging run (§0(g)):

```sql
INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
VALUES ($1, NULL, 'history.purged', 'tenant', $1, $2, $3::jsonb)
```

- `trace_id`: `history-purge:<tenantId>:<cutoff ISO string>` — stable for a given
  tenant+cutoff, so a duplicated run is recognisable in the trail.
- `metadata`: `{ retentionDays, source, cutoff, messageAttemptsDeleted,
  deliveryEventsDeleted, executionsAffected }`.

`entity_type='tenant'` because the deletion is a tenant-wide policy action, not an
action on one campaign — and because the executions it touched may themselves be
listed in `executionsAffected` only as a count, never as rows that still exist.

### 3.5 The API module

`apps/api/src/retention/` per `docs/architecture/module-template.md`:

```text
apps/api/src/retention/retention.module.ts
apps/api/src/retention/retention.controller.ts
apps/api/src/retention/retention.service.ts
apps/api/src/retention/retention.repository.ts
apps/api/src/retention/dto/retention.dto.ts
apps/api/src/retention/dto/retention.dto.test.ts        (pure unit)
apps/api/src/database/entities/retention-policy.entity.ts
apps/api/test/integration/retention-policy.test.ts      (HTTP + RLS)
```

Both routes carry `@RequirePermission(PERMISSIONS.SETTINGS_MANAGE)`; the PUT also
carries `@UseGuards(CsrfGuard)`, matching `PUT /sending-policy` exactly. Response
shape both ways:

```ts
{ messageEventRetentionDays: number; source: 'policy' | 'default' }
```

`source` is what makes "no row yet" legible to a client without inventing a null.

### 3.6 Configuration and deployment

`HISTORY_EVENT_RETENTION_DAYS`, integer `30..3650`, default `365`:

- `apps/api/src/config/env.ts` (Zod, fails fast at boot)
- `apps/worker` reads it through `historyRetentionDefaultDays(process.env.HISTORY_EVENT_RETENTION_DAYS)`
- `compose.yaml`: both the `api` and `worker` services, as
  `HISTORY_EVENT_RETENTION_DAYS: ${EOW_HISTORY_EVENT_RETENTION_DAYS:-365}`
- `.env.deploy.example`: `EOW_HISTORY_EVENT_RETENTION_DAYS=365`
- `docs/deployment/environment-variables.md`: one row, same wording style as
  `EOW_NOTIFICATION_RETENTION_DAYS`

---

## 4. Contracts

`contracts/openapi.yaml` — two operations and two schemas. Place `/retention-policy`
immediately after `/sending-policy` (line 38-45), where the other tenant-settings
routes live.

```yaml
  /retention-policy:
    get:
      operationId: getRetentionPolicy
      responses: {'200': {description: Retention policy, content: {application/json: {schema: {$ref: '#/components/schemas/RetentionPolicy'}}}}, '403': {$ref: '#/components/responses/Problem'}}
    put:
      operationId: updateRetentionPolicy
      requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/RetentionPolicyUpdateRequest'}}}}
      responses: {'200': {description: Updated retention policy, content: {application/json: {schema: {$ref: '#/components/schemas/RetentionPolicy'}}}}, '400': {$ref: '#/components/responses/Problem'}, '403': {$ref: '#/components/responses/Problem'}}
```

```yaml
    RetentionPolicy:
      type: object
      required: [messageEventRetentionDays, source]
      properties:
        messageEventRetentionDays: {type: integer, minimum: 30, maximum: 3650}
        source: {type: string, enum: [policy, default]}
    RetentionPolicyUpdateRequest:
      type: object
      required: [messageEventRetentionDays]
      properties:
        messageEventRetentionDays: {type: integer, minimum: 30, maximum: 3650}
```

No AsyncAPI change: the purge emits no realtime envelope and no notification. It
is a background maintenance action whose only external record is the audit row —
deliberately, because a notification per purge would fire on a schedule nobody
subscribed to.

Regenerate and check compatibility:

```bash
pnpm contracts:generate && pnpm contracts:compat-check
```

---

## 5. Risks

| # | Risk | Mitigation in this plan |
| --- | --- | --- |
| R1 | A wrong cutoff deletes recent evidence | The 30-day floor is inside `purge_message_events`, not in the caller (A3). The caller's own arithmetic is separately unit-tested (A15). |
| R2 | The purge silently changes a report | A2 asserts the exact history progress payload and all nine stored counters are unchanged across a purge that really deleted rows. |
| R3 | The live docker worker races host-run tests (D-118) and purges their fixtures | §0(h)'s three rules; every "still exists" assertion targets rows newer than the floor. |
| R4 | A first run over a years-long backlog holds locks or times out | `PURGE_BATCH_ROWS = 5000` per tenant per tick, `TENANT_SCAN_LIMIT = 25` tenants per tick; both bounded inside the function too (`LEAST(GREATEST(...))`). |
| R5 | Granting DELETE would weaken the append-only ledgers | Never granted; the only deletion path is one SECURITY DEFINER function with the floor baked in (§0(b), DEC-140). |
| R6 | Migration number collides with the open D-127 task | `032`, plus a re-check of that worktree at CP0 (§0(a)). |
| R7 | Audit spam: one row per tenant every 60s | The audit row is written only when something was actually deleted (A6). |
| R8 | The scheduler enqueues a job the worker cannot handle, or vice versa (the D-87/D-115 class) | ARCH-JOB-WIRING (A13) compares both sides mechanically. |
| R9 | A new API module drifts from the module template | It is generated/shaped per `docs/architecture/module-template.md` and `packages/architecture-tests` runs at CP8 (D-128's lesson: run the full suite, not just the touched package). |

---

## 6. Checkpoints

Each checkpoint is one commit, subject naming the node, body recording the test
and skip counts of whatever suite it ran (AGENTS.md §2). Every code task is RED
before GREEN.

### CP0 — baseline

- [ ] **Step 1: Confirm the working tree and the neighbouring worktree**

```bash
git status --porcelain && git log --oneline -3 && git -C .claude/worktrees/reverent-wiles-aa8740 status --porcelain
```

Expected: clean main at `9843e6e` (or later), and the D-127 worktree still showing
its four entries (§0(a)). If `031_reconcile_scan_newest_first.sql` has been merged
into `main` in the meantime, note it and keep `032` for this node.

- [ ] **Step 2: Bring infrastructure up**

```bash
docker compose --env-file .env up -d postgres redis mailpit --wait
```

Expected: `postgres`, `redis`, `mailpit` all report healthy.

- [ ] **Step 3: Record the per-package baseline at real parallelism**

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

Expected (the M6-S3 close baseline): api 86 files / 626 tests / 0 skipped; worker
27 files / 130 tests with `progress-reconcile.integration.test.ts`'s 2 failures
(§0(i)); web 23 files / 69 tests; architecture-tests 14 files / 113 tests.
Do not run `pnpm run check` for this — its recursive step aborts on the first
package's first flake and hides the rest.

- [ ] **Step 4: Open the node in `state.json`**

Set `M6-S4-history-retention.status` to `"running"`, `currentNode` to
`"M6-S4-history-retention"`, `attempt` to `1`, and add the baseline numbers as the
first `evidence` entry. Update `updatedAt`.

- [ ] **Step 5: Validate and commit**

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/state.json .agents/runs/2026-08-10-eow-master-execplan/M6-S4-HISTORY-RETENTION-PLAN.md && git commit -m "M6-S4 CP0: baseline and node open (BR-HIS-006)"
```

(If this plan document was already committed on approval — the `c27d9d9`
precedent for M6-S3 — the `git add` of it here is simply a no-op.)

### CP1 — decisions and traceability, before any code

- [ ] **Step 1: Append the discovery entries to `EXECPLAN.md` §19**

Add `D-129` (the append-only ledgers have no DELETE grant, so the purge needs a
SECURITY DEFINER path — §0(b)), `D-130` (aggregate reporting reads the stored 028
summary and never recomputes from detail, which is what makes this purge scope
safe — §0(d)), and `D-131` (nothing purges expired `export_job.artifact_bytes`;
out of this node's rule ownership, spawned instead — §0(j)).

- [ ] **Step 2: Append the decision entries to `EXECPLAN.md` §20**

`DEC-140`: purge deletes only `message_attempt`/`delivery_event`, through
`purge_message_events` (SECURITY DEFINER), with a 30-day floor in the database;
alternatives rejected: granting DELETE to `eow_app` (weakens 026/027's
append-only posture permanently), and a summary tier purging
`campaign_execution`/`campaign_snapshot` (needs an ADR superseding M4-S4
immutability and FK work on `export_job`, for a P2 rule).

`DEC-141`: retention is configured per tenant in a new `retention_policy` table
with an env default (`HISTORY_EVENT_RETENTION_DAYS=365`), exposed API-only via
`GET/PUT /retention-policy` under `settings:manage`, with **no new screen** —
the approved handoff's Settings component has only sender-config/default-policy
tabs (§0(f)). Alternatives rejected: columns on `sending_policy` (wrong semantic
home, and it backs an approved screen), and a global env var only (contradicts
BR-HIS-006's own "theo chính sách tenant").

`DEC-142`: one `audit_log` row per tenant per run that actually deleted
something, not one per execution (a first run over a year's backlog would write
thousands of immutable rows) and not one per tick (audit spam at a 60s cadence).

- [ ] **Step 3: Move `BR-HIS-006` to in-progress in `traceability.csv`**

Set its `status` column from `not_started` to `in_progress`. Leave every other
column until the artifacts exist (evidence before status).

- [ ] **Step 4: Spawn the disclosed follow-up for `export_job` artifacts**

Use `mcp__ccd_session__spawn_task` with title
`Purge expired export_job artifact bytes`, describing: `export_job.expires_at`
(migration 029) gates download but nothing clears `artifact_bytes`; artifacts
accumulate in PostgreSQL indefinitely; the fix belongs with
`EXPORT_ARTIFACT_TTL_HOURS`, not with BR-HIS-006's tenant retention policy; see
`D-131`.

- [ ] **Step 5: Commit**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md .agents/runs/2026-08-10-eow-master-execplan/traceability.csv && git commit -m "M6-S4 CP1: D-129/130/131 and DEC-140/141/142 before implementation"
```

### CP2 — migration 032, RED first

**Files:**
- Create: `database/migrations/032_history_retention.sql`
- Create: `apps/api/test/integration/retention-schema.test.ts`
- Modify: `database/migrations.lock.json`

- [ ] **Step 1: Write the failing schema test**

Create `apps/api/test/integration/retention-schema.test.ts`. It runs against the
owner connection because it asserts on grants and function behaviour, following
`apps/api/test/integration/progress-counters-db.test.ts`'s shape.

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { testDatabaseUrl } from './test-database-url.js';

/**
 * M6-S4 CP2 (BR-HIS-006, A3/A7/A8). Migration 032's own contract: the
 * per-tenant policy row, the bounded cross-tenant scan, and the purge
 * function's 30-day floor -- the floor lives in the database so a wrong
 * caller cannot delete recent evidence (plan SS0(e)).
 */
describe('Migration 032 retention schema (M6-S4 CP2)', () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`retention-schema-${randomUUID()}`])).rows[0].id;
    otherTenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`retention-schema-other-${randomUUID()}`])).rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM retention_policy WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
    await pool.query('DELETE FROM tenant WHERE id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
    await pool.end();
  });

  it('A8: rejects a retention window below the 30-day floor', async () => {
    await expect(
      pool.query('INSERT INTO retention_policy (tenant_id, message_event_retention_days) VALUES ($1, 29)', [tenantId]),
    ).rejects.toThrow(/retention_policy_days_bounded/);
  });

  it('A8: rejects a retention window above 3650 days', async () => {
    await expect(
      pool.query('INSERT INTO retention_policy (tenant_id, message_event_retention_days) VALUES ($1, 3651)', [tenantId]),
    ).rejects.toThrow(/retention_policy_days_bounded/);
  });

  it('A8: accepts a value inside the bounds and enforces one row per tenant', async () => {
    await pool.query('INSERT INTO retention_policy (tenant_id, message_event_retention_days) VALUES ($1, 30)', [tenantId]);
    await expect(
      pool.query('INSERT INTO retention_policy (tenant_id, message_event_retention_days) VALUES ($1, 60)', [tenantId]),
    ).rejects.toThrow(/retention_policy_tenant_id_key/);
    await pool.query('DELETE FROM retention_policy WHERE tenant_id = $1', [tenantId]);
  });

  it('A3: refuses a cutoff inside the 30-day floor and deletes nothing', async () => {
    await expect(
      pool.query('SELECT * FROM purge_message_events($1, now() - interval \'29 days\', 100)', [tenantId]),
    ).rejects.toThrow(/30-day floor/);
  });

  it('A3: accepts a cutoff outside the floor and reports zero deletions for an empty tenant', async () => {
    const result = await pool.query<{ message_attempts_deleted: number; delivery_events_deleted: number; executions_affected: number }>(
      'SELECT * FROM purge_message_events($1, now() - interval \'400 days\', 100)',
      [tenantId],
    );
    expect(result.rows[0]).toEqual({ message_attempts_deleted: 0, delivery_events_deleted: 0, executions_affected: 0 });
  });

  it('A7: omits a tenant with no events at all', async () => {
    const result = await pool.query<{ tenant_id: string }>('SELECT tenant_id FROM purgeable_retention_tenants(365, 25)');
    expect(result.rows.map((row) => row.tenant_id)).not.toContain(tenantId);
  });

  it('the purge functions are not executable by PUBLIC', async () => {
    const result = await pool.query<{ has: boolean }>(
      `SELECT has_function_privilege('public', 'purge_message_events(uuid, timestamptz, integer)', 'EXECUTE') AS has`,
    );
    expect(result.rows[0].has).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @eow/api exec vitest run test/integration/retention-schema.test.ts
```

Expected: FAIL — `relation "retention_policy" does not exist` /
`function purge_message_events(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `database/migrations/032_history_retention.sql` containing, in order: the
header comment naming M6-S4/BR-HIS-006/DEC-140/DEC-141, the `retention_policy`
table, its grants/RLS/policy, the two indexes, and the two functions — all exactly
as written in §3.1 and §3.2 of this plan. Write the file as UTF-8 (AGENTS.md §2).

- [ ] **Step 4: Apply the migration**

```bash
bash database/migrate.sh
```

Expected: `032_history_retention.sql` applied; the run ends with no checksum
error for `001`-`030`.

- [ ] **Step 5: Pin the hash manually**

```bash
python -c "import hashlib,io;print(hashlib.sha256(open('database/migrations/032_history_retention.sql','rb').read()).hexdigest())"
```

Add the printed hash to `database/migrations.lock.json` as
`"032_history_retention.sql": "<hash>"`. `ARCH-MIGRATION` never blesses this file
for you: an unpinned migration is a failing test, by design.

- [ ] **Step 6: Run the schema test and the architecture suite**

```bash
pnpm --filter @eow/api exec vitest run test/integration/retention-schema.test.ts
```

Expected: PASS, 7 tests.

```bash
pnpm --filter @eow/architecture-tests exec vitest run --maxWorkers=3
```

Expected: PASS, 14 files / 113 tests — in particular `ARCH-MIGRATION`
(immutability + lock parity) and `ARCH-MIGRATION-SAFETY`.

- [ ] **Step 7: Commit**

```bash
git add database/migrations/032_history_retention.sql database/migrations.lock.json apps/api/test/integration/retention-schema.test.ts && git commit -m "M6-S4 CP2: migration 032 retention policy, scan and purge boundary (BR-HIS-006)"
```

### CP3 — the API module, RED first

**Files:**
- Create: `apps/api/src/database/entities/retention-policy.entity.ts`
- Create: `apps/api/src/retention/dto/retention.dto.ts`
- Create: `apps/api/src/retention/dto/retention.dto.test.ts`
- Create: `apps/api/src/retention/retention.repository.ts`
- Create: `apps/api/src/retention/retention.service.ts`
- Create: `apps/api/src/retention/retention.controller.ts`
- Create: `apps/api/src/retention/retention.module.ts`
- Create: `apps/api/test/integration/retention-policy.test.ts`
- Modify: `apps/api/src/database/data-source.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Write the failing DTO unit test**

Create `apps/api/src/retention/dto/retention.dto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { retentionPolicySchema } from './retention.dto.js';

/** M6-S4 CP3 (A10). The Zod bound mirrors migration 032's own CHECK, so a
 *  rejected value is a 400 from validation, never a 500 from the database. */
describe('retentionPolicySchema', () => {
  it('accepts the floor and the ceiling', () => {
    expect(retentionPolicySchema.parse({ messageEventRetentionDays: 30 })).toEqual({ messageEventRetentionDays: 30 });
    expect(retentionPolicySchema.parse({ messageEventRetentionDays: 3650 })).toEqual({ messageEventRetentionDays: 3650 });
  });

  it('rejects a value below the floor', () => {
    expect(retentionPolicySchema.safeParse({ messageEventRetentionDays: 29 }).success).toBe(false);
  });

  it('rejects a value above the ceiling', () => {
    expect(retentionPolicySchema.safeParse({ messageEventRetentionDays: 3651 }).success).toBe(false);
  });

  it('rejects a non-integer', () => {
    expect(retentionPolicySchema.safeParse({ messageEventRetentionDays: 45.5 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @eow/api exec vitest run src/retention/dto/retention.dto.test.ts
```

Expected: FAIL — cannot resolve `./retention.dto.js`.

- [ ] **Step 3: Write the DTO**

Create `apps/api/src/retention/dto/retention.dto.ts`:

```ts
import { z } from 'zod';

/**
 * M6-S4 (BR-HIS-006). Bounds mirror migration 032's
 * retention_policy_days_bounded CHECK: 30 days is the same floor
 * purge_message_events() enforces, so no reachable API value can ask the
 * purge to delete recent evidence.
 */
export const retentionPolicySchema = z.object({
  messageEventRetentionDays: z.number().int().min(30).max(3650),
});

export type RetentionPolicyDto = z.infer<typeof retentionPolicySchema>;
export type RetentionPolicyView = { messageEventRetentionDays: number; source: 'policy' | 'default' };
```

- [ ] **Step 4: Run the unit test to verify it passes**

```bash
pnpm --filter @eow/api exec vitest run src/retention/dto/retention.dto.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing HTTP/RLS integration test**

Create `apps/api/test/integration/retention-policy.test.ts`, modelled on
`apps/api/test/integration/campaign-history.test.ts`'s boot/sign-in shape. It must
cover A9, A10, A11 and A12: default read for a tenant with no row; admin PUT then
read back with `source: 'policy'`; `403` for operator and viewer on both routes;
`400` for `29`; an `audit_log` row with `action='retention_policy.updated'`; and a
second tenant still reading the default after the first tenant's PUT.

Login helper — the route is `/api/v1/auth/login` and the CSRF token comes out of
the `eow_csrf` cookie, exactly as
`apps/api/test/integration/campaign-schedule-http.test.ts:88-95` does it. Do not
invent a different sign-in shape:

```ts
async function login(email: string): Promise<{ cookie: string; csrfToken: string }> {
  const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
  const cookies = response.headers['set-cookie'] as unknown as string[];
  return {
    cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
    csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
  };
}
```

`beforeAll` creates two tenants, and in the first one an `admin`, an `operator`
and a `viewer` (`AppUserEntity` + `hashPassword`, the same way
`campaign-history.test.ts` seeds users), plus an `admin` in the second tenant.
`afterAll` deletes `retention_policy`, `audit_log`, `app_user` and both `tenant`
rows.

The five assertions that carry the acceptance criteria:

```ts
it('A9: returns the env default for a tenant with no policy row', async () => {
  const admin = await login(adminEmail);
  const response = await request(app.getHttpServer())
    .get('/api/v1/retention-policy')
    .set('Cookie', admin.cookie)
    .expect(200);
  expect(response.body).toEqual({ messageEventRetentionDays: 365, source: 'default' });
});

it('A9/A11: stores an admin update and audits it', async () => {
  const admin = await login(adminEmail);
  const response = await request(app.getHttpServer())
    .put('/api/v1/retention-policy')
    .set('Cookie', admin.cookie).set('x-csrf-token', admin.csrfToken)
    .send({ messageEventRetentionDays: 90 })
    .expect(200);
  expect(response.body).toEqual({ messageEventRetentionDays: 90, source: 'policy' });

  const audit = await dataSource.query(
    `SELECT action, metadata FROM audit_log WHERE tenant_id = $1 AND action = 'retention_policy.updated' ORDER BY occurred_at DESC LIMIT 1`,
    [tenant.id],
  );
  expect(audit[0].metadata.messageEventRetentionDays).toBe(90);
});

it('A10: rejects 29 with 400, not a database error', async () => {
  const admin = await login(adminEmail);
  await request(app.getHttpServer())
    .put('/api/v1/retention-policy')
    .set('Cookie', admin.cookie).set('x-csrf-token', admin.csrfToken)
    .send({ messageEventRetentionDays: 29 })
    .expect(400);
});

it('A10: denies operator and viewer', async () => {
  const viewer = await login(viewerEmail);
  const operator = await login(operatorEmail);
  await request(app.getHttpServer()).get('/api/v1/retention-policy').set('Cookie', viewer.cookie).expect(403);
  await request(app.getHttpServer())
    .put('/api/v1/retention-policy')
    .set('Cookie', operator.cookie).set('x-csrf-token', operator.csrfToken)
    .send({ messageEventRetentionDays: 120 })
    .expect(403);
});

it('A12: another tenant still reads the default', async () => {
  const otherAdmin = await login(otherAdminEmail);
  const response = await request(app.getHttpServer())
    .get('/api/v1/retention-policy')
    .set('Cookie', otherAdmin.cookie)
    .expect(200);
  expect(response.body).toEqual({ messageEventRetentionDays: 365, source: 'default' });
});
```

The A9/A11 test must run before A12 in file order, or seed the second tenant's
assertion independently — A12's point is that the first tenant's stored row is
invisible, which requires that row to already exist.

- [ ] **Step 6: Run it to verify it fails**

```bash
pnpm --filter @eow/api exec vitest run test/integration/retention-policy.test.ts
```

Expected: FAIL — 404 on both routes (no module registered yet).

- [ ] **Step 7: Write the entity and register it**

Create `apps/api/src/database/entities/retention-policy.entity.ts`:

```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
@Entity({ name: 'retention_policy' })
export class RetentionPolicyEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'message_event_retention_days', type: 'int' }) messageEventRetentionDays!: number;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
```

Add the import and the `entities` array entry in `apps/api/src/database/data-source.ts`,
next to `SendingPolicyEntity`.

- [ ] **Step 8: Write the repository, service, controller and module**

`apps/api/src/retention/retention.repository.ts`:

```ts
import type { EntityManager } from 'typeorm';
import { RetentionPolicyEntity } from '../database/entities/retention-policy.entity.js';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';
export class RetentionPolicyRepository extends TenantScopedRepository<RetentionPolicyEntity> {
  constructor(manager: EntityManager, tenantId: string) { super(manager.getRepository(RetentionPolicyEntity), tenantId); }
  get() { return this.repository.findOne({ where: { tenantId: this.tenantId } }); }
}
```

`apps/api/src/retention/retention.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { appendAuditLog } from '../common/audit-writer.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { RetentionPolicyEntity } from '../database/entities/retention-policy.entity.js';
import { RetentionPolicyRepository } from './retention.repository.js';
import type { RetentionPolicyDto, RetentionPolicyView } from './dto/retention.dto.js';

export type RetentionActor = { actorId: string; traceId: string };

/**
 * M6-S4 (BR-HIS-006, DEC-141). "Chinh sach cau hinh duoc": one row per
 * tenant, absent row means the deployment default. `source` is what makes
 * "not configured yet" legible without inventing a null on the wire.
 */
@Injectable()
export class RetentionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private defaultDays(): number {
    const configured = Number(process.env.HISTORY_EVENT_RETENTION_DAYS ?? 365);
    return Number.isInteger(configured) && configured >= 30 && configured <= 3650 ? configured : 365;
  }

  getPolicy(tenantId: string): Promise<RetentionPolicyView> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const row = await new RetentionPolicyRepository(manager, tenantId).get();
      return row
        ? { messageEventRetentionDays: row.messageEventRetentionDays, source: 'policy' as const }
        : { messageEventRetentionDays: this.defaultDays(), source: 'default' as const };
    });
  }

  putPolicy(tenantId: string, body: RetentionPolicyDto, actor: RetentionActor): Promise<RetentionPolicyView> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      let row = await new RetentionPolicyRepository(manager, tenantId).get();
      if (!row) row = manager.getRepository(RetentionPolicyEntity).create({ tenantId });
      row.messageEventRetentionDays = body.messageEventRetentionDays;
      row.updatedBy = actor.actorId;
      const saved = await manager.getRepository(RetentionPolicyEntity).save(row);
      await appendAuditLog(manager, {
        tenantId,
        actorId: actor.actorId,
        action: 'retention_policy.updated',
        entityType: 'retention_policy',
        entityId: saved.id,
        traceId: actor.traceId,
        metadata: { messageEventRetentionDays: saved.messageEventRetentionDays },
      });
      return { messageEventRetentionDays: saved.messageEventRetentionDays, source: 'policy' as const };
    });
  }
}
```

`apps/api/src/retention/retention.controller.ts`:

```ts
import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { retentionPolicySchema, type RetentionPolicyDto } from './dto/retention.dto.js';
import { RetentionService } from './retention.service.js';

function auth(req: AuthenticatedRequest) {
  if (!req.auth) throw new Error('Not authenticated.');
  return { tenantId: req.auth.tenantId, actorId: req.auth.userId, traceId: getOrCreateTraceId(req) };
}

@Controller()
export class RetentionController {
  constructor(private readonly service: RetentionService) {}

  @Get('retention-policy') @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  get(@Req() req: AuthenticatedRequest) { return this.service.getPolicy(auth(req).tenantId); }

  @Put('retention-policy') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  put(@Body(new ZodValidationPipe(retentionPolicySchema)) body: RetentionPolicyDto, @Req() req: AuthenticatedRequest) {
    const a = auth(req);
    return this.service.putPolicy(a.tenantId, body, a);
  }
}
```

`apps/api/src/retention/retention.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { RetentionController } from './retention.controller.js';
import { RetentionService } from './retention.service.js';
@Module({ controllers: [RetentionController], providers: [RetentionService], exports: [RetentionService] })
export class RetentionModule {}
```

Register `RetentionModule` in `apps/api/src/app.module.ts`'s imports, next to
`SenderConfigModule`.

- [ ] **Step 9: Run the integration test to verify it passes**

```bash
pnpm --filter @eow/api exec vitest run test/integration/retention-policy.test.ts
```

Expected: PASS — all of A9, A10, A11, A12.

- [ ] **Step 10: Typecheck and commit**

```bash
pnpm --filter @eow/api exec tsc -p tsconfig.json --noEmit
```

```bash
git add apps/api/src/retention apps/api/src/database/entities/retention-policy.entity.ts apps/api/src/database/data-source.ts apps/api/src/app.module.ts apps/api/test/integration/retention-policy.test.ts && git commit -m "M6-S4 CP3: GET/PUT /retention-policy behind settings:manage (BR-HIS-006)"
```

### CP4 — the retention window arithmetic and the env var, RED first

**Files:**
- Create: `apps/worker/src/retention-window.ts`
- Create: `apps/worker/src/retention-window.test.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/config/env.test.ts`

- [ ] **Step 1: Write the failing pure unit test**

Create `apps/worker/src/retention-window.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_EVENT_RETENTION_DAYS,
  RETENTION_FLOOR_DAYS,
  historyRetentionDefaultDays,
  retentionCutoff,
} from './retention-window.js';

/**
 * M6-S4 CP4 (A15). Pure and database-free: the cutoff arithmetic the purge
 * depends on is unit-testable on its own, and the database function's own
 * floor (migration 032) is the second, independent guard.
 */
describe('historyRetentionDefaultDays', () => {
  it('defaults to 365 when unset or blank', () => {
    expect(historyRetentionDefaultDays(undefined)).toBe(DEFAULT_HISTORY_EVENT_RETENTION_DAYS);
    expect(historyRetentionDefaultDays('')).toBe(365);
  });

  it('accepts a configured integer inside the bounds', () => {
    expect(historyRetentionDefaultDays('30')).toBe(30);
    expect(historyRetentionDefaultDays('3650')).toBe(3650);
  });

  it('throws on a value below the floor, above the ceiling, or non-integer', () => {
    expect(() => historyRetentionDefaultDays('29')).toThrowError(/HISTORY_EVENT_RETENTION_DAYS/);
    expect(() => historyRetentionDefaultDays('3651')).toThrowError(/HISTORY_EVENT_RETENTION_DAYS/);
    expect(() => historyRetentionDefaultDays('45.5')).toThrowError(/HISTORY_EVENT_RETENTION_DAYS/);
    expect(() => historyRetentionDefaultDays('abc')).toThrowError(/HISTORY_EVENT_RETENTION_DAYS/);
  });
});

describe('retentionCutoff', () => {
  const now = new Date('2026-08-19T00:00:00.000Z');

  it('subtracts whole days from the supplied clock', () => {
    expect(retentionCutoff(30, now).toISOString()).toBe('2026-07-20T00:00:00.000Z');
    expect(retentionCutoff(365, now).toISOString()).toBe('2025-08-19T00:00:00.000Z');
  });

  it('never returns an instant inside the floor, even if asked', () => {
    expect(retentionCutoff(1, now).toISOString()).toBe(retentionCutoff(RETENTION_FLOOR_DAYS, now).toISOString());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @eow/worker exec vitest run src/retention-window.test.ts
```

Expected: FAIL — cannot resolve `./retention-window.js`.

- [ ] **Step 3: Write the module**

Create `apps/worker/src/retention-window.ts`:

```ts
/**
 * M6-S4 (BR-HIS-006). The purge's own arithmetic, kept pure so it is
 * exhaustively testable without a database. The 30-day floor is repeated
 * inside migration 032's purge_message_events() -- this copy makes a wrong
 * caller impossible, that one makes a wrong *future* caller impossible.
 */
export const RETENTION_FLOOR_DAYS = 30;
export const DEFAULT_HISTORY_EVENT_RETENTION_DAYS = 365;

export function historyRetentionDefaultDays(configured: string | undefined): number {
  if (configured === undefined || configured === '') return DEFAULT_HISTORY_EVENT_RETENTION_DAYS;
  const days = Number(configured);
  if (!Number.isInteger(days) || days < RETENTION_FLOOR_DAYS || days > 3650) {
    throw new Error(`HISTORY_EVENT_RETENTION_DAYS must be an integer between ${RETENTION_FLOOR_DAYS} and 3650.`);
  }
  return days;
}

export function retentionCutoff(retentionDays: number, now: Date): Date {
  const days = Math.max(retentionDays, RETENTION_FLOOR_DAYS);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @eow/worker exec vitest run src/retention-window.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing env test**

Add to `apps/api/src/config/env.test.ts`, beside the existing
`NOTIFICATION_RETENTION_DAYS` cases:

```ts
it('defaults the history event retention window to 365 days', () => {
  expect(validateEnv(validEnv).HISTORY_EVENT_RETENTION_DAYS).toBe(365);
});

it('rejects a history retention window inside the 30-day floor', () => {
  expect(() => validateEnv({ ...validEnv, HISTORY_EVENT_RETENTION_DAYS: '29' })).toThrowError(/HISTORY_EVENT_RETENTION_DAYS/);
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
pnpm --filter @eow/api exec vitest run src/config/env.test.ts
```

Expected: FAIL — `HISTORY_EVENT_RETENTION_DAYS` is `undefined`.

- [ ] **Step 7: Add the variable to the schema**

In `apps/api/src/config/env.ts`, after `EXPORT_ARTIFACT_TTL_HOURS`:

```ts
  /**
   * BR-HIS-006: "message event chi tiet theo chinh sach tenant, mac dinh 12
   * thang". The deployment-wide default used for any tenant with no
   * retention_policy row (migration 032). The 30-day floor mirrors
   * purge_message_events()'s own hard floor.
   */
  HISTORY_EVENT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
```

- [ ] **Step 8: Run both suites to verify they pass**

```bash
pnpm --filter @eow/api exec vitest run src/config/env.test.ts
```

Expected: PASS, including the two new cases.

- [ ] **Step 9: Commit**

```bash
git add apps/worker/src/retention-window.ts apps/worker/src/retention-window.test.ts apps/api/src/config/env.ts apps/api/src/config/env.test.ts && git commit -m "M6-S4 CP4: retention window arithmetic and HISTORY_EVENT_RETENTION_DAYS (BR-HIS-006)"
```

### CP5 — the purge itself, RED first

**Files:**
- Create: `apps/worker/src/history-purge.ts`
- Create: `apps/worker/src/history-purge.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `apps/worker/src/history-purge.integration.test.ts`, following
`export-processor.integration.test.ts`'s shape: an owner pool
(`testOwnerDatabaseUrl()`) for fixtures, `testAppDatabaseUrl()` for the code under
test. All campaigns park at `campaign.status='completed'`, the established value
the live worker's scan does not look at (D-124).

Three tenants, chosen so every assertion is decided by policy rather than by luck:

| Fixture | `retention_policy` | Event age | Expected |
| --- | --- | --- | --- |
| `shortPolicy` | 30 days | 5 years | purged, `source: 'policy'`, `retentionDays: 30` |
| `longPolicy` | 3650 days | 5 years | untouched — same age as `shortPolicy`, opposite outcome, policy the only difference |
| `noPolicy` | none | 400 days | purged, `source: 'default'`, `retentionDays: 365` |

The 5-year age is deliberate: `purgeable_retention_tenants` orders oldest-first
under `LIMIT 25`, and this shared dev database carries many sessions' accumulated
tenants (D-127's own root cause). Fixtures this old sort to the head of that scan,
so the test cannot be starved by unrelated data. If it ever is, raise the fixture
age — never the scan limit, which only postpones the same failure.

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { purgeHistoryEvents } from './history-purge.js';
import { purgeCampaignSendFixtures } from './test-cleanup-helpers.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from './test-urls.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
const now = new Date();
/** Old enough to sort to the head of the oldest-first scan on a shared dev database. */
const FIVE_YEARS = new Date(now.getTime() - 5 * 365 * DAY_MS);
/** Past the 365-day default, so a tenant with no policy row is purged under it. */
const PAST_DEFAULT = new Date(now.getTime() - 400 * DAY_MS);

async function seedTenant(label: string, retentionDays: number | null, eventAt: Date): Promise<{ tenantId: string; executionId: string }> {
  const tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`${label}-${randomUUID()}`])).rows[0].id;
  if (retentionDays !== null) {
    await pool.query('INSERT INTO retention_policy (tenant_id, message_event_retention_days) VALUES ($1, $2)', [tenantId, retentionDays]);
  }
  const template = (await pool.query<{ id: string }>(
    `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
    [tenantId, `retention-template-${randomUUID()}`],
  )).rows[0];
  const templateVersionId = (await pool.query<{ id: string }>(
    `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
     VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('4', 64), now()) RETURNING id`,
    [tenantId, template.id],
  )).rows[0].id;
  const campaign = (await pool.query<{ id: string }>(
    `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'completed', $3) RETURNING id`,
    [tenantId, `retention-${randomUUID()}`, templateVersionId],
  )).rows[0];
  const snapshot = (await pool.query<{ id: string }>(
    `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
     VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 3, 3, 0) RETURNING id`,
    [tenantId, campaign.id, templateVersionId],
  )).rows[0];
  const execution = (await pool.query<{ id: string }>(
    `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status, submitted_count, delivered_count, finished_at)
     VALUES ($1, $2, $3, $4, 'completed', 1, 2, $5) RETURNING id`,
    [tenantId, campaign.id, snapshot.id, `retention-${randomUUID()}`, eventAt],
  )).rows[0];

  for (let index = 0; index < 3; index += 1) {
    const recipient = (await pool.query<{ id: string }>(
      'INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id',
      [tenantId, `retention-${index}-${randomUUID()}@example.test`],
    )).rows[0];
    const campaignRecipient = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, execution_id, merge_data_json, email_snapshot, eligibility, status)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '{}'::jsonb, 'sendable', 'delivered') RETURNING id`,
      [tenantId, campaign.id, snapshot.id, recipient.id, execution.id],
    )).rows[0];
    await pool.query(
      `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, provider_message_id, content_hash, attempted_at)
       VALUES ($1, $2, $3, 1, 'submitted', $4, repeat('7', 64), $5)`,
      [tenantId, execution.id, campaignRecipient.id, `retention-${randomUUID()}@mail.test`, eventAt],
    );
    if (index < 2) {
      await pool.query(
        `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, received_at, outcome, payload)
         VALUES ($1, 'smtp', $2, 'delivered', $3, $4, $5, $6, $6, 'applied', '{}'::jsonb)`,
        [tenantId, `retention-event-${randomUUID()}`, `retention-${randomUUID()}@mail.test`, campaignRecipient.id, execution.id, eventAt],
      );
    }
  }
  return { tenantId, executionId: execution.id };
}
```

Fixtures are seeded per test (`beforeEach`) and cleaned per test (`afterEach`), so
the idempotence test (A6) starts from a known count rather than from whatever an
earlier test left:

```ts
let shortPolicyTenantId: string;
let shortPolicyExecutionId: string;
let longPolicyTenantId: string;
let noPolicyTenantId: string;

beforeEach(async () => {
  const short = await seedTenant('retention-short', 30, FIVE_YEARS);
  shortPolicyTenantId = short.tenantId;
  shortPolicyExecutionId = short.executionId;
  longPolicyTenantId = (await seedTenant('retention-long', 3650, FIVE_YEARS)).tenantId;
  noPolicyTenantId = (await seedTenant('retention-default', null, PAST_DEFAULT)).tenantId;
});

afterEach(async () => {
  for (const tenantId of [shortPolicyTenantId, longPolicyTenantId, noPolicyTenantId]) {
    await purgeCampaignSendFixtures(pool, tenantId, 'eow_history_purge_test_cleanup');
    await pool.query('DELETE FROM retention_policy WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
  }
});

afterAll(async () => { await pool.end(); });
```

`purgeCampaignSendFixtures` already deletes `delivery_event` before
`message_attempt` before `campaign_execution` before `campaign_recipient` before
`campaign_snapshot`, with the immutability triggers disabled inside one
advisory-locked transaction — reuse it, do not hand-roll a second cleanup order.

The assertions that carry the acceptance criteria:

```ts
it('A1/A4: the tenant policy decides, not the row age', async () => {
  const results = await purgeHistoryEvents(testAppDatabaseUrl(), 365, now);

  const short = results.find((row) => row.tenantId === shortPolicyTenantId);
  expect(short?.messageAttemptsDeleted).toBe(3);
  expect(short?.deliveryEventsDeleted).toBe(2);
  expect(short?.retentionDays).toBe(30);
  expect(short?.source).toBe('policy');

  const shortRemaining = await pool.query('SELECT count(*)::int AS count FROM message_attempt WHERE tenant_id = $1', [shortPolicyTenantId]);
  expect(shortRemaining.rows[0].count).toBe(0);

  // Same 5-year-old rows, a 3650-day policy: untouched. The only difference is the policy.
  const longRemaining = await pool.query('SELECT count(*)::int AS count FROM message_attempt WHERE tenant_id = $1', [longPolicyTenantId]);
  expect(longRemaining.rows[0].count).toBe(3);
  expect(results.find((row) => row.tenantId === longPolicyTenantId)).toBeUndefined();

  // No policy row at all: the 365-day deployment default applies, and says purge.
  const fallback = results.find((row) => row.tenantId === noPolicyTenantId);
  expect(fallback?.retentionDays).toBe(365);
  expect(fallback?.source).toBe('default');
  const fallbackRemaining = await pool.query('SELECT count(*)::int AS count FROM message_attempt WHERE tenant_id = $1', [noPolicyTenantId]);
  expect(fallbackRemaining.rows[0].count).toBe(0);
});

it('A2: leaves the aggregate report identical', async () => {
  const before = await readAggregate(shortPolicyExecutionId);
  await purgeHistoryEvents(testAppDatabaseUrl(), 365, now);
  const after = await readAggregate(shortPolicyExecutionId);
  expect(after).toEqual(before);
});

it('A5: writes exactly one audit row per purging tenant', async () => {
  await purgeHistoryEvents(testAppDatabaseUrl(), 365, now);
  const audit = await pool.query(
    `SELECT actor_id, action, entity_type, metadata FROM audit_log WHERE tenant_id = $1 AND action = 'history.purged'`,
    [shortPolicyTenantId],
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0].actor_id).toBeNull();
  expect(audit.rows[0].entity_type).toBe('tenant');
  expect(audit.rows[0].metadata).toMatchObject({
    retentionDays: 30,
    source: 'policy',
    messageAttemptsDeleted: 3,
    deliveryEventsDeleted: 2,
  });
  expect(typeof audit.rows[0].metadata.cutoff).toBe('string');
  expect(audit.rows[0].metadata.executionsAffected).toBe(1);
});

it('A6: a second run deletes nothing and writes no further audit row', async () => {
  await purgeHistoryEvents(testAppDatabaseUrl(), 365, now);
  const second = await purgeHistoryEvents(testAppDatabaseUrl(), 365, now);
  expect(second.find((row) => row.tenantId === shortPolicyTenantId)).toBeUndefined();
  const audit = await pool.query(
    `SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND action = 'history.purged'`,
    [shortPolicyTenantId],
  );
  expect(audit.rows[0].count).toBe(1);
});
```

`readAggregate` reads exactly what the history screen reads (§0(d)), so A2 is a
statement about the real report rather than about an intermediate value:

```ts
async function readAggregate(executionId: string) {
  const result = await pool.query(
    `SELECT ce.status, ce.progress_seq, ce.pending_count, ce.queued_count, ce.submitted_count,
            ce.delivered_count, ce.bounced_count, ce.failed_count, ce.skipped_count, ce.cancelled_count,
            cs.total_snapshot, cs.sendable_count
     FROM campaign_execution ce JOIN campaign_snapshot cs ON cs.id = ce.snapshot_id
     WHERE ce.id = $1`,
    [executionId],
  );
  return result.rows[0];
}
```

Fixture ages, chosen against §0(h): purgeable rows are 60 days old (past the
30-day floor and past the aged tenant's own window); the `defaultTenant` rows are
also 60 days old, which the 365-day default protects **and** which no other
tenant's policy can reach, because the purge is per-tenant. No assertion in this
file depends on a row younger than the floor surviving a global sweep.

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @eow/worker exec vitest run src/history-purge.integration.test.ts
```

Expected: FAIL — cannot resolve `./history-purge.js`.

- [ ] **Step 3: Write the purge orchestrator**

Create `apps/worker/src/history-purge.ts`:

```ts
import pg from 'pg';
import { runInTenantTransaction } from './tenant-database.js';
import { retentionCutoff } from './retention-window.js';

/** Tenants visited per tick. Bounded like every other cross-tenant scan on this worker. */
const TENANT_SCAN_LIMIT = 25;
/** Rows deleted per table per tenant per tick: a multi-year backlog drains across ticks
 *  instead of holding locks in one statement. */
const PURGE_BATCH_ROWS = 5000;

export type HistoryPurgeResult = {
  tenantId: string;
  retentionDays: number;
  source: 'policy' | 'default';
  cutoff: Date;
  messageAttemptsDeleted: number;
  deliveryEventsDeleted: number;
  executionsAffected: number;
};

/**
 * BR-HIS-006's purge, same cross-tenant sweep shape as reconcileProgress and
 * export-scan: an unlocked SELECT over the narrow
 * purgeable_retention_tenants() boundary decides which tenants to visit,
 * then one tenant transaction per tenant deletes and audits.
 *
 * Only message_attempt/delivery_event are touched (DEC-140). campaign,
 * campaign_execution, campaign_snapshot and campaign_recipient are never
 * deleted, which is what keeps the stored 028 summary -- the only thing the
 * history report reads -- exactly as it was.
 */
export async function purgeHistoryEvents(
  databaseUrl: string,
  defaultRetentionDays: number,
  now: Date = new Date(),
): Promise<HistoryPurgeResult[]> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const due = await pool.query<{ tenant_id: string; retention_days: number; from_policy: boolean }>(
      `SELECT tenant_id, retention_days, from_policy FROM purgeable_retention_tenants($1, $2)`,
      [defaultRetentionDays, TENANT_SCAN_LIMIT],
    );

    const results: HistoryPurgeResult[] = [];
    for (const row of due.rows) {
      const cutoff = retentionCutoff(Number(row.retention_days), now);
      const source = row.from_policy ? 'policy' : 'default';
      const purged = await runInTenantTransaction(pool, row.tenant_id, async (client) => {
        const deleted = await client.query<{ message_attempts_deleted: number; delivery_events_deleted: number; executions_affected: number }>(
          `SELECT * FROM purge_message_events($1, $2, $3)`,
          [row.tenant_id, cutoff.toISOString(), PURGE_BATCH_ROWS],
        );
        const counts = deleted.rows[0];
        const total = Number(counts.message_attempts_deleted) + Number(counts.delivery_events_deleted);
        if (total === 0) return null;

        const metadata = {
          retentionDays: Number(row.retention_days),
          source,
          cutoff: cutoff.toISOString(),
          messageAttemptsDeleted: Number(counts.message_attempts_deleted),
          deliveryEventsDeleted: Number(counts.delivery_events_deleted),
          executionsAffected: Number(counts.executions_affected),
        };
        await client.query(
          `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
           VALUES ($1, NULL, 'history.purged', 'tenant', $1, $2, $3::jsonb)`,
          [row.tenant_id, `history-purge:${row.tenant_id}:${cutoff.toISOString()}`, JSON.stringify(metadata)],
        );
        return metadata;
      });

      if (purged) {
        results.push({
          tenantId: row.tenant_id,
          retentionDays: purged.retentionDays,
          source,
          cutoff,
          messageAttemptsDeleted: purged.messageAttemptsDeleted,
          deliveryEventsDeleted: purged.deliveryEventsDeleted,
          executionsAffected: purged.executionsAffected,
        });
      }
    }
    return results;
  } finally {
    await pool.end();
  }
}
```

Note the D-125 shape rule: `client.query` here is node-postgres, whose result is
`{ rows }` for every statement, including the `SELECT * FROM purge_message_events(...)`
above. Do not copy TypeORM's `manager.query()` unwrapping into this file.

- [ ] **Step 4: Run the integration test to verify it passes**

```bash
pnpm --filter @eow/worker exec vitest run src/history-purge.integration.test.ts
```

Expected: PASS — A1, A2, A4, A5, A6.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/history-purge.ts apps/worker/src/history-purge.integration.test.ts && git commit -m "M6-S4 CP5: audited per-tenant message-event purge (BR-HIS-006)"
```

### CP6 — wiring, with a mechanical guard, RED first

**Files:**
- Create: `packages/architecture-tests/src/job-wiring.test.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/scheduler/src/main.ts`

- [ ] **Step 1: Write the ARCH-JOB-WIRING test**

Create `packages/architecture-tests/src/job-wiring.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { read } from './repo.js';

/**
 * ARCH-JOB-WIRING: every job name the worker handles must be enqueued by the
 * scheduler, and every job name the scheduler enqueues must be handled by the
 * worker. D-87 and D-115 were both the same defect -- a `case` the scheduler
 * never enqueued (fabricated success) or a tick entry the worker answered with
 * a stub. Neither could survive this comparison.
 */
const WORKER_CASE = /case '([a-z-]+)':/g;
const SCHEDULER_ADD = /queue\.add\('([a-z-]+)'/g;

function names(source: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].map((match) => match[1]!).sort();
}

describe('ARCH-JOB-WIRING: scheduler and worker agree on every job name', () => {
  it('has no job name on only one side', () => {
    const handled = names(read('apps/worker/src/main.ts'), WORKER_CASE);
    const enqueued = names(read('apps/scheduler/src/main.ts'), SCHEDULER_ADD);
    expect(handled.length, 'no worker job cases found — the scanner path is wrong').toBeGreaterThan(0);
    expect(handled).toEqual(enqueued);
  });
});
```

- [ ] **Step 2: Run it — it passes today, and that is the point**

```bash
pnpm --filter @eow/architecture-tests exec vitest run src/job-wiring.test.ts
```

Expected: PASS (5 names on both sides). This test is the RED trigger for the next
step: adding the worker case without the scheduler entry must break it.

- [ ] **Step 3: Add the worker case, and watch the guard fail**

In `apps/worker/src/main.ts`, import the purge and add the case after
`export-scan`:

```ts
import { purgeHistoryEvents } from './history-purge.js';
import { historyRetentionDefaultDays } from './retention-window.js';
```

```ts
    case 'history-purge-scan': {
      // M6-S4 (BR-HIS-006, DEC-140/141/142). Same narrow OUTBOX_DATABASE_URL
      // boundary as every other cross-tenant scan on this worker: an
      // unlocked SELECT over purgeable_retention_tenants() decides which
      // tenants are past their own window, then a tenant transaction per
      // tenant deletes detail rows through purge_message_events() and
      // writes the one audit row that outlives them.
      const databaseUrl = process.env.OUTBOX_DATABASE_URL;
      if (!databaseUrl) throw new Error('OUTBOX_DATABASE_URL is required for the narrow cross-tenant history retention scan. Owner/superuser credentials are forbidden.');
      const results = await purgeHistoryEvents(databaseUrl, historyRetentionDefaultDays(process.env.HISTORY_EVENT_RETENTION_DAYS));
      return {
        tenantsPurged: results.length,
        messageAttemptsDeleted: results.reduce((sum, row) => sum + row.messageAttemptsDeleted, 0),
        deliveryEventsDeleted: results.reduce((sum, row) => sum + row.deliveryEventsDeleted, 0),
      };
    }
```

```bash
pnpm --filter @eow/architecture-tests exec vitest run src/job-wiring.test.ts
```

Expected: FAIL — `history-purge-scan` is handled but never enqueued.

- [ ] **Step 4: Add the scheduler entry**

In `apps/scheduler/src/main.ts`, inside the `Promise.all([...])`:

```ts
      queue.add('history-purge-scan', { bucket }, { jobId:`history-purge-scan-${bucket}`, removeOnComplete:100, removeOnFail:500 }),
```

- [ ] **Step 5: Run the guard to verify it passes**

```bash
pnpm --filter @eow/architecture-tests exec vitest run src/job-wiring.test.ts
```

Expected: PASS — 6 names on both sides (A13).

- [ ] **Step 6: Typecheck both apps**

```bash
pnpm --filter @eow/worker exec tsc -p tsconfig.json --noEmit && pnpm --filter @eow/scheduler exec tsc -p tsconfig.json --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/architecture-tests/src/job-wiring.test.ts apps/worker/src/main.ts apps/scheduler/src/main.ts && git commit -m "M6-S4 CP6: history-purge-scan wired on both sides, guarded by ARCH-JOB-WIRING (BR-HIS-006)"
```

### CP7 — contracts, deployment and documentation

**Files:**
- Modify: `contracts/openapi.yaml`
- Modify: `packages/contracts/src/openapi.d.ts` (generated)
- Modify: `compose.yaml`
- Modify: `.env.deploy.example`
- Modify: `docs/deployment/environment-variables.md`

- [ ] **Step 1: Add the two operations and two schemas**

Apply §4's YAML exactly: `/retention-policy` after `/sending-policy`, and the two
component schemas beside `SendingPolicy`/`SendingPolicyUpdateRequest`.

- [ ] **Step 2: Regenerate the client types and check compatibility**

```bash
pnpm contracts:generate && pnpm contracts:compat-check
```

Expected: `openapi-typescript` writes `packages/contracts/src/openapi.d.ts`; the
compat check reports no breaking change (this is a pure addition).

- [ ] **Step 3: Add the variable to both services in `compose.yaml`**

In the `api` service's `environment:` block, after `EXPORT_ARTIFACT_TTL_HOURS`:

```yaml
      HISTORY_EVENT_RETENTION_DAYS: ${EOW_HISTORY_EVENT_RETENTION_DAYS:-365}
```

In the `worker` service's `environment:` block, after
`EXPORT_ARTIFACT_TTL_HOURS`, add the identical line. Both are required: the API
serves the default in `GET /retention-policy`, the worker uses it as the purge
fallback, and a mismatch would make the API describe a window the purge does not
apply.

- [ ] **Step 4: Add the deployment example and the documentation row**

`.env.deploy.example`, next to `EOW_EXPORT_ARTIFACT_TTL_HOURS=72`:

```text
EOW_HISTORY_EVENT_RETENTION_DAYS=365
```

`docs/deployment/environment-variables.md`, in the same table as
`EOW_NOTIFICATION_RETENTION_DAYS`:

```markdown
| `EOW_HISTORY_EVENT_RETENTION_DAYS` | No | `365` | Default retention window, in days, for detailed message events (`message_attempt`, `delivery_event`) of tenants that have not set their own policy through `PUT /retention-policy`. Must be an integer from 30 through 3650; campaign summaries and snapshots are never purged, and no event younger than 30 days can be deleted. |
```

- [ ] **Step 5: Validate the Compose interpolation**

```bash
docker compose --env-file .env config --quiet
```

Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add contracts/openapi.yaml packages/contracts/src/openapi.d.ts compose.yaml .env.deploy.example docs/deployment/environment-variables.md && git commit -m "M6-S4 CP7: retention-policy contract, compose wiring and deployment docs (BR-HIS-006)"
```

### CP8 — full verification and close

- [ ] **Step 1: Run every package's full suite at real parallelism**

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

Compare **test and skip counts** against CP0's baseline, not just exit codes
(AGENTS.md §2). Expected deltas: api `+2 files` (`retention-schema.test.ts`,
`retention-policy.test.ts`) `+1 file` co-located (`retention.dto.test.ts`) and its
new cases; worker `+2 files` (`retention-window.test.ts`,
`history-purge.integration.test.ts`); architecture-tests `+1 file`
(`job-wiring.test.ts`); web unchanged at 23 files / 69 tests. `apps/worker`'s
`progress-reconcile.integration.test.ts` 2 failures are the disclosed D-127
exception (§0(i)) unless `task_fc02ed64` has landed.

- [ ] **Step 2: Prove the purge end-to-end against the running stack**

```bash
docker compose --env-file .env up -d --build worker scheduler --wait
```

```bash
docker compose --env-file .env logs --tail=100 worker | grep -i "history-purge"
```

Expected: the job runs on the tick without error. This is the one-command
deployment contract's own check that the new environment variable reaches the
container; a purge that finds nothing to do is the correct outcome on a fresh
stack.

- [ ] **Step 3: Typecheck and build the workspace**

```bash
pnpm typecheck && pnpm build
```

Expected: exit 0 for both.

- [ ] **Step 4: Update `traceability.csv` for `BR-HIS-006`**

Fill the row's real values: `openapi_operation_ids` =
`getRetentionPolicy;updateRetentionPolicy`; `migration_files` =
`032_history_retention.sql`; `code_paths` =
`apps/api/src/retention/retention.controller.ts;apps/api/src/retention/retention.service.ts;apps/api/src/retention/retention.repository.ts;apps/api/src/retention/dto/retention.dto.ts;apps/worker/src/history-purge.ts;apps/worker/src/retention-window.ts;apps/worker/src/main.ts;apps/scheduler/src/main.ts`;
`test_files` =
`apps/api/test/integration/retention-schema.test.ts;apps/api/test/integration/retention-policy.test.ts;apps/api/src/retention/dto/retention.dto.test.ts;apps/worker/src/retention-window.test.ts;apps/worker/src/history-purge.integration.test.ts;packages/architecture-tests/src/job-wiring.test.ts`;
`log_or_metric_or_audit` = `audit:history.purged;audit:retention_policy.updated`;
`status` = `closed`. Only after Step 1 and Step 2 have actually passed.

- [ ] **Step 5: Close the node in `state.json`**

Set `M6-S4-history-retention.status` to `"completed"` with an `evidence` array
naming: the four suites' file/test/skip counts, the migration and its lock entry,
the docker log evidence from Step 2, and the D-127 exception with its task id.
Set `currentNode` to `"M6-GATE"`. Update `updatedAt`.

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Expected: no errors.

- [ ] **Step 6: Write the handoff for the next session**

Create `.agents/runs/2026-08-10-eow-master-execplan/M6-S4-HISTORY-RETENTION-HANDOFF.md`
in the same shape as `M6-S3-HISTORY-RECOVERY-HANDOFF.md`: where to work, the
mandatory read order, what this node completed, the exact baseline numbers this
handoff is written against, every `D-*` found, and the state of `task_fc02ed64`
and the spawned `export_job` artifact task. `M6-GATE` is next, and its success
conditions (28 M6 rules closed, TC-HIS-*/TC-SEND-* mapped, UI-HIS-001/002 and the
notifications popover verified at 3 viewports, AsyncAPI conformance) are what that
session must plan against.

- [ ] **Step 7: Commit, and do not push**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/state.json .agents/runs/2026-08-10-eow-master-execplan/traceability.csv .agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md .agents/runs/2026-08-10-eow-master-execplan/M6-S4-HISTORY-RETENTION-HANDOFF.md && git commit -m "M6-S4-history-retention: completed (BR-HIS-006 closed)"
```

**Do not run `git push`.** Pushing requires separate, explicit confirmation in the
session that performs it; no earlier approval — including approval of this plan —
carries it.

---

## 7. Notes for whoever executes this

- Write every file as UTF-8 explicitly (AGENTS.md §2; `ARCH-ENCODING` enforces it).
- A checkpoint's commit body records the test **and skip** counts of whatever
  suite it ran. A suite that stopped running is not a passing suite.
- If a step's RED does not actually fail, stop: either the test is not asserting
  what it claims, or the behaviour already exists. Both are worth a `D-*` entry.
- If something outside this node's rule ownership turns out to be broken, disclose
  it (`D-*` plus a spawned task) instead of widening the node — the D-125/D-127
  precedent, reaffirmed by this node's own §0(j).
- There is no UI in this slice, so there are no screenshots to inspect. That is
  itself a claim to verify rather than assume: `apps/web`'s suite must be
  unchanged at 23 files / 69 tests, and `handoff-fidelity`/`ARCH-NO-ORPHANS` must
  still pass at CP8 (D-128's lesson).
