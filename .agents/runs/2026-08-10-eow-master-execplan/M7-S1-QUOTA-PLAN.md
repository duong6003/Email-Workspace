# M7-S1 Quota and limits — Implementation Plan

> **For Codex, working in the `m7-s1-quota` git worktree on a machine that does not have this
> conversation.** Every checkpoint is self-contained: exact file paths, exact commands, exact
> expected output. Read
> [`PARALLEL-EXECUTION-PROTOCOL-M7.md`](PARALLEL-EXECUTION-PROTOCOL-M7.md) **first** — it is
> binding, and §3 allocates the numbers this plan uses. Read
> [`PARALLEL-EXECUTION-PROTOCOL.md`](PARALLEL-EXECUTION-PROTOCOL.md) §4 for the inbox pattern.

**Node:** `M7-S1-quota` · **Rule:** `BR-CFG-006` (P0) · **Test case:** `TC-CFG-006`
**Branch:** `m7-s1-quota` · **Migration reserved:** `034` (second, if ever needed: `064`)
**`DEC-*` block:** DEC-146…DEC-150 · **`D-*` block:** D-141…D-145
**OpenAPI prefix owned:** `/sending-quota*` · **AsyncAPI:** edits nothing (channel already declared)

---

## Goal

A tenant's configured sending quota is enforced end to end: reserved when a campaign is confirmed
for send or schedule, released when it is cancelled, consumed as messages are submitted, never
oversubscribed when several campaigns are confirmed concurrently, refused with `429` and a
`application/problem+json` body when exceeded, and observable — crossing 80%, 90% and 100% of the
period's quota emits one `quota.threshold_reached` envelope and one durable notification per
threshold per period, and a `eow_quota_usage_ratio` metric line.

## Architecture

A **reservation ledger** in PostgreSQL is the single source of truth, because `BR-CFG-006`'s
acceptance is specifically about *concurrent* confirmation ("Không oversubscribe khi nhiều campaign
song song"). A derived `COUNT(*)` cannot express that: two transactions counting simultaneously
both see the pre-reservation total and both succeed. The ledger is written inside the same
transaction and the same pessimistic lock that already freezes the campaign snapshot, and quota
capacity is checked with a row lock on the tenant's quota configuration row, so the second
concurrent confirmation blocks, re-reads and correctly fails.

Enforcement therefore exists at **two** layers, matching `BR-CFG-006`'s statement
("quota được kiểm khi review **và** thực thi"):

- **API / review time** — `sendCampaign` and `scheduleCampaign` reserve `sendableCount` units and
  return `429` when the reservation would exceed the limit.
- **Worker / execution time** — the per-recipient gate in `sendClaimedBatch` consumes against the
  reservation and stops when the period's quota is exhausted, deferring the remaining recipients
  through the *existing* over-budget path rather than failing them.

Release happens at all three cancel paths that already exist. Threshold detection is a pure
function over `(before, after, limit)` so it is unit-testable without a database, and emission is
deduplicated by a ledger table keyed exactly as `catalog/realtime-events.json` specifies
(`dedupe: quota_period+threshold`).

## Where the requirement comes from — read this before changing scope

`BR-CFG-006`'s **own** acceptance text (`catalog/ba-rules.json`, and the `acceptance_summary`
column of its `traceability.csv` row) is only:

> Không oversubscribe khi nhiều campaign song song; reservation được release khi cancel.

It says nothing about 80/90/100%. The thresholds are authoritative from a different file —
`catalog/realtime-events.json`:

```json
{
  "event": "quota.threshold_reached",
  "channel": "org:{organization_id}",
  "purpose": "Configured 80/90/100 percent sending quota threshold",
  "cadence": "Per threshold",
  "dedupe": "quota_period+threshold",
  "priority": "P1"
}
```

and the notification half is pre-registered in source as M7's, unwired, at
`apps/api/src/notifications/notification-rules.ts:37`:

```ts
{ sourceEvent: 'quota.threshold', type: 'quota_threshold', severity: 'warning', category: 'quota', wired: false, owner: 'M7' },
```

`contracts/asyncapi.yaml:131-135` already declares the channel. **Both halves are in scope.** See
`PARALLEL-EXECUTION-PROTOCOL-M7.md` §8.5 for the full three-source reconciliation, including the
correction that these numbers are *not* in `catalog/notification-rules.json`.

**Name conflict you must resolve (protocol §3.5):** the emitted `event_type` is
`quota.threshold_reached` (the contract wins — `ARCH-ASYNCAPI-CONFORMANCE` matches emitted types
against declared channels and would fail on `quota.threshold`). You update the
`NOTIFICATION_TRIGGERS` entry's `sourceEvent` to match, in the same commit as its test.

## What already exists (verified at `eb5a835` — do not rebuild it)

| Thing | Where | Note |
|---|---|---|
| `sending_policy` table, one row per tenant | `database/migrations/020_sender_config.sql:26-34`, `UNIQUE (tenant_id)` | Your quota configuration columns go here. |
| `sending_policy.tenant_rate_limit_per_minute`, `batch_size`, `max_attempts` | `database/migrations/026_campaign_execution.sql:100-115` | **Already in the database but invisible to the API layer** — `apps/api/src/database/entities/sending-policy.entity.ts` does not map them and `dto/sender-config.dto.ts`'s `policySchema` does not expose them. Only the worker reads them, by raw SQL. Do not "fix" that here; it is out of this rule's scope. |
| Per-minute rate limiting (sender + tenant) | `apps/worker/src/campaign-send/rate-limiter.ts:15`, key `eow:rate:{scope}:{id}:{minuteBucket}` | Redis bucket. **Distinct from quota** — a rate limit is per-minute throughput, a quota is a per-period consumable. Do not conflate them. |
| Daily send cap (derived count, no ledger) | `apps/worker/src/campaign-send/send.ts:119-124`, `dailySubmittedCount` at `:317` | Counts `message_attempt.outcome='submitted'` since UTC midnight. Precedent for the shape, not a substitute. |
| The per-recipient gate loop your quota check joins | `apps/worker/src/campaign-send/send.ts:140-160` | Existing gates: `dailyRemaining <= 0` and `checkRateLimits(...)`, both `overBudget.push(row); continue;`. |
| Over-budget rows are deferred, not failed | `rescheduleOverBudget` at `send.ts:359` — sets `next_retry_at` to the next minute boundary, `claimed_at = NULL`, counted into `outcome.retrying` | Reuse this. Quota-blocked recipients must **not** become `failed`. |
| `429` + Problem body | `apps/api/src/common/too-many-requests.exception.ts`, filter at `apps/api/src/common/http-exception.filter.ts:32-34` (sets `Retry-After`) | Already works. `mapErrorToProblem` (`common/problem.ts:53`) emits `{type,title,status,detail,traceId}` and `extensionsFrom` (`:41-45`) spreads any structured-exception key except `message`/`statusCode`/`error`, which is how a `code` reaches the client. **You add no code to the filter.** |
| Existing `code` convention | `throw new ConflictException({ code: 'SENDER_NOT_USABLE' })` — `sender-config.service.ts:29` | Follow it: `{ code: 'QUOTA_EXCEEDED' }`. |
| Reserve point A — send now | `apps/api/src/campaigns/campaigns.service.ts:695` `sendCampaign`, freeze inside `this.idempotency.run(...)` at `:725-728` | `sendableCount` is on the `FrozenSnapshot` the freeze returns. |
| Reserve point B — schedule | `campaigns.service.ts:852` `scheduleCampaign`; validation report `buildScheduleValidationReport` declared at `:786` | `:783-785` says in prose: *"`quota` is absent by design -- no quota ledger exists until M7-S1 (DEC-088)"*. You are the node that fills that hole. |
| Release point A — cancel queued | `campaigns.service.ts:744` `cancelCampaign` | Supersedes the snapshot, campaign → `draft`. |
| Release point B — cancel schedule | `campaigns.service.ts:973` `cancelCampaignSchedule` | Campaign → `cancelled` (terminal). |
| Release point C — cancel in-flight send | `campaigns.service.ts:529` `cancelCampaignSend` | **Already computes the partial-release numbers you need**: `cancelledCount` (`:551-558`) and `submittedRow.count` (`:559-564`). Release `cancelledCount`, keep `submittedCount` consumed. |
| Outbox writer | `apps/api/src/outbox/outbox-writer.ts:20` `appendOutboxEvent(manager, {tenantId, eventType, aggregateType, aggregateId, aggregateVersion: bigint, payload})`, `.orIgnore()` against `UNIQUE (aggregate_type, aggregate_id, aggregate_version, event_type)` | Canonical call site: `campaign-snapshot.ts:207-215`. |
| Realtime gateway | `apps/api/src/realtime/realtime.gateway.ts` | Three channel prefixes exist: `eow:job:`, `eow:campaign:`, `eow:user:`. **No `eow:org:` prefix and no org room** — you add them. Note `handleConnection` already resolves `tenantId` for every connection and unconditionally does `client.join(\`user:${userId}\`)`; the org room join is the same shape and needs no new ownership check. |
| Notification creation (API side, supports `severity: 'warning'`) | `apps/api/src/notifications/notifications.service.ts:42` `createForUsers(tenantId, {sourceEventId, type, severity, title, body, category, userIds, messageKey?, params?, deepLinkRoute?, entityType?, entityId?, groupKey?, batchWindowSeconds?})` | Use this, not `apps/worker/src/notification-writer.ts` — the worker variant's `severity` union is `'success'|'critical'` only and the quota trigger needs `'warning'`. |
| Notification dedupe | `UNIQUE INDEX uq_notification_tenant_source_event ON notification (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL` — `021_notification_center.sql:12-13` | Convention is `` `${eventName}:${entityId}` ``. Yours: `` `quota.threshold_reached:${periodKey}:${threshold}` ``. |
| Metric pattern (there is **no** metrics library) | `apps/worker/src/progress-metrics.ts:8-26` — an exported type plus an exported pure function returning a flat `Record` with a `metric:` name key and a `value:` key | `eow_progress_reconcile_drift` is the only `eow_`-prefixed metric that exists. Follow this shape exactly; do **not** add `prom-client`. Protocol §8.2: the real registry is M7-S3's, and wiring this metric into it is a post-merge follow-up, not your work. |
| `ENVELOPE_SOURCES` allow-list | `packages/architecture-tests/src/asyncapi-conformance.test.ts:28-34` | Your new envelope-building file must be appended here or the conformance rule cannot see it. Protocol §3.4: **you are the only node that appends to this list.** |
| Integration-test shape to copy | `apps/api/test/integration/sender-config-http.test.ts:34-62` | Env set *before* a dynamic `import('../../src/app.module.js')`; unique tenant via `randomUUID()`; FK-ordered teardown scoped to `tenant.id`; explicit `30_000` hook timeout; `login()` helper at `:64` returning `{cookie, csrfToken}`. |

## Tech stack

TypeScript (ESM, `node >= 22.13`), NestJS, TypeORM + raw `manager.query` with `$1..$n`
parameters, PostgreSQL 17 with row-level security, `ioredis`, BullMQ, Vitest, zod for DTOs.

## File structure

**Create:**

| File | Responsibility |
|---|---|
| `database/migrations/034_sending_quota.sql` | Quota configuration columns on `sending_policy`; `quota_reservation` ledger; `quota_threshold_emission` dedupe ledger; RLS + `eow_app` grants. |
| `apps/api/src/quota/quota-period.ts` | Pure: `periodKeyFor(now, period)` → `'2026-08'` / `'2026-08-19'`. No I/O. |
| `apps/api/src/quota/quota-threshold.ts` | Pure: `crossedThresholds(before, after, limit)` → `(80|90|100)[]`. No I/O. |
| `apps/api/src/quota/quota-metrics.ts` | Pure: `quotaUsageRatioMetric(...)` → the `eow_quota_usage_ratio` log payload. |
| `apps/api/src/quota/quota.repository.ts` | All SQL: locked config read, reserve, release, consume, usage read, threshold-emission claim. |
| `apps/api/src/quota/quota.service.ts` | Orchestration: reserve/release/usage, threshold detection, outbox append, notification creation, metric emission. |
| `apps/api/src/quota/quota.controller.ts` | `GET/PUT /sending-quota`, `GET /sending-quota/usage`. |
| `apps/api/src/quota/quota-event.ts` | Builds the `quota.threshold_reached` `EventEnvelope`. **This is the file that goes into `ENVELOPE_SOURCES`.** |
| `apps/api/src/quota/quota-org-publisher.ts` | Publishes the envelope to Redis channel `eow:org:{tenantId}`. |
| `apps/api/src/quota/dto/quota.dto.ts` | zod schemas + response types. |
| `apps/api/src/quota/quota.module.ts` | Nest module. |
| `apps/api/src/database/entities/quota-reservation.entity.ts` | TypeORM mapping for the ledger. |
| `apps/api/test/integration/sending-quota-http.test.ts` | HTTP surface: config CRUD, `429` + Problem body, cross-tenant negative. |
| `apps/api/test/integration/quota-reservation.test.ts` | Concurrency (the P0 acceptance), release-on-cancel, RLS via `eow_app`. |
| `apps/api/test/integration/quota-threshold-emission.test.ts` | Threshold event + notification + dedupe, end to end. |
| `apps/worker/src/campaign-send/quota-consume.integration.test.ts` | Worker-side enforcement and deferral. |

**Modify:**

| File | Change |
|---|---|
| `apps/api/src/database/entities/sending-policy.entity.ts` | Map the two new quota columns. |
| `apps/api/src/app.module.ts` | Append `QuotaModule` (append only — protocol §3.6). |
| `apps/api/src/config/env.ts` | Append `SENDING_QUOTA_DEFAULT_PERIOD` (append inside `z.object`, above its closing `});`). |
| `apps/api/src/campaigns/campaigns.service.ts` | Reserve in `sendCampaign` + `scheduleCampaign`; release in `cancelCampaign`, `cancelCampaignSchedule`, `cancelCampaignSend`; add `quota` to `buildScheduleValidationReport`. |
| `apps/api/src/campaigns/campaigns.module.ts` | Import `QuotaModule`. |
| `apps/api/src/realtime/realtime.gateway.ts` | Add `ORG_CHANNEL_PREFIX`, extend `psubscribe`, extend `roomForChannel`, join `org:{tenantId}` in `handleConnection`. |
| `apps/api/src/notifications/notification-rules.ts` | Quota trigger: `sourceEvent` → `'quota.threshold_reached'`, `wired` → `true`. |
| `apps/api/src/notifications/notification-rules.test.ts` | Update the BR-NOT-014 assertion to the new `sourceEvent`. |
| `apps/worker/src/campaign-send/send.ts` | Quota gate in the per-recipient loop; consume on submit. |
| `contracts/openapi.yaml` | Append `/sending-quota`, `/sending-quota/usage` + schemas. One commit, late. |
| `packages/architecture-tests/src/asyncapi-conformance.test.ts` | Append `apps/api/src/quota/quota-event.ts` to `ENVELOPE_SOURCES`. |
| `database/migrations.lock.json` | Append the 034 checksum. |
| `.agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md` | One section per checkpoint. |

**Must NOT touch:** `apps/web/**` (protocol §1.1), `contracts/asyncapi.yaml`, `catalog/**`,
`state.json`, `traceability.csv`, `screen-catalog.yaml`, `EXECPLAN.md`,
`apps/worker/src/campaign-send/run.ts` (M7-S3's), `apps/api/src/common/permissions.ts` (M7-S2's),
`apps/api/src/main.ts` / `apps/worker/src/main.ts` (M7-S3/M7-S4's),
`apps/api/src/common/http-exception.filter.ts` (M7-S3's).

---

## Checkpoint 0 — Establish the baseline (no code)

- [ ] **Step 1: Create the worktree and bootstrap it**

From the root clone:

```bash
git fetch origin && git checkout main && git pull --ff-only origin main
git worktree add -b m7-s1-quota ../eow-m7-s1 main
```

Then, in `../eow-m7-s1`:

```bash
pnpm install --frozen-lockfile
```

Copy `.env` from the root clone into the worktree root (it is gitignored and holds the local
PostgreSQL/Redis passwords; without it the test URL helpers throw). Then:

```bash
pnpm infra:up
```

- [ ] **Step 2: Record the real baseline**

```bash
pnpm --filter @eow/api build
pnpm check
```

Expected: exit 0. Write down the **file and test counts per package** exactly as printed. The
protocol's table (`apps/api` 89/644, `apps/worker` 30/143, `packages/architecture-tests` 15/114,
`apps/web` 23/73) is what a previous run measured — **your printed numbers are your baseline**,
not that table. `scripts/no-skipped-tests-reporter.mjs` fails on any skipped test, so a green run
means zero skips.

If `packages/architecture-tests`'s `migration-runner-behavior.test.ts` times out, re-run that file
alone (`pnpm --filter @eow/architecture-tests test -- src/migration-runner-behavior.test.ts`)
before treating it as a failure — it starts real containers and is host-load sensitive
(`EXECPLAN` D-132).

- [ ] **Step 3: Open the inbox file and commit**

Create `.agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md`:

```markdown
# M7-S1 quota checkpoint inbox

## Checkpoint 0 — baseline
**Status after this checkpoint:** running
**nextAction:** Migration 034 + entity mapping (CP1).

### Evidence (verbatim, for state.json)
- Worktree `m7-s1-quota` created from `main` at <commit sha>; `pnpm install --frozen-lockfile` clean.
- `pnpm check` exit 0. Baseline counts: apps/api <F>/<T>, apps/worker <F>/<T>, apps/web <F>/<T>, packages/architecture-tests <F>/<T>, 0 skipped.

### traceability.csv rows to update
(none)

### screen-catalog.yaml changes
None — this node touches no front-end file (PARALLEL-EXECUTION-PROTOCOL-M7 §1.1).

### EXECPLAN entries
(none)
```

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md
git commit -m "M7-S1 CP0: baseline recorded before quota work

pnpm check exit 0. Counts: apps/api <F>/<T>, apps/worker <F>/<T>,
apps/web <F>/<T>, packages/architecture-tests <F>/<T>, 0 skipped."
```

---

## Checkpoint 1 — Migration 034 and the ledger schema

**Files:**
- Create: `database/migrations/034_sending_quota.sql`
- Create: `apps/api/src/database/entities/quota-reservation.entity.ts`
- Modify: `apps/api/src/database/entities/sending-policy.entity.ts`
- Modify: `database/migrations.lock.json`
- Create: `apps/api/test/integration/quota-reservation.test.ts` (RLS half only in this checkpoint)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/quota-reservation.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { testAppDatabaseUrl, testDatabaseUrl } from './test-database-url.js';

describe('BR-CFG-006: quota_reservation is tenant-isolated under the eow_app role', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl() });
    app = new pg.Pool({ connectionString: testAppDatabaseUrl() });
    const a = await owner.query(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [`quota-res-a-${randomUUID()}`]);
    const b = await owner.query(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [`quota-res-b-${randomUUID()}`]);
    tenantA = a.rows[0].id;
    tenantB = b.rows[0].id;
    for (const t of [tenantA, tenantB]) {
      await owner.query(
        `INSERT INTO quota_reservation (tenant_id, campaign_id, period_key, amount, state)
         VALUES ($1, $2, '2026-08', 10, 'held')`,
        [t, randomUUID()],
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (owner) {
      await owner.query(`DELETE FROM quota_reservation WHERE tenant_id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
      await owner.query(`DELETE FROM tenant WHERE id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
    }
    await app?.end();
    await owner?.end();
  }, 60_000);

  it('sees only its own tenant rows through the narrow eow_app role', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      const rows = await client.query(`SELECT tenant_id::text FROM quota_reservation`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].tenant_id).toBe(tenantA);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('rejects an amount of zero or less', async () => {
    await expect(
      owner.query(
        `INSERT INTO quota_reservation (tenant_id, campaign_id, period_key, amount, state)
         VALUES ($1, $2, '2026-08', 0, 'held')`,
        [tenantA, randomUUID()],
      ),
    ).rejects.toThrow(/quota_reservation_amount_positive/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
pnpm --filter @eow/api test -- test/integration/quota-reservation.test.ts
```

Expected: FAIL in `beforeAll` with `relation "quota_reservation" does not exist`.

- [ ] **Step 3: Write migration 034**

Create `database/migrations/034_sending_quota.sql`. It must be a plain SQL file with **no psql
meta-commands and no transaction control** — `database/migrate.sh`'s `migration_source_is_safe()`
guard (lines 52-195) rejects both, and the runner wraps every file in its own transaction.

```sql
-- 034_sending_quota.sql
-- BR-CFG-006 (M7-S1). "Moi sender/tenant co quota va rate limit cau hinh; quota
-- duoc kiem khi review va thuc thi." Acceptance: "Khong oversubscribe khi nhieu
-- campaign song song; reservation duoc release khi cancel."
--
-- A derived COUNT(*) cannot satisfy the concurrency half: two transactions
-- counting at the same instant both see the pre-reservation total and both
-- succeed. So capacity lives in a ledger, and the capacity check takes a row
-- lock on the tenant's sending_policy row, which serialises confirmations
-- per tenant without serialising anything else.
--
-- The per-minute rate limits already on sending_policy (026) are a DIFFERENT
-- mechanism (throughput) and are deliberately untouched here.

ALTER TABLE sending_policy
  ADD COLUMN IF NOT EXISTS send_quota_limit integer,
  ADD COLUMN IF NOT EXISTS send_quota_period text NOT NULL DEFAULT 'month';

ALTER TABLE sending_policy
  ADD CONSTRAINT sending_policy_quota_limit_positive
    CHECK (send_quota_limit IS NULL OR send_quota_limit > 0),
  ADD CONSTRAINT sending_policy_quota_period_values
    CHECK (send_quota_period IN ('day', 'month'));

COMMENT ON COLUMN sending_policy.send_quota_limit IS
  'BR-CFG-006: messages allowed per send_quota_period. NULL means unlimited, which is the pre-M7-S1 behaviour and therefore the safe default for every existing tenant.';

CREATE TABLE IF NOT EXISTS quota_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  campaign_id uuid NOT NULL,
  snapshot_id uuid,
  period_key text NOT NULL,
  amount integer NOT NULL,
  consumed integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'held',
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT quota_reservation_amount_positive CHECK (amount > 0),
  CONSTRAINT quota_reservation_consumed_range CHECK (consumed >= 0 AND consumed <= amount),
  CONSTRAINT quota_reservation_state_values CHECK (state IN ('held', 'released')),
  CONSTRAINT quota_reservation_released_consistent
    CHECK ((state = 'released') = (released_at IS NOT NULL))
);

-- One live hold per campaign per period. A duplicate confirmation (the
-- idempotency replay path in campaigns.service.ts) must not double-reserve,
-- and this index -- not application logic -- is what guarantees it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_quota_reservation_live
  ON quota_reservation (tenant_id, campaign_id, period_key)
  WHERE state = 'held';

CREATE INDEX IF NOT EXISTS idx_quota_reservation_period
  ON quota_reservation (tenant_id, period_key)
  WHERE state = 'held';

-- catalog/realtime-events.json declares dedupe = "quota_period+threshold" for
-- quota.threshold_reached. This table IS that dedupe key, so a threshold can
-- fire at most once per tenant per period regardless of how many concurrent
-- reservations cross it.
CREATE TABLE IF NOT EXISTS quota_threshold_emission (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  period_key text NOT NULL,
  threshold integer NOT NULL,
  emitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period_key, threshold),
  CONSTRAINT quota_threshold_emission_values CHECK (threshold IN (80, 90, 100))
);

ALTER TABLE quota_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_reservation FORCE ROW LEVEL SECURITY;
CREATE POLICY quota_reservation_tenant_isolation ON quota_reservation
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE quota_threshold_emission ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_threshold_emission FORCE ROW LEVEL SECURITY;
CREATE POLICY quota_threshold_emission_tenant_isolation ON quota_threshold_emission
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON quota_reservation TO eow_app;
GRANT SELECT, INSERT ON quota_threshold_emission TO eow_app;
```

> Check `current_tenant_id()`'s exact name against an existing RLS policy before you commit —
> open `database/migrations/020_sender_config.sql` and copy the function name and policy shape it
> uses verbatim. If it differs, the migration is wrong, not the precedent.

- [ ] **Step 4: Apply the migration and record its checksum**

```bash
docker compose --env-file .env up migrate --exit-code-from migrate
```

or, if you prefer running the runner directly, follow the invocation `compose.yaml`'s `migrate`
service uses (`sh /database/migrate.sh` with `PGPASSWORD`, `EOW_POSTGRES_APP_PASSWORD` and the
usual `PG*` variables set).

Then compute and append the checksum:

```bash
sha256sum database/migrations/034_sending_quota.sql
```

Add that exact hash under the key `034_sending_quota.sql` in `database/migrations.lock.json`,
matching the existing entries' formatting. Verify:

```bash
pnpm --filter @eow/architecture-tests test -- src/migration-immutability.test.ts
```

Expected: PASS (`ARCH-MIGRATION`).

- [ ] **Step 5: Map the entities**

Create `apps/api/src/database/entities/quota-reservation.entity.ts` following the shape of
`apps/api/src/database/entities/sending-policy.entity.ts` (same decorators, same
`snake_case`→`camelCase` column naming), mapping: `id`, `tenantId`, `campaignId`, `snapshotId`,
`periodKey`, `amount`, `consumed`, `state`, `createdAt`, `releasedAt`.

Add to `apps/api/src/database/entities/sending-policy.entity.ts`:

```ts
  @Column({ name: 'send_quota_limit', type: 'int', nullable: true })
  sendQuotaLimit!: number | null;

  @Column({ name: 'send_quota_period', type: 'text', default: 'month' })
  sendQuotaPeriod!: 'day' | 'month';
```

Register `QuotaReservationEntity` in the TypeORM entity list wherever the other entities are
registered (find it with `grep -rn "SendingPolicyEntity" apps/api/src --include=*.ts | grep -v test`).

- [ ] **Step 6: Run the test to verify it passes**

```bash
pnpm --filter @eow/api test -- test/integration/quota-reservation.test.ts
```

Expected: PASS, 2 tests.

```bash
pnpm --filter @eow/api typecheck
```

Expected: exit 0.

- [ ] **Step 7: Append to the inbox and commit**

Inbox section `## Checkpoint 1 — migration 034 + ledger schema`, status `running`, with the
`sha256sum` output verbatim in the evidence list and the traceability row for `BR-CFG-006` with
`migration_files: 034_sending_quota.sql` and `status: in_progress`.

```bash
git add database/migrations/034_sending_quota.sql database/migrations.lock.json \
        apps/api/src/database/entities/ apps/api/test/integration/quota-reservation.test.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md
git commit -m "M7-S1 CP1: migration 034 quota reservation ledger

BR-CFG-006 needs a ledger, not a derived count: two concurrent
confirmations counting simultaneously both see the pre-reservation
total. uq_quota_reservation_live makes a duplicate hold impossible in
the database rather than in application logic, and
quota_threshold_emission is catalog/realtime-events.json's declared
dedupe key (quota_period+threshold) made physical.

Tests: 2/2 in apps/api/test/integration/quota-reservation.test.ts.
ARCH-MIGRATION green."
```

---

## Checkpoint 2 — Pure period and threshold functions

**Files:**
- Create: `apps/api/src/quota/quota-period.ts`, `apps/api/src/quota/quota-period.test.ts`
- Create: `apps/api/src/quota/quota-threshold.ts`, `apps/api/src/quota/quota-threshold.test.ts`

These are pure, need no database, and run in milliseconds. Doing them first means the SQL
checkpoints have nothing left to reason about except SQL.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/quota/quota-period.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { periodKeyFor } from './quota-period.js';

describe('BR-CFG-006: quota period keys', () => {
  it('derives a month key in UTC', () => {
    expect(periodKeyFor(new Date('2026-08-19T23:30:00Z'), 'month')).toBe('2026-08');
  });

  it('derives a day key in UTC', () => {
    expect(periodKeyFor(new Date('2026-08-19T23:30:00Z'), 'day')).toBe('2026-08-19');
  });

  it('does not shift the key by the host timezone', () => {
    // 2026-08-31T23:30Z is still August in UTC even where the host is UTC+7
    // and the wall clock already reads September. Storage is UTC
    // (project.manifest.yaml authoritative_timezone_storage) so the key is too.
    expect(periodKeyFor(new Date('2026-08-31T23:30:00Z'), 'month')).toBe('2026-08');
    expect(periodKeyFor(new Date('2026-09-01T00:30:00Z'), 'month')).toBe('2026-09');
  });
});
```

`apps/api/src/quota/quota-threshold.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { crossedThresholds } from './quota-threshold.js';

describe('BR-CFG-006: 80/90/100 percent threshold crossing', () => {
  it('reports nothing below 80 percent', () => {
    expect(crossedThresholds(0, 79, 100)).toEqual([]);
  });

  it('reports 80 exactly once when usage first reaches it', () => {
    expect(crossedThresholds(79, 80, 100)).toEqual([80]);
    expect(crossedThresholds(80, 85, 100)).toEqual([]);
  });

  it('reports every threshold a single large jump skips over', () => {
    // One 100-unit campaign confirmed against an empty quota crosses all
    // three at once. Emitting only the highest would lose the 80 and 90
    // notifications catalog/realtime-events.json says fire "per threshold".
    expect(crossedThresholds(0, 100, 100)).toEqual([80, 90, 100]);
  });

  it('reports 100 when usage exceeds the limit, not a fourth threshold', () => {
    expect(crossedThresholds(95, 140, 100)).toEqual([100]);
  });

  it('reports nothing when the limit is null or zero', () => {
    expect(crossedThresholds(0, 500, null)).toEqual([]);
    expect(crossedThresholds(0, 500, 0)).toEqual([]);
  });

  it('never reports a threshold when usage goes down', () => {
    // A release lowers usage. It must not re-arm or re-emit anything.
    expect(crossedThresholds(95, 10, 100)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

```bash
pnpm --filter @eow/api test -- src/quota/quota-period.test.ts src/quota/quota-threshold.test.ts
```

Expected: FAIL — `Failed to resolve import "./quota-period.js"`.

- [ ] **Step 3: Write the implementations**

`apps/api/src/quota/quota-period.ts`:

```ts
export type QuotaPeriod = 'day' | 'month';

/**
 * BR-CFG-006. The period key is derived in UTC, matching
 * project.manifest.yaml's authoritative_timezone_storage: UTC. Deriving it
 * from the host's local calendar would give two hosts in different zones two
 * different keys for the same instant, which would silently split one
 * tenant's quota into two.
 */
export function periodKeyFor(now: Date, period: QuotaPeriod): string {
  const iso = now.toISOString();
  return period === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}
```

`apps/api/src/quota/quota-threshold.ts`:

```ts
export const QUOTA_THRESHOLDS = [80, 90, 100] as const;
export type QuotaThreshold = (typeof QUOTA_THRESHOLDS)[number];

/**
 * BR-CFG-006 / catalog/realtime-events.json ("Configured 80/90/100 percent
 * sending quota threshold", cadence "Per threshold"). Returns every threshold
 * the move from `before` to `after` newly reaches, ascending.
 *
 * A single confirmation can cross more than one threshold at once, so this
 * returns an array rather than the highest crossed value -- emitting only the
 * highest would drop the 80 and 90 notifications the catalog says fire per
 * threshold. Downward moves (a release) return nothing: a release lowers
 * usage and must never re-arm or re-emit.
 */
export function crossedThresholds(before: number, after: number, limit: number | null): QuotaThreshold[] {
  if (limit === null || limit <= 0) return [];
  if (after <= before) return [];
  const ratio = (value: number) => (value / limit) * 100;
  return QUOTA_THRESHOLDS.filter((threshold) => ratio(before) < threshold && ratio(after) >= threshold);
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm --filter @eow/api test -- src/quota/quota-period.test.ts src/quota/quota-threshold.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/quota/ .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md
git commit -m "M7-S1 CP2: pure period-key and threshold-crossing functions

crossedThresholds returns an array, not the highest crossed value: one
100-unit confirmation against an empty quota crosses 80, 90 and 100 at
once, and catalog/realtime-events.json says the event fires 'Per
threshold'. Downward moves return nothing so a release never re-arms.

9/9 tests."
```

---

## Checkpoint 3 — The repository: locked capacity check and reserve

**Files:**
- Create: `apps/api/src/quota/quota.repository.ts`
- Modify: `apps/api/test/integration/quota-reservation.test.ts` (add the concurrency case — this
  is `BR-CFG-006`'s P0 acceptance and `TC-CFG-006`'s own expectation)

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/integration/quota-reservation.test.ts` a second `describe`. This test is
the whole point of the node; write it before the code it exercises.

```ts
describe('TC-CFG-006: concurrent confirmations do not oversubscribe', () => {
  let owner: pg.Pool;
  let tenantId: string;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testAppDatabaseUrl() });
    const ownerPool = new pg.Pool({ connectionString: testDatabaseUrl() });
    const t = await ownerPool.query(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [`quota-conc-${randomUUID()}`]);
    tenantId = t.rows[0].id;
    await ownerPool.query(
      `INSERT INTO sending_policy (tenant_id, send_quota_limit, send_quota_period, updated_by)
       VALUES ($1, 100, 'month', NULL)`,
      [tenantId],
    );
    await ownerPool.end();
  }, 60_000);

  afterAll(async () => {
    const ownerPool = new pg.Pool({ connectionString: testDatabaseUrl() });
    await ownerPool.query(`DELETE FROM quota_reservation WHERE tenant_id = $1`, [tenantId]);
    await ownerPool.query(`DELETE FROM sending_policy WHERE tenant_id = $1`, [tenantId]);
    await ownerPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
    await ownerPool.end();
    await owner?.end();
  }, 60_000);

  it('admits the first 60-unit hold and refuses the second, leaving usage at 60', async () => {
    const attempt = async (campaignId: string) => {
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        const repository = new QuotaRepository(client);
        const outcome = await repository.reserve(tenantId, campaignId, null, '2026-08', 60);
        await client.query('COMMIT');
        return outcome;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    const [first, second] = await Promise.all([
      attempt(randomUUID()).catch((error: Error) => error),
      attempt(randomUUID()).catch((error: Error) => error),
    ]);

    const outcomes = [first, second].filter((r): r is { admitted: boolean; usedAfter: number } => !(r instanceof Error));
    expect(outcomes).toHaveLength(2);
    // Exactly one admitted. Both admitted would be the oversubscription
    // BR-CFG-006 forbids; neither admitted would be a deadlock, not a limit.
    expect(outcomes.filter((o) => o.admitted)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.admitted)).toHaveLength(1);

    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const used = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::int AS used FROM quota_reservation WHERE tenant_id = $1 AND period_key = '2026-08' AND state = 'held'`,
        [tenantId],
      );
      expect(used.rows[0].used).toBe(60);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }, 30_000);
});
```

Add `import { QuotaRepository } from '../../src/quota/quota.repository.js';` to the file's imports.

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm --filter @eow/api test -- test/integration/quota-reservation.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/quota/quota.repository.js"`.

- [ ] **Step 3: Write the repository**

Create `apps/api/src/quota/quota.repository.ts`. It takes a client/manager with a `query` method
so it works from both the Nest `EntityManager` and a raw `pg.PoolClient` (which is what makes the
concurrency test above possible without booting Nest twice).

```ts
export type QuotaQueryable = { query(sql: string, params?: unknown[]): Promise<unknown> };

export type QuotaConfig = { limit: number | null; period: 'day' | 'month' };
export type ReserveOutcome = { admitted: boolean; limit: number | null; usedBefore: number; usedAfter: number };

type Row = Record<string, unknown>;

function rows(result: unknown): Row[] {
  // TypeORM's manager.query() returns [rows, affectedCount] for
  // DELETE/UPDATE ... RETURNING but a bare array for SELECT, while pg's
  // client.query() returns { rows }. Normalising here once is what keeps
  // D-125's whole family of RETURNING-count mistakes out of this module.
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Row[] }).rows;
  }
  return [];
}

export class QuotaRepository {
  constructor(private readonly db: QuotaQueryable) {}

  /**
   * BR-CFG-006's concurrency half. The FOR UPDATE on the tenant's single
   * sending_policy row (020's UNIQUE (tenant_id)) is what serialises two
   * simultaneous confirmations for the same tenant: the second blocks here,
   * then re-reads the ledger and sees the first one's hold. Without the lock
   * both would read the same pre-reservation total and both would be
   * admitted, which is exactly the oversubscription this rule forbids.
   *
   * A tenant with no sending_policy row has no configured quota, which means
   * unlimited -- the pre-M7-S1 behaviour, and the only safe default for
   * existing tenants.
   */
  async lockConfig(tenantId: string): Promise<QuotaConfig> {
    const result = rows(await this.db.query(
      `SELECT send_quota_limit, send_quota_period FROM sending_policy WHERE tenant_id = $1 FOR UPDATE`,
      [tenantId],
    ));
    if (result.length === 0) return { limit: null, period: 'month' };
    return {
      limit: result[0].send_quota_limit === null ? null : Number(result[0].send_quota_limit),
      period: (result[0].send_quota_period as 'day' | 'month') ?? 'month',
    };
  }

  async usedInPeriod(tenantId: string, periodKey: string): Promise<number> {
    const result = rows(await this.db.query(
      `SELECT COALESCE(SUM(amount), 0)::int AS used
         FROM quota_reservation
        WHERE tenant_id = $1 AND period_key = $2 AND state = 'held'`,
      [tenantId, periodKey],
    ));
    return Number(result[0]?.used ?? 0);
  }

  /**
   * Idempotent by uq_quota_reservation_live: a replayed confirmation for the
   * same (tenant, campaign, period) does not double-reserve. ON CONFLICT DO
   * NOTHING plus a RETURNING-emptiness check is how we tell a fresh hold from
   * a replay without a second round trip.
   */
  async reserve(
    tenantId: string,
    campaignId: string,
    snapshotId: string | null,
    periodKey: string,
    amount: number,
  ): Promise<ReserveOutcome> {
    const config = await this.lockConfig(tenantId);
    const usedBefore = await this.usedInPeriod(tenantId, periodKey);

    if (config.limit !== null && usedBefore + amount > config.limit) {
      return { admitted: false, limit: config.limit, usedBefore, usedAfter: usedBefore };
    }

    const inserted = rows(await this.db.query(
      `INSERT INTO quota_reservation (tenant_id, campaign_id, snapshot_id, period_key, amount, state)
            VALUES ($1, $2, $3, $4, $5, 'held')
       ON CONFLICT (tenant_id, campaign_id, period_key) WHERE state = 'held' DO NOTHING
         RETURNING id::text`,
      [tenantId, campaignId, snapshotId, periodKey, amount],
    ));

    const usedAfter = inserted.length === 0 ? usedBefore : usedBefore + amount;
    return { admitted: true, limit: config.limit, usedBefore, usedAfter };
  }

  /**
   * BR-CFG-006's other half: "reservation duoc release khi cancel". Releasing
   * is a state transition, never a DELETE -- the row is the audit trail of a
   * hold that existed, and history/recovery reads it.
   */
  async release(tenantId: string, campaignId: string, periodKey: string): Promise<number> {
    const released = rows(await this.db.query(
      `UPDATE quota_reservation
          SET state = 'released', released_at = now()
        WHERE tenant_id = $1 AND campaign_id = $2 AND period_key = $3 AND state = 'held'
      RETURNING amount`,
      [tenantId, campaignId, periodKey],
    ));
    return released.reduce((total, row) => total + Number(row.amount ?? 0), 0);
  }

  /** Partial release, for cancelCampaignSend: submitted units stay consumed. */
  async releasePartial(tenantId: string, campaignId: string, periodKey: string, keepConsumed: number): Promise<number> {
    const updated = rows(await this.db.query(
      `UPDATE quota_reservation
          SET amount = GREATEST($4, 1), consumed = LEAST(consumed, GREATEST($4, 1))
        WHERE tenant_id = $1 AND campaign_id = $2 AND period_key = $3 AND state = 'held'
      RETURNING amount`,
      [tenantId, campaignId, periodKey, keepConsumed],
    ));
    return updated.reduce((total, row) => total + Number(row.amount ?? 0), 0);
  }

  /** Records that a threshold fired. Returns false if it already had. */
  async claimThreshold(tenantId: string, periodKey: string, threshold: number): Promise<boolean> {
    const claimed = rows(await this.db.query(
      `INSERT INTO quota_threshold_emission (tenant_id, period_key, threshold)
            VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, period_key, threshold) DO NOTHING
         RETURNING threshold`,
      [tenantId, periodKey, threshold],
    ));
    return claimed.length > 0;
  }
}
```

> `rows()` exists because of a defect this run has already fixed three times: TypeORM's
> `manager.query()` returns `[rows, affectedCount]` for `DELETE`/`UPDATE ... RETURNING`, so
> `result.length` is always `2`. See `EXECPLAN` D-125 and commit `279708f`. Do not remove it and
> do not use `result.length` directly anywhere in this module.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @eow/api test -- test/integration/quota-reservation.test.ts
```

Expected: PASS, 3 tests. The concurrency test must show exactly one admitted and a final usage of
`60`.

Run it **three times**. A concurrency test that passes once may be passing by scheduling luck:

```bash
for i in 1 2 3; do pnpm --filter @eow/api test -- test/integration/quota-reservation.test.ts; done
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/quota/quota.repository.ts apps/api/test/integration/quota-reservation.test.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md
git commit -m "M7-S1 CP3: quota repository with locked capacity check

The FOR UPDATE on the tenant's single sending_policy row is what makes
BR-CFG-006's 'khong oversubscribe khi nhieu campaign song song' true:
the second concurrent confirmation blocks, re-reads the ledger and is
correctly refused. Proven by a real two-connection Promise.all race,
run 3x: exactly one admitted, usage lands on 60 not 120.

rows() normalises TypeORM's [rows, affectedCount] RETURNING shape --
D-125's mistake, fixed three times in this run already.

3/3 tests."
```

---

## Checkpoint 4 — The service: usage, thresholds, event, notification, metric

**Files:**
- Create: `apps/api/src/quota/quota-event.ts`, `apps/api/src/quota/quota-org-publisher.ts`,
  `apps/api/src/quota/quota-metrics.ts`, `apps/api/src/quota/quota.service.ts`,
  `apps/api/src/quota/quota.module.ts`
- Create: `apps/api/src/quota/quota-metrics.test.ts`
- Modify: `apps/api/src/notifications/notification-rules.ts`,
  `apps/api/src/notifications/notification-rules.test.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/architecture-tests/src/asyncapi-conformance.test.ts`
- Create: `apps/api/test/integration/quota-threshold-emission.test.ts`

- [ ] **Step 1: Write the failing metric unit test**

`apps/api/src/quota/quota-metrics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { quotaUsageRatioMetric } from './quota-metrics.js';

describe('BR-CFG-006 / traceability-plan runtime_evidence: eow_quota_usage_ratio', () => {
  it('emits identifiers and magnitudes only, never a recipient or a campaign name', () => {
    expect(
      quotaUsageRatioMetric({ tenantId: 't1', periodKey: '2026-08', used: 80, limit: 100, campaignId: 'c1' }),
    ).toEqual({
      metric: 'eow_quota_usage_ratio',
      tenant_id: 't1',
      period_key: '2026-08',
      campaign_id: 'c1',
      used: 80,
      limit: 100,
      value: 0.8,
    });
  });

  it('emits a null ratio rather than dividing by zero when the tenant is unlimited', () => {
    const metric = quotaUsageRatioMetric({ tenantId: 't1', periodKey: '2026-08', used: 5, limit: null, campaignId: null });
    expect(metric.value).toBeNull();
    expect(metric.limit).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing integration test for the event + notification**

`apps/api/test/integration/quota-threshold-emission.test.ts`. Boot the app exactly the way
`apps/api/test/integration/sender-config-http.test.ts:34-52` does (env before dynamic
`import('../../src/app.module.js')`, `app.setGlobalPrefix('api/v1')`, `cookieParser()`,
`app.useGlobalFilters(new HttpExceptionFilter())`, unique tenant, `30_000` hook timeout,
FK-ordered teardown). Then:

```ts
  it('BR-CFG-006: crossing 80 percent writes one outbox event and one notification', async () => {
    const service = moduleRef.get(QuotaService);
    await dataSource.query(
      `UPDATE sending_policy SET send_quota_limit = 100, send_quota_period = 'month' WHERE tenant_id = $1`,
      [tenant.id],
    );

    const outcome = await service.reserveForCampaign(null, tenant.id, campaignId, null, 80, { actorId: adminUserId });
    expect(outcome.admitted).toBe(true);

    const events = await dataSource.query(
      `SELECT event_type, payload FROM outbox_event WHERE tenant_id = $1 AND event_type = 'quota.threshold_reached'`,
      [tenant.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload.threshold).toBe(80);

    const notifications = await dataSource.query(
      `SELECT type, severity, source_event_id FROM notification WHERE tenant_id = $1 AND type = 'quota_threshold'`,
      [tenant.id],
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].severity).toBe('warning');
    expect(notifications[0].source_event_id).toBe(`quota.threshold_reached:${periodKey}:80`);
  });

  it('BR-CFG-006: a second crossing of the same threshold in the same period emits nothing new', async () => {
    // catalog/realtime-events.json declares dedupe = quota_period+threshold.
    // Releasing and re-reserving crosses 80 again; nothing new may fire.
    await dataSource.query(`UPDATE quota_reservation SET state = 'released', released_at = now() WHERE tenant_id = $1`, [tenant.id]);
    const service = moduleRef.get(QuotaService);
    await service.reserveForCampaign(null, tenant.id, secondCampaignId, null, 80, { actorId: adminUserId });

    const events = await dataSource.query(
      `SELECT id FROM outbox_event WHERE tenant_id = $1 AND event_type = 'quota.threshold_reached'`,
      [tenant.id],
    );
    expect(events).toHaveLength(1);
    const notifications = await dataSource.query(
      `SELECT id FROM notification WHERE tenant_id = $1 AND type = 'quota_threshold'`,
      [tenant.id],
    );
    expect(notifications).toHaveLength(1);
  });

  it('BR-CFG-006: one confirmation that crosses all three thresholds emits three of each', async () => {
    // A fresh tenant, quota 100, one 100-unit confirmation.
    const service = moduleRef.get(QuotaService);
    await service.reserveForCampaign(null, freshTenantId, thirdCampaignId, null, 100, { actorId: freshAdminId });
    const events = await dataSource.query(
      `SELECT payload FROM outbox_event WHERE tenant_id = $1 AND event_type = 'quota.threshold_reached' ORDER BY (payload->>'threshold')::int`,
      [freshTenantId],
    );
    expect(events.map((e: { payload: { threshold: number } }) => e.payload.threshold)).toEqual([80, 90, 100]);
  });
```

Fill in the fixture identifiers (`campaignId`, `secondCampaignId`, `thirdCampaignId`,
`freshTenantId`, `freshAdminId`, `periodKey`, `adminUserId`) in the `beforeAll`, creating real
`tenant`, `app_user` (role `admin`, `status` `active`, `passwordHash` via the same `hashPassword`
helper the sender-config test uses) and `sending_policy` rows. Derive `periodKey` with
`periodKeyFor(new Date(), 'month')` so the test does not drift across a month boundary.

- [ ] **Step 3: Run both and confirm they fail**

```bash
pnpm --filter @eow/api test -- src/quota/quota-metrics.test.ts test/integration/quota-threshold-emission.test.ts
```

Expected: FAIL on unresolved imports of `./quota-metrics.js` and `QuotaService`.

- [ ] **Step 4: Write the implementations**

`apps/api/src/quota/quota-metrics.ts` — follow `apps/worker/src/progress-metrics.ts:8-26` exactly
(exported type + exported pure function returning a flat `Record` with `metric:` and `value:`):

```ts
export type QuotaUsageMetric = {
  tenantId: string;
  periodKey: string;
  used: number;
  limit: number | null;
  campaignId: string | null;
};

/**
 * BR-CFG-006, traceability-plan.yaml runtime_evidence ("metric
 * eow_quota_usage_ratio + quota.threshold_reached event emission").
 *
 * Identifiers and magnitudes only -- no campaign name, no recipient, no
 * address (docs/operations/security-baseline.md, BR-SEC-003). Follows
 * apps/worker/src/progress-metrics.ts's precedent: no stack in this repo runs
 * a Prometheus or OTel exporter yet, so the log line IS the metric until
 * M7-S3 builds the registry.
 */
export function quotaUsageRatioMetric(metric: QuotaUsageMetric): Record<string, string | number | null> {
  return {
    metric: 'eow_quota_usage_ratio',
    tenant_id: metric.tenantId,
    period_key: metric.periodKey,
    campaign_id: metric.campaignId,
    used: metric.used,
    limit: metric.limit,
    value: metric.limit === null || metric.limit <= 0 ? null : metric.used / metric.limit,
  };
}
```

`apps/api/src/quota/quota-event.ts` — the envelope builder. Its shape must satisfy
`contracts/asyncapi.yaml`'s `EventEnvelope`
(`required: [event_id, event_type, occurred_at, tenant_id, version, data]`, optional
`aggregate_id`, `trace_id`):

```ts
import { randomUUID } from 'node:crypto';

export type QuotaThresholdEventInput = {
  tenantId: string;
  periodKey: string;
  threshold: number;
  used: number;
  limit: number;
  campaignId: string | null;
  traceId?: string;
};

/**
 * catalog/realtime-events.json: event "quota.threshold_reached", channel
 * "org:{organization_id}", cadence "Per threshold", dedupe
 * "quota_period+threshold". contracts/asyncapi.yaml:131-135 already declares
 * the channel; this is its first implementation.
 *
 * The event_type string must stay literal and must match the declared
 * address: ARCH-ASYNCAPI-CONFORMANCE scans this file for `event_type: '...'`
 * and fails if the type has no declared channel. This file is listed in that
 * rule's ENVELOPE_SOURCES allow-list.
 */
export function buildQuotaThresholdEvent(input: QuotaThresholdEventInput) {
  return {
    event_id: randomUUID(),
    event_type: 'quota.threshold_reached',
    occurred_at: new Date().toISOString(),
    tenant_id: input.tenantId,
    aggregate_id: input.campaignId,
    version: 1,
    trace_id: input.traceId ?? null,
    data: {
      period_key: input.periodKey,
      threshold: input.threshold,
      used: input.used,
      limit: input.limit,
    },
  };
}
```

`apps/api/src/quota/quota-org-publisher.ts` — publish to `eow:org:{tenantId}`, following
`apps/worker/src/redis-campaign-event-publisher.ts`'s shape (a `channel(id)` helper plus a
`create...Publisher(connection)` factory):

```ts
import type { Redis } from 'ioredis';

export const ORG_CHANNEL_PREFIX = 'eow:org:';
export const orgChannel = (tenantId: string): string => `${ORG_CHANNEL_PREFIX}${tenantId}`;

export type OrgEventPublisher = (tenantId: string, envelope: unknown) => Promise<void>;

export function createRedisOrgEventPublisher(connection: Redis): OrgEventPublisher {
  return async (tenantId, envelope) => {
    await connection.publish(orgChannel(tenantId), JSON.stringify(envelope));
  };
}
```

`apps/api/src/quota/quota.service.ts` — the orchestration. **Every public method takes the caller's
`EntityManager` as its first parameter, `null` when the caller has none**, because the reserve and
release calls in CP5 must join `campaigns.service.ts`'s existing transaction while the controller
in CP5 and the tests in this checkpoint have no transaction of their own. Fix this signature now
and keep it: a service that is transaction-aware in one call site and not in another is how a
reservation ends up committed while the freeze it belongs to rolls back.

```ts
type Actor = { actorId: string };

async reserveForCampaign(manager: EntityManager | null, tenantId: string, campaignId: string,
                         snapshotId: string | null, amount: number, actor: Actor): Promise<ReserveOutcome>;
async releaseForCampaign(manager: EntityManager | null, tenantId: string, campaignId: string, actor: Actor): Promise<number>;
async releasePartialForCampaign(manager: EntityManager | null, tenantId: string, campaignId: string,
                                keepConsumed: number, actor: Actor): Promise<number>;
async usageFor(tenantId: string): Promise<{ limit: number | null; period: 'day' | 'month'; periodKey: string; used: number; ratio: number | null }>;
```

When `manager` is `null`, the method opens its own
`runInTenantContext(this.dataSource, tenantId, ...)`; when it is provided, it uses it directly and
opens nothing. Behaviour:

- `reserveForCampaign(...)`: derive the period key
  from the locked config's `period`, call `repository.reserve(...)`, and **if not admitted, throw**
  `new TooManyRequestsException('Sending quota for this period is exhausted.', retryAfterSeconds)`
  carrying `{ code: 'QUOTA_EXCEEDED', quotaLimit, quotaUsed, quotaPeriodKey }`. `retryAfterSeconds`
  is the seconds remaining until the period rolls over — compute it from `periodKey`, do not
  hardcode it.
- On admission: compute `crossedThresholds(usedBefore, usedAfter, limit)`; for each, call
  `repository.claimThreshold(...)` and only if it returns `true`, `appendOutboxEvent(manager, ...)`
  with `eventType: 'quota.threshold_reached'`, `aggregateType: 'quota'`,
  `aggregateId: <a stable id — use the tenant id>`, `aggregateVersion: BigInt(threshold)`, and the
  event `data`; then `notifications.createForUsers(tenantId, { sourceEventId: \`quota.threshold_reached:${periodKey}:${threshold}\`, type: 'quota_threshold', severity: 'warning', category: 'quota', ... userIds })`.
  Resolve `userIds` the way the worker's `notification-writer.ts:40-49` does (users holding
  `notification:read`, honouring `notification_preference.enabled`), or reuse whatever helper
  `notifications.service.ts` already exposes for that — check before writing a second copy.
- Then publish the envelope to `eow:org:{tenantId}` and log the
  `quotaUsageRatioMetric(...)` payload with the same `console.log(JSON.stringify(metric))` /
  Nest `Logger` shape the existing two metric emitters use
  (`apps/worker/src/progress-reconcile.ts:173`, `apps/api/src/notifications/notifications.service.ts:105`).
- `releaseForCampaign(...)` and `releasePartialForCampaign(...)` delegate to the
  repository. **Neither emits a threshold event** — `crossedThresholds` returns `[]` on a downward
  move by design.
- `usageFor(tenantId)` returns `{ limit, period, periodKey, used, ratio }` for the controller. It is
  the one method with no `manager` parameter: it is read-only and always called from a controller.

All of these take an `EntityManager` where they are called inside an existing transaction, and
open their own `runInTenantContext(this.dataSource, tenantId, ...)` where they are not. Follow
`apps/api/src/campaigns/campaigns.service.ts`'s pattern for which is which.

`apps/api/src/quota/quota.module.ts` — a standard Nest module exporting `QuotaService`.
Register it in `apps/api/src/app.module.ts` by **appending** the import and the `imports: []`
entry; never reorder existing entries (protocol §3.6).

- [ ] **Step 5: Wire the notification trigger and fix its name**

In `apps/api/src/notifications/notification-rules.ts`, change line 37 from

```ts
  { sourceEvent: 'quota.threshold', type: 'quota_threshold', severity: 'warning', category: 'quota', wired: false, owner: 'M7' },
```

to

```ts
  // M7-S1 (DEC-146): renamed from 'quota.threshold' to match the event type
  // contracts/asyncapi.yaml:132 and catalog/realtime-events.json declare.
  // ARCH-ASYNCAPI-CONFORMANCE matches emitted event types against declared
  // channels, so the shorter name could never have been emitted.
  { sourceEvent: 'quota.threshold_reached', type: 'quota_threshold', severity: 'warning', category: 'quota', wired: true },
```

Update the BR-NOT-014 assertion in `apps/api/src/notifications/notification-rules.test.ts:32-34`
to expect `'quota.threshold_reached'`.

- [ ] **Step 6: Register the envelope source**

In `packages/architecture-tests/src/asyncapi-conformance.test.ts`, append
`'apps/api/src/quota/quota-event.ts'` to the `ENVELOPE_SOURCES` array (lines 28-34). Append only —
you are the only node touching this file (protocol §3.4).

- [ ] **Step 7: Run the tests**

```bash
pnpm --filter @eow/api test -- src/quota/ test/integration/quota-threshold-emission.test.ts
pnpm --filter @eow/api test -- src/notifications/notification-rules.test.ts
pnpm --filter @eow/architecture-tests test -- src/asyncapi-conformance.test.ts
```

Expected: all PASS. The conformance rule must confirm `quota.threshold_reached` now has both a
declared channel **and** an emitter.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/quota/ apps/api/src/app.module.ts apps/api/src/notifications/ \
        apps/api/test/integration/quota-threshold-emission.test.ts \
        packages/architecture-tests/src/asyncapi-conformance.test.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md
git commit -m "M7-S1 CP4: threshold event, notification and usage metric

DEC-146: the notification trigger's sourceEvent is renamed
'quota.threshold' -> 'quota.threshold_reached'. The contract wins:
ARCH-ASYNCAPI-CONFORMANCE matches emitted types against declared
channels (asyncapi.yaml:132), so the shorter name was unemittable.
NOTIFICATION_TRIGGERS' quota entry flips wired:false -> true.

Dedupe is quota_threshold_emission (tenant, period, threshold), which
is catalog/realtime-events.json's declared 'quota_period+threshold'
made physical -- not application logic. One confirmation crossing all
three thresholds emits three events and three notifications; a second
crossing of an already-fired threshold emits none.

eow_quota_usage_ratio follows progress-metrics.ts's log-payload
precedent, not prom-client -- no exporter exists until M7-S3.

<N>/<N> tests; ARCH-ASYNCAPI-CONFORMANCE green."
```

---

## Checkpoint 5 — Reserve at confirm, release at cancel

**Files:**
- Modify: `apps/api/src/campaigns/campaigns.service.ts`, `apps/api/src/campaigns/campaigns.module.ts`
- Create: `apps/api/test/integration/sending-quota-http.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/test/integration/sending-quota-http.test.ts`, booting the app the standard way. The
cases:

```ts
  it('BR-CFG-006: POST /campaigns/:id/send returns 429 with a problem+json body when the quota is exhausted', async () => {
    await dataSource.query(`UPDATE sending_policy SET send_quota_limit = 1 WHERE tenant_id = $1`, [tenant.id]);
    const response = await request(app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignWithTwoRecipients}/send`)
      .set('Cookie', cookie)
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', randomUUID());

    expect(response.status).toBe(429);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      status: 429,
      title: 'Too Many Requests',
      code: 'QUOTA_EXCEEDED',
    });
    expect(typeof response.body.traceId).toBe('string');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('BR-CFG-006: a refused send leaves no reservation and no queued campaign behind', async () => {
    const held = await dataSource.query(
      `SELECT id FROM quota_reservation WHERE tenant_id = $1 AND campaign_id = $2 AND state = 'held'`,
      [tenant.id, campaignWithTwoRecipients],
    );
    expect(held).toHaveLength(0);
    const campaign = await dataSource.query(`SELECT status FROM campaign WHERE id = $1`, [campaignWithTwoRecipients]);
    expect(campaign[0].status).not.toBe('queued');
  });

  it('BR-CFG-006: cancelling a queued campaign releases its reservation', async () => {
    await dataSource.query(`UPDATE sending_policy SET send_quota_limit = 100 WHERE tenant_id = $1`, [tenant.id]);
    await request(app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignWithTwoRecipients}/send`)
      .set('Cookie', cookie).set('x-csrf-token', csrfToken).set('Idempotency-Key', randomUUID())
      .expect(202);

    const beforeCancel = await dataSource.query(
      `SELECT COALESCE(SUM(amount),0)::int AS used FROM quota_reservation WHERE tenant_id = $1 AND state = 'held'`, [tenant.id]);
    expect(beforeCancel[0].used).toBeGreaterThan(0);

    await request(app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignWithTwoRecipients}/cancel`)
      .set('Cookie', cookie).set('x-csrf-token', csrfToken)
      .expect(200);

    const afterCancel = await dataSource.query(
      `SELECT COALESCE(SUM(amount),0)::int AS used FROM quota_reservation WHERE tenant_id = $1 AND state = 'held'`, [tenant.id]);
    expect(afterCancel[0].used).toBe(0);
    const released = await dataSource.query(
      `SELECT state, released_at FROM quota_reservation WHERE tenant_id = $1`, [tenant.id]);
    // Released, not deleted: the row is the audit trail of a hold that existed.
    expect(released[0].state).toBe('released');
    expect(released[0].released_at).not.toBeNull();
  });

  it('BR-CFG-006: a replayed send (same Idempotency-Key) does not double-reserve', async () => {
    const key = randomUUID();
    await request(app.getHttpServer()).post(`/api/v1/campaigns/${secondCampaign}/send`)
      .set('Cookie', cookie).set('x-csrf-token', csrfToken).set('Idempotency-Key', key).expect(202);
    await request(app.getHttpServer()).post(`/api/v1/campaigns/${secondCampaign}/send`)
      .set('Cookie', cookie).set('x-csrf-token', csrfToken).set('Idempotency-Key', key).expect(202);
    const holds = await dataSource.query(
      `SELECT id FROM quota_reservation WHERE tenant_id = $1 AND campaign_id = $2 AND state = 'held'`,
      [tenant.id, secondCampaign]);
    expect(holds).toHaveLength(1);
  });

  it('BR-GEN-002: a quota configuration is invisible across tenants', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/sending-quota')
      .set('Cookie', otherTenantCookie)
      .expect(200);
    // The other tenant sees its own (unconfigured) quota, never this one's.
    expect(response.body.limit).toBeNull();
  });
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @eow/api test -- test/integration/sending-quota-http.test.ts
```

Expected: FAIL — the send returns `202` rather than `429`, and `/sending-quota` returns `404`.

- [ ] **Step 3: Wire the reserve calls**

In `apps/api/src/campaigns/campaigns.service.ts`:

**`sendCampaign` (line 695).** Reserve **inside** the `this.idempotency.run(...)` callback at
`:725-728`, immediately after `freezeCampaignSnapshot` returns, so the reservation and the freeze
commit or roll back together and the idempotency mutex covers both:

```ts
      const result = await this.idempotency.run(manager, tenantId, idempotencyKey, 'campaign_snapshot', payload, async () => {
        const frozen = await freezeCampaignSnapshot(manager, tenantId, campaign, actor, webOrigin, audienceLimit, { targetStatus: 'queued' });
        // BR-CFG-006: the reservation is taken in the same transaction and
        // under the same pessimistic lock as the freeze, so a concurrent
        // confirmation cannot slip between "capacity checked" and "snapshot
        // frozen". Throwing here rolls the freeze back, which is why the
        // refused-send test can assert no queued campaign is left behind.
        await this.quota.reserveForCampaign(manager, tenantId, campaign.id, frozen.snapshotId, frozen.sendableCount, actor);
        return { id: frozen.snapshotId, ...frozen };
      });
```

**`scheduleCampaign` (line 852).** Same shape, inside its idempotency wrapper at `:908`, after the
freeze at `:920`. Additionally, add a `quota` entry to `buildScheduleValidationReport`
(declared `:786`) so the review-time check `BR-CFG-006`'s statement calls for is visible before
confirmation. The doc comment at `:783-785` currently reads *"`quota` is absent by design -- no
quota ledger exists until M7-S1 (DEC-088)"* — **update that comment**; leaving it would be a
false statement in source.

**`cancelCampaign` (line 744).** After the snapshot is superseded and before the audit log:
`await this.quota.releaseForCampaign(manager, tenantId, campaign.id, actor);`

**`cancelCampaignSchedule` (line 973).** Same call, after the status transition to `cancelled`.

**`cancelCampaignSend` (line 529).** Partial release, using the counts the method **already**
computes (`cancelledCount` at `:551-558`, `submittedRow.count` at `:559-564`):

```ts
      // BR-CFG-006: submitted units are spent and stay consumed; only the
      // cancelled remainder returns to the period's capacity. These two
      // counts already exist here for the audit row -- reuse them rather
      // than re-querying, so the release can never disagree with the audit.
      await this.quota.releasePartialForCampaign(manager, tenantId, campaign.id, Number(submittedRow.count), actor);
```

Import `QuotaModule` in `apps/api/src/campaigns/campaigns.module.ts` and inject `QuotaService`
into `CampaignsService`'s constructor.

- [ ] **Step 4: Write the controller**

`apps/api/src/quota/quota.controller.ts` — three routes, following
`apps/api/src/sender-config/sender-config.controller.ts`'s shape exactly (no controller path
prefix; the global `api/v1` prefix is applied in `main.ts`):

```ts
@Controller()
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  @Get('sending-quota')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  get(@Req() request: AuthenticatedRequest) { /* ... */ }

  @Put('sending-quota')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @AuditLog({ action: 'sending_quota.updated', entityType: 'sending_policy' })
  put(@Req() request: AuthenticatedRequest, @Body(new ZodValidationPipe(quotaSchema)) body: QuotaUpdate) { /* ... */ }

  @Get('sending-quota/usage')
  @RequirePermission(PERMISSIONS.CAMPAIGN_READ)
  usage(@Req() request: AuthenticatedRequest) { /* ... */ }
}
```

Use the existing `SETTINGS_MANAGE` and `CAMPAIGN_READ` keys — **do not add a permission key**
(protocol §3.6: `permissions.ts` is M7-S2's). `ARCH-RBAC`
(`packages/architecture-tests/src/rbac-coverage.test.ts`) fails any route missing both `@Public()`
and `@RequirePermission()`, so every one of the three needs a decorator.

`dto/quota.dto.ts`: `quotaSchema = z.object({ limit: z.number().int().positive().nullable(), period: z.enum(['day','month']) })`.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @eow/api test -- test/integration/sending-quota-http.test.ts test/integration/quota-reservation.test.ts
pnpm --filter @eow/architecture-tests test -- src/rbac-coverage.test.ts
```

Expected: all PASS.

Then run the campaign suites that touch the paths you edited — a reserve call inside
`sendCampaign` can break existing snapshot tests:

```bash
pnpm --filter @eow/api test -- test/integration/campaign-snapshot-freeze.test.ts \
  test/integration/campaign-schedule-http.test.ts test/integration/campaign-send-http.test.ts \
  test/integration/campaign-snapshot-immutability.test.ts
```

Expected: PASS with **no drop** in test count. If a pre-existing test now fails, the cause is
almost certainly that it confirms a campaign for a tenant with no `sending_policy` row —
`lockConfig` returns `{limit: null}` (unlimited) for that case by design, so investigate rather
than editing the old test.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/campaigns/ apps/api/src/quota/ apps/api/test/integration/sending-quota-http.test.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md
git commit -m "M7-S1 CP5: reserve at confirm, release at all three cancel paths

The reservation is taken inside sendCampaign/scheduleCampaign's existing
idempotency.run() callback, in the same transaction and under the same
pessimistic lock as freezeCampaignSnapshot -- so a 429 rolls the freeze
back and leaves no queued campaign, and a replayed Idempotency-Key
cannot double-reserve.

cancelCampaignSend releases only the cancelled remainder, reusing the
submittedCount it already computes for its audit row, so the release can
never disagree with the audit.

campaigns.service.ts:783-785's 'no quota ledger exists until M7-S1'
comment is now false and was updated, not left standing.

<N>/<N> tests; the four campaign suites unchanged in count."
```

---

## Checkpoint 6 — Org room in the realtime gateway

**Files:**
- Modify: `apps/api/src/realtime/realtime.gateway.ts`
- Modify: `apps/api/test/integration/realtime-campaign.test.ts` *(add cases; do not restructure —
  M6-S1 owns this file's existing content)* or create
  `apps/api/test/integration/realtime-org-room.test.ts` **(preferred — a new file avoids touching
  M6-S1's suite at all)**

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/realtime-org-room.test.ts`, modelled on
`apps/api/test/integration/realtime-campaign.test.ts`'s real-socket setup (a genuine `socket.io`
client with the session cookie in the handshake, not a mocked gateway):

```ts
  it('BR-CFG-006: an authenticated socket receives quota.threshold_reached for its own tenant', async () => {
    const received = new Promise((resolve) => socket.on('quota.threshold_reached', resolve));
    await publisher.publish(`eow:org:${tenant.id}`, JSON.stringify(envelope));
    const event = await received;
    expect(event).toMatchObject({ event_type: 'quota.threshold_reached', tenant_id: tenant.id });
  }, 30_000);

  it('BR-GEN-002: a socket never receives another tenant quota event', async () => {
    let leaked = false;
    socket.on('quota.threshold_reached', () => { leaked = true; });
    await publisher.publish(`eow:org:${otherTenant.id}`, JSON.stringify(otherEnvelope));
    await new Promise((r) => setTimeout(r, 500));
    expect(leaked).toBe(false);
  }, 30_000);
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @eow/api test -- test/integration/realtime-org-room.test.ts
```

Expected: FAIL — the event never arrives, because no `eow:org:` prefix is subscribed.

- [ ] **Step 3: Implement the org room**

Four edits in `apps/api/src/realtime/realtime.gateway.ts`, all additive:

```ts
const ORG_CHANNEL_PREFIX = 'eow:org:';
```

```ts
    await this.subscriber.psubscribe(
      `${JOB_CHANNEL_PREFIX}*`, `${CAMPAIGN_CHANNEL_PREFIX}*`, `${USER_CHANNEL_PREFIX}*`, `${ORG_CHANNEL_PREFIX}*`,
    );
```

In `roomForChannel`, before the final `return null`:

```ts
    if (channel.startsWith(ORG_CHANNEL_PREFIX)) {
      const id = channel.slice(ORG_CHANNEL_PREFIX.length);
      return id ? `org:${id}` : null;
    }
```

In `handleConnection`, beside the existing unconditional `client.join(\`user:${userId}\`)`:

```ts
    // BR-CFG-006 / catalog/realtime-events.json: quota.threshold_reached is
    // addressed to org:{organization_id} -- a tenant-wide room, not a
    // per-campaign or per-user one. No extra ownership check is needed or
    // possible: authenticate() already resolved this connection's tenantId
    // from its own session, so the room a socket joins is by construction the
    // only tenant it belongs to. This is the same reason user:{userId} above
    // needs no check.
    client.join(`org:${tenantId}`);
```

- [ ] **Step 4: Run to verify**

```bash
pnpm --filter @eow/api test -- test/integration/realtime-org-room.test.ts test/integration/realtime-campaign.test.ts
```

Expected: PASS, and `realtime-campaign.test.ts`'s count unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/realtime/realtime.gateway.ts apps/api/test/integration/realtime-org-room.test.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md
git commit -m "M7-S1 CP6: eow:org: channel prefix and org:{tenantId} room

catalog/realtime-events.json addresses quota.threshold_reached to
org:{organization_id}; the gateway had only eow:job:, eow:campaign: and
eow:user: prefixes, so the declared channel had nowhere to land. The
join needs no ownership check for the same reason user:{userId} does
not: authenticate() already resolved the connection's own tenant.

New test file rather than an edit to M6-S1's realtime-campaign.test.ts.
Cross-tenant leak negative included.

<N>/<N> tests; realtime-campaign.test.ts count unchanged."
```

---

## Checkpoint 7 — Worker-side enforcement at execution time

**Files:**
- Modify: `apps/worker/src/campaign-send/send.ts`
- Create: `apps/worker/src/campaign-send/quota-consume.integration.test.ts`

`BR-CFG-006` says quota is checked "khi review **và** thực thi". CP5 did review time; this does
execution time.

- [ ] **Step 1: Write the failing test**

`apps/worker/src/campaign-send/quota-consume.integration.test.ts`, following the fixture shape of
`apps/worker/src/campaign-send/send.integration.test.ts` (it uses `testOwnerDatabaseUrl()` for
setup and `testAppDatabaseUrl()` for runtime assertions — copy that split; testing as owner
bypasses RLS and would hide a missing `GRANT`, `EXECPLAN` D-51):

```ts
  it('BR-CFG-006: stops submitting once the period quota is exhausted and defers the rest', async () => {
    // 5 queued recipients, tenant quota 3 for the period, nothing consumed yet.
    const outcome = await sendClaimedBatch(appUrl, redisUrl, tenantId, campaignId, executionId, 10, fakeSend);

    expect(outcome.submitted).toBe(3);
    // Quota-blocked recipients are DEFERRED, not failed: they reuse the
    // existing over-budget path (rescheduleOverBudget), which is counted
    // into outcome.retrying and sets next_retry_at.
    expect(outcome.retrying).toBe(2);
    expect(outcome.failed).toBe(0);

    const deferred = await appPool.query(
      `SELECT status, next_retry_at, claimed_at FROM campaign_recipient
        WHERE execution_id = $1 AND status <> 'sent' ORDER BY id`, [executionId]);
    expect(deferred.rows).toHaveLength(2);
    for (const row of deferred.rows) {
      expect(row.next_retry_at).not.toBeNull();
      expect(row.claimed_at).toBeNull();
    }
  }, 30_000);

  it('BR-CFG-006: consumed count on the reservation matches the submitted count', async () => {
    const reservation = await appPool.query(
      `SELECT amount, consumed FROM quota_reservation WHERE tenant_id = $1 AND campaign_id = $2 AND state = 'held'`,
      [tenantId, campaignId]);
    expect(Number(reservation.rows[0].consumed)).toBe(3);
  }, 30_000);

  it('BR-CFG-006: a tenant with no configured quota is unaffected', async () => {
    // send_quota_limit NULL means unlimited -- the pre-M7-S1 behaviour, and
    // the only safe default for every tenant that existed before this node.
    const outcome = await sendClaimedBatch(appUrl, redisUrl, unlimitedTenantId, otherCampaignId, otherExecutionId, 10, fakeSend);
    expect(outcome.submitted).toBe(5);
    expect(outcome.retrying).toBe(0);
  }, 30_000);
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @eow/worker test -- src/campaign-send/quota-consume.integration.test.ts
```

Expected: FAIL — `outcome.submitted` is `5`, not `3`; there is no quota gate.

- [ ] **Step 3: Implement the gate**

In `apps/worker/src/campaign-send/send.ts`:

1. Extend `reserveBatch` (line 244), which already does one `SELECT ... FROM sending_policy` at
   `:266-270`, to also select `send_quota_limit, send_quota_period` in that same query — do not
   add a second round trip.
2. Compute `quotaRemaining` once per batch beside the existing `dailyRemaining` computation at
   `:119-124`, from the tenant's held reservations minus their `consumed` for the current period
   key. `NULL` limit ⇒ `Infinity`.
3. Add the gate in the per-recipient loop at `:140-160`, beside the two existing gates, using the
   same `overBudget.push(row); continue;` shape:

```ts
      // BR-CFG-006 execution-time half. Deliberately the same deferral path
      // as the daily cap and the rate limiter above: a quota-blocked
      // recipient has done nothing wrong and must not become 'failed'.
      // rescheduleOverBudget() puts it back with next_retry_at set, and it
      // is counted into outcome.retrying.
      if (quotaRemaining <= 0) { overBudget.push(row); continue; }
```

4. Decrement `quotaRemaining` and increment the reservation's `consumed` where the existing code
   calls `recordSubmitted(...)` at `:178-179`. The `consumed` write goes in the same statement
   sequence as `recordSubmitted`, not in a separate transaction — if the process dies between
   them, an under-counted `consumed` is recoverable (it re-derives from `message_attempt`) whereas
   an over-counted one silently steals capacity.

**Do not** add metric emission here. `eow_send_attempt_total` and friends are M7-S3's and are
emitted from `run.ts` (protocol §3.6).

- [ ] **Step 4: Run to verify**

```bash
pnpm --filter @eow/worker test -- src/campaign-send/quota-consume.integration.test.ts
pnpm --filter @eow/worker test -- src/campaign-send/send.integration.test.ts src/campaign-send/run.integration.test.ts
```

Expected: all PASS, existing counts unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/campaign-send/ .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md
git commit -m "M7-S1 CP7: execution-time quota gate in the send loop

BR-CFG-006 says quota is checked 'khi review VA thuc thi'. The gate
joins the two that already exist in the per-recipient loop (daily cap,
rate limiter) and uses their deferral path: a quota-blocked recipient
goes back via rescheduleOverBudget with next_retry_at set and counts as
retrying, never failed. The limit is read in reserveBatch's existing
sending_policy SELECT, not a second round trip.

consumed is incremented alongside recordSubmitted, not in a separate
transaction: an under-count re-derives from message_attempt, an
over-count would silently steal capacity.

send_quota_limit NULL means unlimited, so every tenant that existed
before this node is unaffected -- proven by its own test.

<N>/<N> new tests; send/run integration counts unchanged."
```

---

## Checkpoint 8 — OpenAPI contract (single late commit)

**Files:**
- Modify: `contracts/openapi.yaml`

Protocol §3.3: edit this file **once**, as late as possible, and commit immediately.

- [ ] **Step 1: Save a pre-edit copy outside the repo**

```bash
cp contracts/openapi.yaml ../openapi-before-m7-s1.yaml
```

- [ ] **Step 2: Append the paths**

Append to the `paths:` map — `/sending-quota` and `/sending-quota/usage` only (your reserved
prefix). Follow the single-line flow style the file already uses. Place them adjacent to
`/sending-policy` (line 38) so the diff lands in a region no other node is editing.

Operations: `getSendingQuota` (200), `putSendingQuota` (200, 400, 403), `getSendingQuotaUsage`
(200, 403). Add the request/response schemas under `components/schemas` with the names
`SendingQuota`, `SendingQuotaUpdateRequest`, `SendingQuotaUsage`.

**Also document the new 429 on the two existing send/schedule operations.** `sendCampaign` and
`scheduleCampaign` can now return `429`, and a contract that omits it is wrong:

```yaml
        '429': {$ref: '#/components/responses/Problem'}
```

Adding a response code to an existing operation is additive and permitted; check
`components/responses/Problem` exists under that exact name before referencing it.

- [ ] **Step 3: Prove it is additive-only and regenerate the client**

```bash
node scripts/openapi-compat-check.mjs ../openapi-before-m7-s1.yaml contracts/openapi.yaml
pnpm contracts:generate
pnpm --filter @eow/api typecheck
```

Expected: the compat check exits 0; typecheck exits 0. `packages/contracts/src/openapi.d.ts` is
generated and gitignored — never stage it.

- [ ] **Step 4: Commit immediately**

```bash
git add contracts/openapi.yaml .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md
git commit -m "M7-S1 CP8: /sending-quota contract, additive only

Reserved prefix per PARALLEL-EXECUTION-PROTOCOL-M7 §3.3. Committed
immediately and alone, not batched, because openapi.yaml is the sharpest
contention point between the four concurrent M7 nodes.

sendCampaign and scheduleCampaign gain a documented 429: they can now
return it, and a contract that omits a reachable status is wrong.

openapi-compat-check against the pre-edit copy: additive only."
```

---

## Checkpoint 9 — Full verification and node handoff

- [ ] **Step 1: Environment variable, if you added one**

If `QuotaService` needs a deployment-configurable default period, append
`SENDING_QUOTA_DEFAULT_PERIOD` to `apps/api/src/config/env.ts` (inside the `z.object`, above its
closing `});`, with the rule-id doc comment the file's other entries use), **and** to
`compose.yaml`'s `api` `environment:` block, `.env.deploy.example`, and
`docs/deployment/environment-variables.md` — all four together, in one commit (AGENTS.md §2's
one-command-deployment clause). Then:

```bash
docker compose --env-file .env config --quiet
```

Expected: exit 0. If you did **not** need a new variable, skip this step and say so in the inbox —
`send_quota_period` is per-tenant data, so a deployment-wide default may genuinely be unnecessary.

- [ ] **Step 2: Full workspace check, twice**

Only in a quiet window — protocol §2.3, no other node running its suite.

```bash
pnpm --filter @eow/api build
pnpm check
pnpm check
```

Expected: exit 0 both times. Compare **test and skip counts** against your CP0 baseline. A count
that went *down* is a suite that stopped running, not a suite that got faster (AGENTS.md §2: a
failed `beforeAll` reports as skipped tests under a green-looking summary). Skips must be 0 — the
custom reporter enforces it.

- [ ] **Step 3: Architecture rules**

```bash
pnpm --filter @eow/architecture-tests test
```

Expected: PASS. Specifically confirm `ARCH-MIGRATION`, `ARCH-RBAC`, `ARCH-TENANT`,
`ARCH-ASYNCAPI-CONFORMANCE`, `ARCH-LAYERING`, `ARCH-MODULE`, `ARCH-ENCODING` and
`ARCH-TEST-HYGIENE` are green. If `ARCH-MODULE` or `ARCH-LAYERING` complains about
`apps/api/src/quota/`, read `docs/architecture/module-template.md` — its layering and
test-placement rules are mechanically enforced and the fix is in your module, not in the rule.

`ARCH-ENCODING` will fail on any file you wrote through a non-UTF-8 codepage. Every file in this
plan must be written as UTF-8 explicitly (AGENTS.md §2).

- [ ] **Step 4: Write the final inbox section**

`## Checkpoint 9 — verification and handoff`, status **`ready-for-review`** (never `completed` —
protocol §4: only a reviewing Claude session sets a node's status in `state.json`).

The traceability row to propose:

| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-CFG-006 | M7-S1-quota | getSendingQuota;putSendingQuota;getSendingQuotaUsage | quota_threshold_reached | 034_sending_quota.sql | apps/api/src/quota/quota.service.ts;apps/api/src/quota/quota.repository.ts;apps/api/src/quota/quota-threshold.ts;apps/api/src/quota/quota-period.ts;apps/api/src/quota/quota-event.ts;apps/api/src/quota/quota-org-publisher.ts;apps/api/src/quota/quota-metrics.ts;apps/api/src/campaigns/campaigns.service.ts;apps/api/src/realtime/realtime.gateway.ts;apps/worker/src/campaign-send/send.ts | TC-CFG-006 | apps/api/test/integration/quota-reservation.test.ts;apps/api/test/integration/quota-threshold-emission.test.ts;apps/api/test/integration/sending-quota-http.test.ts;apps/api/test/integration/realtime-org-room.test.ts;apps/worker/src/campaign-send/quota-consume.integration.test.ts;apps/api/src/quota/quota-threshold.test.ts;apps/api/src/quota/quota-period.test.ts;apps/api/src/quota/quota-metrics.test.ts | metric eow_quota_usage_ratio + quota.threshold_reached outbox event + quota_threshold notification + audit sending_quota.updated | **test_passing** |

**Propose `test_passing`, not `closed`.** A rule becomes `closed` only after independent
re-verification on the review machine (protocol §6). Say so explicitly in the inbox.

Record in the same section:

- The exact `pnpm check` counts from both runs, and the CP0 baseline they are compared against.
- `DEC-146` (the `quota.threshold` → `quota.threshold_reached` rename, with the
  `ARCH-ASYNCAPI-CONFORMANCE` reason and the rejected alternative of renaming the contract instead).
- `DEC-147` (ledger over derived count, with the two-transactions-both-count reason and the
  rejected alternative).
- Any `D-*` discovery from D-141…D-145. Expect at least one: the `sending_policy` limit columns
  that exist in the database but are unmapped in the API layer (`026_campaign_execution.sql:100-115`
  vs `sending-policy.entity.ts`) is a real, pre-existing gap worth recording as a discovery even
  though it is out of this rule's scope.
- The finding from protocol §8.5 — that `state.json`'s M7-S1 success condition names thresholds
  `BR-CFG-006`'s own acceptance text does not, and that the authority is
  `catalog/realtime-events.json`. A reviewing session may want a `DEC-*` for it.

- [ ] **Step 5: Commit and push**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S1-quota.md
git commit -m "M7-S1 CP9: verification complete, ready for review

pnpm check twice: apps/api <F>/<T>, apps/worker <F>/<T>, apps/web <F>/<T>,
packages/architecture-tests <F>/<T>, 0 skipped both runs. CP0 baseline
was <...>; every count rose or held, none fell.

BR-CFG-006 proposed as test_passing, NOT closed -- closure requires
independent re-verification on the review machine against a PostgreSQL
that already has 001-033 applied and real M1-M6 data
(PARALLEL-EXECUTION-PROTOCOL-M7 §6, §7.4)."
git push -u origin m7-s1-quota
```

**Do not merge into `main`. Do not rebase onto `main`. Do not delete the worktree.**

---

## DEFERRED UI / VISUAL HANDOFF — not for Codex

Protocol §1.1: this node touches no front-end file and takes no screenshot. The following
front-end work is what `BR-CFG-006` implies, recorded here so the reviewing session can schedule
it into `M7-S5-perf-a11y-visual` rather than rediscover it.

1. **`UI-CFG-002` (Settings — default sending policy, route `/settings/policy`)** already lists
   `business_rules: [BR-CFG-006, ...]` and `realtime_events: [quota.threshold_reached]` in
   `screen-catalog.yaml`, and its `status` is already `migrated` with all five required states
   captured at three viewports from `M5-S1`. Adding a quota limit/period control and a usage
   indicator to this screen would invalidate those captures. **Not done here.** The API surface
   (`GET/PUT /sending-quota`, `GET /sending-quota/usage`) exists and is contract-documented, so the
   front-end work is unblocked whenever it is scheduled.

2. **`quota.threshold_reached` has no client subscriber.** The event now reaches the
   `org:{tenantId}` room, and `apps/web`'s shared socket would need to listen for it and surface
   the notification. The durable notification is already created and will appear in the
   notification centre through the existing `M6-S2` path with **no** front-end change — so nothing
   is silently lost in the meantime. Only the live toast/badge path is deferred.

3. **`screen-catalog.yaml` was not edited.** No `states_covered` value was written, no
   `production_render_path` was set, no capture was taken. `UI-CFG-002`'s existing entry is
   untouched and still accurate for the screen as it currently ships.

4. **The `429` needs a client-side presentation decision.** `QUOTA_EXCEEDED` reaches the compose
   screen as a Problem body with `Retry-After`. Whether that is a blocking overlay, an inline
   error on the confirm button, or a notification is a UI-handoff-fidelity question
   (`design-reference/ui-source-contract.yaml`), not a backend one, and is left to `M7-S5`.
