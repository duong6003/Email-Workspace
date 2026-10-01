# M6-S1 Realtime Progress Implementation Plan

> **For agentic workers:** execute this plan checkpoint-by-checkpoint under
> AGENTS.md §2 (evidence precedes status, commit at every checkpoint, compare
> test *and skip* counts against the CP0 baseline). Use
> `superpowers:test-driven-development` (RED before GREEN at every checkpoint)
> and `superpowers:systematic-debugging` on any red. This plan is the spec; do
> not re-derive it from `state.json`. Steps use checkbox (`- [ ]`) syntax.

Node: `M6-S1-realtime-progress` · Depends on: `M5-GATE` (completed 2026-08-18, commit `6deba0c`, pushed to `origin/main`)
Owns rules: **BR-SEND-003, BR-SEND-004, BR-SEND-005, BR-HIS-002, BR-HIS-008** (5 — re-confirmed directly against `traceability.csv`, all five `not_started`)
Test cases: **TC-SEND-003, TC-SEND-004, TC-SEND-005, TC-SEND-015** (percent half), **TC-SEND-016, TC-HIS-002, TC-HIS-008, TC-HIS-009, TC-HIS-010**; **TC-SEC-016** is explicitly out of reach on this host (§5 R5)
Screens: the approved `historyDetail` drawer (`design-reference/ui-handoff-v2/source/app/action-overlays.tsx:220`) on a new route `/history/:campaignId`; one change to `ComposeDraftScreen`'s `SendingBanner`
Reserved: migration **028**, **ADR-026**, decisions **DEC-121…DEC-131**, defects **D-115…D-120**
Solo execution.

**Goal:** Make campaign send progress visible in near-real time over Socket.IO — monotonic counters computed from `campaign_recipient` facts, throttled to at most 1/s or 250 recipients, tenant-authorised per room, with a real ETA, a visible reconnecting state, REST reconciliation on reconnect, and a periodic reconciliation job that repairs drift and reports it as `eow_progress_reconcile_drift`.

**Architecture:** `campaign_recipient` stays canonical. Migration 028 adds a *denormalised* counter summary plus a `progress_seq` cursor to `campaign_execution` — the thing that is published and the thing that can drift. Three writers (the worker send loop, the worker's end-of-pass aggregate, the API webhook apply) bump `progress_seq` and publish `campaign.progress` to Redis `eow:campaign:{id}`; every API replica's gateway relays it into room `campaign:{id}`. A scheduled `progress-reconcile` job — already enqueued every tick, currently a stub — recomputes from facts, repairs both drift layers, and reports the delta.

**Tech Stack:** NestJS + Socket.IO gateway, ioredis pub/sub, BullMQ worker + scheduler, PostgreSQL with RLS, React + TanStack Query, Vitest, Playwright.

---

## 0. Read this before touching anything

Every finding below was verified directly against the working tree at `7d2eec0`.
Six are constraints that decide the design; three are defects or stale records
this node is the first able to see. None may be re-litigated mid-checkpoint.

**(a) DRIFT-01 / D-03 is *not* already fixed — the subscriber was deleted, not corrected.**
`git log -S "campaign.progress.updated" --all` returns exactly two commits
(`6afedde`, `7d2eec0`), and `git grep -l` at each of them hits only
`.agents/runs/…` planning documents. `git log --all --follow -- apps/web/src/App.tsx`
is **empty**: the file that carried the wrong event name never entered version
control, because `STANDARDIZATION-PLAN.md` §F2 identified it as dead (zero
importers) and deleted it before the baseline commit. So the *string* is gone
and the *subscription* went with it. `apps/web` listens for no campaign event at
all today — `apps/web/src/api/realtime.ts` is nine lines and exports only
`subscribeToJobs`. The gate's condition ("apps/web listens for
`campaign.progress`") is therefore genuinely unmet and is this node's work, not a
box already ticked. **Record as DEC-121** so no later agent re-opens it.

**(b) `progress-reconcile` is a fabricated-success stub that is already on the schedule.**
`apps/worker/src/main.ts` contains:

```ts
case 'progress-reconcile': return {reconcileAccepted:true, note:'Implement canonical delivery-fact reconciliation in the vertical slice'};
```

and `apps/scheduler/src/main.ts` enqueues `progress-reconcile` on **every tick**,
alongside `campaign-misfire-scan`, `campaign-send-scan` and `outbox-publish`. The
job therefore reports success once per `SCHEDULER_TICK_MS` today while doing
nothing — the same class of defect as D-87. Consequence for this plan: the job
needs **no new registration, no scheduler change and no new queue**; only a body.
**Record as D-115.**

**(c) There is no stored progress summary today, but ADR-016 and the ExecPlan both say there must be.**
`campaign_execution` (`026_campaign_execution.sql:48-64`) has no count columns,
and `campaigns.service.ts:436` recomputes every number from `campaign_recipient`
on each read. ADR-016 (**Accepted**) says *"Persist counters in PostgreSQL;
workers emit throttled aggregate updates no faster than 1/s or 250 recipients"*,
and `EXECPLAN.md:643` reserves this node a migration described as
*"denormalised monotonic campaign counters + reconciliation columns"*. TC-HIS-010
only makes sense against a stored summary — it says *"Cố ý làm summary
delivered_count lệch message states. Summary=80, actual=82"*. The denormalised
counters in §3.1 are that pre-registered design, not scope this node invented.

**(d) `campaign.progress`'s declared dedupe key does not work with `campaign.version`.**
`catalog/realtime-events.json` declares `campaign.progress` on channel
`campaign:{campaign_id}` with `"dedupe": "campaign_id+version"` and
`"cadence": "Throttle <=1/s"`. But `campaign.version` is bumped only by status
transitions (`aggregate.ts` and `campaign-dispatcher.ts`, both `version = version + 1`
inside a status `UPDATE`). During `sending` the version is constant, so every
progress event in a run would carry the same dedupe key and a conforming client
would discard all but the first. A separate monotonic sequence is required; §3.1
adds `progress_seq` and §3.3 uses it as the envelope's `version`.
**Record as D-116, resolved by DEC-122.**

**(e) The per-status counts are not individually monotonic — only the rollups are, and that is already settled.**
D-105 (M5-S4 CP5) established the shape: `counts` is the exact partition that sums
to `total_snapshot`, while `sent`/`delivered`/`failed` are *rollups*
(`sent = submitted + delivered + bounced`, `failed = failed + bounced`) and only
those are monotonic — a `delivered` webhook legitimately decrements
`counts.submitted`. The stored summary in §3.1 therefore stores the **raw
per-status counts**, and monotonicity is a property of the read-side rollup
formula that already exists and is already tested. Do **not** add a `GREATEST()`
guard to the stored counters: it would break the "counts sum to total_snapshot"
invariant that BR-SEND-002 closed on.

**(f) The gateway's authorisation chain is a template, not a mechanism to invent.**
`realtime.gateway.ts:49-72` already does cookie → `parseSessionToken` →
`sessions.validate` → user `active` → `setTenantContext` → permission check →
tenant-ownership `SELECT` → `client.join`, and disconnects hard on any failure.
`campaign:{id}` reuses this chain verbatim with `CAMPAIGN_READ` (the permission
`GET /campaigns/:id/progress` already requires, `campaigns.controller.ts:66`) and
a `campaign` ownership query. Do not write a second authorisation path.

**(g) The API and the worker cannot share one progress implementation, and the codebase already has the sanctioned answer.**
`apps/api` holds a TypeORM `EntityManager`; `apps/worker` holds a `pg.PoolClient`;
neither can import the other (`rootDir: "src"`, no shared workspace package).
DEC-107 already faced this exact problem for `suppressRecipient()` and resolved it
with a deliberate transliteration plus a mechanical guard,
`packages/architecture-tests/src/suppression-parity.test.ts`
(ARCH-SUPPRESSION-PARITY). §3.2 follows that precedent exactly rather than
inventing an adapter layer. **DEC-123.**

**(h) A scheduled job that writes delivery state is an ADR-level change.**
AGENTS.md §2: *"If a requirement changes tenant isolation, authentication,
campaign snapshot semantics, **delivery state**, notification durability or public
contracts, create/propose an ADR before implementation."* The reconciliation job
repairs `campaign_recipient.status` from the `delivery_event` ledger, which is
exactly a delivery-state write from a new actor. **ADR-026 is written in CP1,
before any reconciliation code.** ADR-010 and ADR-016 are not amended — ADR-026 is
additive and consistent with both.

**(i) `DEC-097`'s parenthetical is stale.** It reads *"BR-SEND-009 (pause/resume)
is M6-S1's"*, but `traceability.csv` places BR-SEND-009's test cases
(`TC-SEND-009;TC-SEND-019`) in M6 with no slice, and `state.json` lists
BR-SEND-009 under `M6-S3-history-recovery`'s success conditions, not this node's.
Traceability is the authority. **BR-SEND-009 is out of scope here**; pause/resume
is not implemented, not stubbed and not claimed. **Record as D-117** (a stale
cross-reference, not a code defect) and correct DEC-097's note in EXECPLAN §20 at
CP12.

---

## 1. What this slice turns from definition into fact

### The rules, in their own words

**BR-SEND-003** — *"Progress gửi = số recipient ở terminal send state / số
actionable recipient; delivered được hiển thị riêng khỏi sent/submitted."*
Acceptance: *"0..100%, không giảm; completed chỉ khi mọi actionable terminal."*

**BR-SEND-004** — *"History detail cập nhật progress gần thời gian thực qua
SSE/WebSocket, có polling fallback."* Acceptance: *"Độ trễ UI p95 dưới 5 giây;
mất kết nối tự reconnect từ last_event_id."*

**BR-SEND-005** — *"ETA tính từ rolling throughput của các message gần nhất; chưa
đủ dữ liệu hiển thị đang ước tính."* Acceptance: *"ETA không âm; biến mất khi
complete; không dùng failed/skipped để thổi phồng throughput."*

**BR-HIS-002** — *"Chi tiết hiển thị tổng, chờ, đang xử lý, submitted/sent,
delivered, failed, bounced, skipped, ETA."* Acceptance: *"Counts cùng nguồn
backend và cập nhật realtime; tooltip giải thích sent khác delivered."*

**BR-HIS-008** — *"Progress summary được reconcile định kỳ từ message state để
sửa sai lệch counter/event."* Acceptance: *"Reconciliation idempotent; chênh lệch
được metric/audit và UI tự cập nhật."*

Read together, the five say one thing this node must make true: **a number on
screen that moves while a campaign sends, never lies, never goes backwards, and
is repaired without a human when it does drift.**

### Hard non-goals

Named so they are not drifted into. Each belongs to a node that owns it.

1. **Pause / resume (BR-SEND-009).** M6-S3's, per §0(i). No pause edge is added to
   the state machine; DEC-097 already admits `paused` to the vocabulary without an
   edge and that stays true.
2. **The History *list* screen (BR-HIS-001/003/004/005/006/007).** M6-S3's. This
   node builds the *detail* drawer and the `/history/:campaignId` route only. The
   `/history` list route is not created.
3. **Resend over failed recipients (BR-HIS-005).** M6-S3's.
4. **The notification center and its popover (BR-NOT-*).** M6-S2's. This node
   creates the `user:{userId}` room that M6-S2 will also need, and emits exactly
   one event onto it (`rt.resync_required`) — nothing more.
5. **Horizontal-scale load proof (TC-SEC-016, 10 000 connections).** Not
   achievable on this host; §5 R5 records it honestly rather than faking it.
6. **A Prometheus/OpenTelemetry exporter.** ADR-017 names Pino + OTel as the
   destination, but the only shipped precedent is a structured log payload
   (`notification-metrics.ts`, BR-NOT-016). `eow_progress_reconcile_drift` follows
   that precedent. Building an exporter is not this node's work.
7. **Replacing the 3-second REST poll.** It *is* BR-SEND-004's "polling fallback"
   half and it stays. §3.9 changes only its cadence while a socket is live.

---

## 2. Acceptance criteria

| # | Criterion | Rule | Test case | Proof layer |
|---|-----------|------|-----------|-------------|
| A1 | Migration 028 adds `progress_seq bigint NOT NULL DEFAULT 0`, nine `*_count integer NOT NULL DEFAULT 0` columns and `reconciled_at timestamptz` to `campaign_execution`; a negative count is refused with `23514`; re-running the migration is a no-op (idempotent apply proven by a second `docker compose run --rm migrate`) | BR-HIS-008 | TC-HIS-008 | migration + integration |
| A2 | `reconcilable_campaign_executions(limit)` is `SECURITY DEFINER`, executable by `eow_app`, revoked from `PUBLIC`, and returns executions that are `sending` **or** finished within the retention window — proven by seeding one of each and one older than the window | BR-HIS-008 | TC-HIS-008 | integration |
| A3 | `computeProgressCounts()` returns per-status counts that sum to `total_snapshot`, and rollups where `sent = submitted + delivered + bounced` and `failed = failed + bounced`; driving a recipient through `submitted → delivered → bounced` never decreases `sent`, `delivered` or `failed` | BR-SEND-003, BR-SEND-002 | TC-SEND-015 | unit + integration |
| A4 | `progressPercent()` returns an integer `0..100`, is `0` when `actionable = 0`, is `100` only when every actionable recipient is terminal, and never decreases across a monotonic count sequence — proven by a property-style table including the empty-audience and all-skipped cases | BR-SEND-003 | TC-SEND-003, TC-SEND-015 | unit |
| A5 | `estimateEta()` returns `{state:'estimating'}` below the minimum sample size, a non-negative `secondsRemaining` above it, and `null` once the campaign is terminal; feeding a window containing **only** `transient_error`/`permanent_error` attempts yields `estimating`, never a throughput above zero | BR-SEND-005 | TC-SEND-005 | unit |
| A6 | `shouldPublishProgress()` returns `false` before 1 000 ms and fewer than 250 recipients, `true` at exactly 1 000 ms, and `true` at exactly 250 recipients within the same millisecond — proven with an injected clock, no timers, no sleeps | BR-SEND-004, ADR-016 | TC-SEND-004 | unit |
| A7 | A send pass over 600 recipients with `batch_size=600` publishes **at least** `ceil(600/250) = 3` events and **at most** one per 250 recipients plus one flush, and the final published event's counts equal the post-pass database counts — no batch ever ends silently | BR-SEND-004, ADR-016 | TC-SEND-004 | integration (real PostgreSQL + Redis) |
| A8 | Every published envelope validates against `contracts/asyncapi.yaml`'s `EventEnvelope`: `event_id` uuid, `event_type = 'campaign.progress'`, `occurred_at` ISO-8601, `tenant_id` uuid, `aggregate_id` = campaign id, `version` = `progress_seq`, and `data` carrying the nine counts, percent and eta | BR-SEND-004, BR-HIS-002 | TC-SEND-004 | unit + integration |
| A9 | `progress_seq` strictly increases across every publish from all three writers; two publishes never share a value, proven by a concurrent worker-publish and webhook-publish (`Promise.all`) against one execution | BR-SEND-004 | TC-SEND-016 | integration (concurrent) |
| A10 | A socket handshake requesting `campaign:{id}` for a campaign in **another** tenant is disconnected and joins no room; the same id in the caller's own tenant joins and receives the next published event — asserted by a real `socket.io-client` against a real gateway, not by unit-testing the parser alone | BR-SEND-004, domain invariant | TC-SEND-004 | integration (real socket) |
| A11 | A handshake with no session cookie, an expired session, an `inactive` user, or a user lacking `CAMPAIGN_READ` is disconnected in every case and joins no room | BR-SEND-004, BR-AUTH-004 | TC-SEND-004 | integration |
| A12 | `requestedCampaignIds()` dedupes, rejects non-strings, rejects an over-limit list, and accepts both the singular `campaignId` and the plural `campaignIds` handshake shapes | BR-SEND-004 | TC-SEND-004 | unit |
| A13 | A webhook `delivered` apply publishes exactly one `campaign.progress` whose `delivered` count is one higher than the pre-request value, and does so **after** the transaction commits — a rolled-back apply publishes nothing | BR-HIS-002, BR-SEND-008 | TC-HIS-002 | integration |
| A14 | With `campaign_recipient.status` deliberately set behind an applied `delivery_event` (the TC-HIS-010 fixture: summary 80, ledger 82), one `progress-reconcile` run repairs the two rows, writes one `progress.reconciled` audit row whose metadata carries the per-status delta, emits `eow_progress_reconcile_drift` with a non-zero value, and publishes a fresh `campaign.progress` | BR-HIS-008 | TC-HIS-010 | integration |
| A15 | A **second** `progress-reconcile` run over the same data changes nothing, writes no second audit row, and emits `eow_progress_reconcile_drift` with value `0` — idempotence proven by re-running, not by inspection | BR-HIS-008 | TC-HIS-008, TC-HIS-010 | integration |
| A16 | Reconciliation never regresses delivery state: a `campaign_recipient` already at `delivered` with a *later* `delivery_state_at` than the ledger row is left untouched, and the ledger's older event is not re-applied | BR-HIS-008, BR-SEND-008 | TC-HIS-010 | integration |
| A17 | When reconciliation repairs anything, `rt.resync_required` is emitted to `user:{userId}` for every user in the owning tenant with `CAMPAIGN_READ`, and the client's handler refetches REST rather than trusting the socket payload (ADR-010) | BR-HIS-008, BR-SEND-004 | TC-HIS-010, TC-SEND-016 | integration + unit |
| A18 | `applyProgressEvent()` (client, pure) accepts an event with `version` greater than the last seen, **discards** one with an equal or lower version, and discards one whose `aggregate_id` is a different campaign — so a duplicate or out-of-order delivery can never move a counter backwards on screen | BR-SEND-004, BR-SEND-003 | TC-SEND-015, TC-SEND-016 | unit |
| A19 | Killing the socket mid-send shows a **"Đang kết nối lại"** state within the reconnect window, the 3-second REST poll keeps the numbers moving while it is down, and on reconnect a REST refetch reconciles the display with no lost or double-counted update — asserted by driving a real socket disconnect, not by mocking the state flag | BR-SEND-004 | TC-SEND-016 | integration (real socket) + unit |
| A20 | The `/history/:campaignId` drawer renders all nine BR-HIS-002 fields (tổng, chờ, đang xử lý, sent, delivered, failed, bounced, skipped, ETA) sourced from one backend response, with a tooltip explaining sent ≠ delivered; captured at 3 viewports and **individually inspected** | BR-HIS-002 | TC-HIS-002, TC-HIS-009 | e2e + visual |
| A21 | `eow_progress_reconcile_drift` is `0` for every execution on a final full reconciliation run at CP12, and no log line, audit metadata or event payload contains a recipient email address or a rendered message body | BR-HIS-008, BR-SEC-003 | TC-HIS-008, TC-SEND-013 (partial) | integration |

---

## 3. Locked design

### 3.1 Migration 028 — `028_progress_counters.sql`

Pre-reserved by `EXECPLAN.md:643` as *"denormalised monotonic campaign counters +
reconciliation columns"*. Three parts.

**(1) The stored summary on `campaign_execution`.** Raw per-status counts, not
rollups — §0(e). The nine names match `CampaignProgressCounts`' keys exactly so
the transliteration guard in §3.2 can compare them mechanically.

```sql
ALTER TABLE campaign_execution
  ADD COLUMN IF NOT EXISTS progress_seq      bigint      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_count     integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS queued_count      integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS submitted_count   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivered_count   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bounced_count     integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count      integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count     integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancelled_count   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reconciled_at     timestamptz;

ALTER TABLE campaign_execution
  ADD CONSTRAINT campaign_execution_counts_non_negative CHECK (
    progress_seq >= 0 AND pending_count >= 0 AND queued_count >= 0
    AND submitted_count >= 0 AND delivered_count >= 0 AND bounced_count >= 0
    AND failed_count >= 0 AND skipped_count >= 0 AND cancelled_count >= 0
  );
```

`progress_seq` is the only strictly monotonic column, and it is monotonic by
construction: every writer uses `progress_seq = progress_seq + 1` inside the same
`UPDATE` that writes the counts, never a client-supplied value.

**(2) The cross-tenant reconciliation scan.** Same `SECURITY DEFINER` shape as
`013`/`025`/`026`/`027` — a fixed query returning only the ids the caller needs,
so `eow_app` stays `NOBYPASSRLS` and no broad cross-tenant read is granted.

```sql
CREATE OR REPLACE FUNCTION reconcilable_campaign_executions(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, campaign_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT campaign_execution.id, campaign_execution.tenant_id, campaign_execution.campaign_id
  FROM campaign_execution
  WHERE campaign_execution.status = 'sending'
     OR campaign_execution.finished_at > now() - interval '7 days'
  ORDER BY campaign_execution.started_at
  LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION reconcilable_campaign_executions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconcilable_campaign_executions(integer) TO eow_app;
```

The seven-day window is what makes the scan bounded rather than growing with
history forever, while still catching the case BR-HIS-008 exists for: a provider
callback that lands *after* a campaign has completed. Anything older is beyond
any provider's retry horizon and is left to the audit trail.

**(3) `migrations.lock.json`.** Add the `028_progress_counters.sql` entry in the
same commit. `ARCH-MIGRATION` in `packages/architecture-tests` enforces
published-migration immutability and will fail if the lock and the file disagree.

### 3.2 The progress computation, and why it exists twice

One function computes everything readable about a campaign's progress from
`campaign_recipient` and `message_attempt`. It has two callers that cannot share
code (§0(g)), so it is written twice as a deliberate transliteration guarded by
`ARCH-PROGRESS-PARITY`, exactly following DEC-107's precedent (**DEC-123**).

**Pure core — shared by neither, duplicated in both, tested once each.** The
arithmetic itself has no database dependency and lives in a pure module per app:

- `apps/api/src/campaigns/progress-math.ts`
- `apps/worker/src/campaign-send/progress-math.ts`

```ts
export type ProgressCounts = {
  pending: number; queued: number; submitted: number; delivered: number;
  bounced: number; failed: number; skipped: number; cancelled: number;
};

export type ProgressRollups = { queued: number; sent: number; delivered: number; failed: number };

/**
 * D-105's rollup shape, unchanged: `sent` and `failed` deliberately overlap on
 * `bounced` -- a bounced message *was* sent and *did* fail. Only these rollups
 * are monotonic; `counts` is the exact partition that sums to total_snapshot.
 */
export function rollupCounts(counts: ProgressCounts): ProgressRollups {
  return {
    queued: counts.pending + counts.queued,
    sent: counts.submitted + counts.delivered + counts.bounced,
    delivered: counts.delivered,
    failed: counts.failed + counts.bounced,
  };
}

/**
 * BR-SEND-003. Terminal send state = anything that left pending/queued.
 * Actionable = eligibility 'sendable', which is what `skipped` is excluded from
 * upstream at freeze time, so it is not subtracted again here.
 */
export function progressPercent(counts: ProgressCounts, actionable: number): number {
  if (actionable <= 0) return 0;
  const terminal = counts.submitted + counts.delivered + counts.bounced + counts.failed;
  return Math.max(0, Math.min(100, Math.round((terminal / actionable) * 100)));
}
```

**ETA (BR-SEND-005).** Rolling throughput over recent *submitted* attempts only.
`failed` and `skipped` are excluded from the numerator by the query, which is the
literal reading of *"không dùng failed/skipped để thổi phồng throughput"* — a
failure is not a delivery of work.

```ts
export const ETA_MIN_SAMPLES = 5;
export const ETA_WINDOW_MS = 120_000;

export type EtaEstimate = { state: 'estimating' } | { state: 'estimated'; secondsRemaining: number };

/**
 * BR-SEND-005. `sampleCount` is the number of message_attempt rows with
 * outcome='submitted' inside the window; `windowMs` is the observed span
 * between the oldest and newest of those samples, not the nominal window --
 * a burst of 100 sends in 2 seconds must not be averaged over 120.
 */
export function estimateEta(sampleCount: number, windowMs: number, remaining: number): EtaEstimate | null {
  if (remaining <= 0) return null;
  if (sampleCount < ETA_MIN_SAMPLES || windowMs <= 0) return { state: 'estimating' };
  const perSecond = sampleCount / (windowMs / 1000);
  if (perSecond <= 0) return { state: 'estimating' };
  return { state: 'estimated', secondsRemaining: Math.max(0, Math.ceil(remaining / perSecond)) };
}
```

`estimateEta` returns `null` — not `0`, not `estimating` — when nothing remains.
That is *"biến hết khi complete"*, and the drawer renders nothing at all for a
`null`.

**The database half.** `apps/api/src/campaigns/progress-snapshot.ts` (EntityManager)
and `apps/worker/src/campaign-send/progress-snapshot.ts` (pg.PoolClient) each
export `readProgressFacts()` and `writeProgressSnapshot()` with the same
post-conditions:

```sql
-- readProgressFacts, part 1: the canonical per-status counts
SELECT status, count(*)::int AS count
FROM campaign_recipient
WHERE tenant_id = $1 AND snapshot_id = $2
GROUP BY status;

-- readProgressFacts, part 2: the actionable denominator
SELECT count(*)::int AS actionable
FROM campaign_recipient
WHERE tenant_id = $1 AND snapshot_id = $2 AND eligibility = 'sendable';

-- readProgressFacts, part 3: the ETA sample window (submitted attempts only)
SELECT count(*)::int AS sample_count,
       EXTRACT(EPOCH FROM (max(attempted_at) - min(attempted_at))) * 1000 AS window_ms
FROM message_attempt
WHERE tenant_id = $1 AND execution_id = $2 AND outcome = 'submitted'
  AND attempted_at > now() - ($3::double precision * interval '1 millisecond');

-- writeProgressSnapshot: one statement, seq bumped in the same UPDATE
UPDATE campaign_execution
SET progress_seq = progress_seq + 1,
    pending_count = $3, queued_count = $4, submitted_count = $5, delivered_count = $6,
    bounced_count = $7, failed_count = $8, skipped_count = $9, cancelled_count = $10
WHERE id = $1 AND tenant_id = $2
RETURNING progress_seq;
```

**`ARCH-PROGRESS-PARITY`** (`packages/architecture-tests/src/progress-parity.test.ts`)
mirrors `suppression-parity.test.ts`: both files must exist, each must name the
other in a comment, and both must carry every required token
(`progress_seq = progress_seq + 1`, `eligibility = 'sendable'`,
`outcome = 'submitted'`, each of the nine count column names). Editing one
without the other fails `pnpm check` in the same edit that caused the drift.

### 3.3 The event envelope and the throttle gate

**Envelope.** One builder per app, same shape, checked by `ARCH-PROGRESS-PARITY`.
Both apps declare these two types locally (transliteration, §0(g)); the publisher
signature deliberately matches `JobEventPublisher`'s so the two realtime paths
read the same way:

```ts
export type ProgressEvent = {
  event_id: string;
  event_type: 'campaign.progress';
  occurred_at: string;
  tenant_id: string;
  aggregate_id: string;
  version: number;
  data: {
    campaign_id: string; execution_id: string; status: string;
    total: number; actionable: number; percent: number;
    counts: ProgressCounts;
    queued: number; sent: number; delivered: number; failed: number;
    eta: EtaEstimate | null;
  };
};

export type CampaignEventPublisher = (event: ProgressEvent | ResyncEvent) => Promise<void>;

export type ResyncEvent = {
  event_id: string;
  event_type: 'rt.resync_required';
  occurred_at: string;
  tenant_id: string;
  aggregate_id: string;
  version: number;
  data: { campaign_id: string };
};
```

```ts
export function buildProgressEvent(input: {
  tenantId: string; campaignId: string; executionId: string;
  progressSeq: number; counts: ProgressCounts; actionable: number;
  totalSnapshot: number; status: string; eta: EtaEstimate | null;
}): ProgressEvent {
  const rollups = rollupCounts(input.counts);
  return {
    event_id: randomUUID(),
    event_type: 'campaign.progress',
    occurred_at: new Date().toISOString(),
    tenant_id: input.tenantId,
    aggregate_id: input.campaignId,
    version: input.progressSeq,            // D-116/DEC-122: NOT campaign.version
    data: {
      campaign_id: input.campaignId,
      execution_id: input.executionId,
      status: input.status,
      total: input.totalSnapshot,
      actionable: input.actionable,
      percent: progressPercent(input.counts, input.actionable),
      counts: input.counts,
      ...rollups,
      eta: input.eta,
    },
  };
}
```

No recipient address, no subject, no rendered body ever enters `data` — A21.

**Throttle gate** — `apps/worker/src/campaign-send/progress-throttle.ts`, pure,
clock injected, no timers:

```ts
export const PROGRESS_THROTTLE_MS = 1_000;
export const PROGRESS_THROTTLE_RECIPIENTS = 250;

export type ThrottleState = { lastPublishedAtMs: number; recipientsSinceLastPublish: number };

export function createThrottleState(nowMs: number): ThrottleState {
  return { lastPublishedAtMs: nowMs, recipientsSinceLastPublish: 0 };
}

export function countRecipient(state: ThrottleState): ThrottleState {
  return { ...state, recipientsSinceLastPublish: state.recipientsSinceLastPublish + 1 };
}

/** ADR-016: "no faster than 1/s or 250 recipients". Either bound may fire. */
export function shouldPublishProgress(state: ThrottleState, nowMs: number): boolean {
  return nowMs - state.lastPublishedAtMs >= PROGRESS_THROTTLE_MS
    || state.recipientsSinceLastPublish >= PROGRESS_THROTTLE_RECIPIENTS;
}

export function markPublished(state: ThrottleState, nowMs: number): ThrottleState {
  return { lastPublishedAtMs: nowMs, recipientsSinceLastPublish: 0 };
}
```

Read ADR-016's wording carefully: it is a **floor on spacing**, not a ceiling on
count. `>= 1000ms` allows at most one publish per second; `>= 250 recipients`
forces a publish before a large batch goes quiet for too long. Both are `>=` so
the boundary cases in A6 are unambiguous.

**Redis publisher** — `apps/worker/src/redis-campaign-event-publisher.ts`, the
exact shape of the existing `redis-job-event-publisher.ts`:

```ts
export function campaignChannel(campaignId: string): string {
  return `eow:campaign:${campaignId}`;
}

export function createRedisCampaignEventPublisher(connection: Redis): CampaignEventPublisher {
  return async (event) => {
    const campaignId = typeof event.aggregate_id === 'string' ? event.aggregate_id : null;
    if (!campaignId) throw new Error('Campaign realtime event requires aggregate_id.');
    await connection.publish(campaignChannel(campaignId), JSON.stringify(event));
  };
}
```

### 3.4 Worker wiring — where the throttle actually sits

`sendClaimedBatch` gains one optional parameter, defaulted so every existing
caller and test compiles unchanged:

```ts
export async function sendClaimedBatch(
  databaseUrl: string, redisUrl: string, tenantId: string, campaignId: string,
  executionId: string, batchSize: number,
  sendFn: SmtpSendFn = defaultSendFn,
  publishProgress: CampaignEventPublisher | null = null,
  now: () => number = Date.now,
): Promise<SendBatchOutcome>
```

Inside the existing `for (const row of reserved.rows)` loop, **after** the
`recordSubmitted`/`recordFailure` transaction commits for that row:

```ts
throttle = countRecipient(throttle);
if (publishProgress && shouldPublishProgress(throttle, now())) {
  await publishProgressSnapshot(pool, tenantId, campaignId, executionId, publishProgress);
  throttle = markPublished(throttle, now());
}
```

Publishing **after commit** is not optional. A published event that a rollback
then erases is exactly the "socket payload is the only copy of business state"
failure AGENTS.md §2 forbids, and it would make the counters on screen
unfalsifiable.

`runOneCampaign` in `run.ts` performs the **mandatory flush** after
`aggregateExecution` returns, regardless of what the throttle did:

```ts
const aggregated = await aggregateExecution(databaseUrl, tenantId, campaignId, executionId);
await publishProgressSnapshot(pool, tenantId, campaignId, executionId, publishProgress);
```

Without it, the final batch of a campaign — the one that takes the display from
99 % to 100 % — can fall inside a throttle window and never be published, leaving
the UI permanently short of complete. This is the single most likely way to ship a
plausible-looking but wrong implementation of this node.

`publishProgressSnapshot` is the one helper both call sites share
(`apps/worker/src/campaign-send/progress-snapshot.ts`). It is the only place that
sequences read → write → build → publish, so no caller can bump `progress_seq`
without publishing, or publish a payload that disagrees with what was stored:

```ts
export async function publishProgressSnapshot(
  pool: pg.Pool, tenantId: string, campaignId: string, executionId: string,
  publish: CampaignEventPublisher | null,
): Promise<void> {
  if (!publish) return;
  const event = await runInTenantTransaction(pool, tenantId, async (client) => {
    const facts = await readProgressFacts(client, tenantId, executionId);
    const progressSeq = await writeProgressSnapshot(client, tenantId, executionId, facts.counts);
    return buildProgressEvent({ tenantId, campaignId, executionId, progressSeq, ...facts });
  });
  try { await publish(event); } catch { /* see below */ }
}
```

A publish failure must **never** fail a send. That is why the `try/catch` sits
around the `publish` call and not around the transaction:

```ts
try { await publish(event); } catch { /* realtime is a hint (ADR-010); PostgreSQL already has the fact */ }
```

**DEC-124** records this: an unreachable Redis degrades the UI to its 3-second
polling fallback and loses nothing, whereas letting it throw would fail a batch
whose emails have already left the building.

### 3.5 API wiring — the webhook publish path

`apps/api/src/webhooks/webhooks.service.ts:172` is where a `delivered`/`bounced`
apply updates `campaign_recipient`. Immediately **after** that transaction commits
(not inside it — same reasoning as §3.4), the service writes the snapshot and
publishes.

The API publishes to the **same Redis channel** as the worker rather than calling
`RealtimeGateway.publish()` directly. With more than one API replica, a direct
call reaches only the sockets attached to the replica that happened to receive the
webhook; every other viewer would silently miss the update. ADR-009 already names
the Redis adapter as the fan-out mechanism. **DEC-125.**

`apps/api/src/realtime/redis-campaign-publisher.ts` holds the API-side ioredis
publisher connection (a publish-only client, separate from the gateway's
subscriber — ioredis connections in subscriber mode cannot issue `PUBLISH`).

### 3.6 The gateway — two new rooms

**`realtime-campaign-rooms.ts`**, sibling to `realtime-job-rooms.ts`:

```ts
const MAX_CAMPAIGN_SUBSCRIPTIONS = 10;

export function requestedCampaignIds(auth: unknown): string[] {
  if (!auth || typeof auth !== 'object') return [];
  const value = auth as { campaignId?: unknown; campaignIds?: unknown };
  const candidates = Array.isArray(value.campaignIds)
    ? value.campaignIds
    : typeof value.campaignId === 'string' ? [value.campaignId] : [];
  if (candidates.length > MAX_CAMPAIGN_SUBSCRIPTIONS) return [];
  return [...new Set(candidates.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}
```

The limit is 10, not the job parser's 50: a viewer watches one campaign's progress
drawer, occasionally a small list. A tighter bound is a smaller surface for a
client that asks for a thousand ids. **DEC-126.**

**`handleConnection`** gains a campaign branch that mirrors the job branch line for
line, plus an unconditional user-room join once a session is validated:

```ts
const campaignIds = requestedCampaignIds(client.handshake.auth);
if (campaignIds.length > 0) {
  const session = await this.authorizeConnection(client);   // extracted below
  if (!session) { client.disconnect(true); return; }
  const { user, permissions, manager } = session;
  if (!permissions.includes(PERMISSIONS.CAMPAIGN_READ)) return false;
  const owned = await manager.query(
    `SELECT id::text FROM campaign WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
    [campaignIds, user.tenantId],
  );
  return owned.length === campaignIds.length;
  // on success: for (const id of campaignIds) client.join(`campaign:${id}`);
  //             client.join(`user:${user.id}`);
}
```

The session/user preamble is identical for both branches and is extracted into one
private `authorizeConnection(client)` returning `{ user, permissions, manager }` or
`null`, so the two branches share the auth chain rather than copying it. This
refactor is part of CP7 and the existing job-room integration behaviour must be
re-proven unchanged afterwards (§5 R2).

**`onModuleInit`** adds a second pattern subscription. The existing `pmessage`
handler already routes by `event.event_type` and only needs the channel-prefix
switch:

```ts
await this.subscriber.psubscribe(`${JOB_CHANNEL_PREFIX}*`, `${CAMPAIGN_CHANNEL_PREFIX}*`);
// in the handler:
const room = channel.startsWith(CAMPAIGN_CHANNEL_PREFIX)
  ? `campaign:${channel.slice(CAMPAIGN_CHANNEL_PREFIX.length)}`
  : `job:${channel.slice(JOB_CHANNEL_PREFIX.length)}`;
```

### 3.7 The reconciliation job

Replaces `main.ts`'s stub body (§0(b)). New file
`apps/worker/src/progress-reconcile.ts`, following `scanDueCampaigns`'
cross-tenant shape exactly: an unlocked scan over the narrow
`OUTBOX_DATABASE_URL` boundary decides *which* executions to visit, then a tenant
transaction per execution does the work.

Per execution, in one tenant transaction:

**Layer 1 — the ledger.** For every `campaign_recipient` under the execution whose
status disagrees with the newest `applied` `delivery_event`, re-run the *same*
decision the webhook path uses:

```sql
SELECT cr.id, cr.status, cr.delivery_state_at, cr.recipient_id,
       de.event_type, de.occurred_at
FROM campaign_recipient cr
JOIN LATERAL (
  SELECT event_type, occurred_at FROM delivery_event
  WHERE tenant_id = cr.tenant_id AND campaign_recipient_id = cr.id AND outcome = 'applied'
  ORDER BY occurred_at DESC LIMIT 1
) de ON true
WHERE cr.tenant_id = $1 AND cr.execution_id = $2
  AND cr.status <> (CASE de.event_type WHEN 'delivered' THEN 'delivered' WHEN 'bounced' THEN 'bounced' ELSE cr.status END)
FOR UPDATE
```

Each candidate goes through `decideWebhookOutcome(eventType, currentStatus, occurredAt, deliveryStateAt)`.
The worker cannot import the API's copy (§0(g)), so it gets a transliteration at
`apps/worker/src/campaign-send/delivery-decision.ts` whose token list joins
`ARCH-PROGRESS-PARITY` — the same DEC-107 arrangement `suppression.ts` already uses.
That transliterated function is —
the function M5-S4 already wrote and tested — and is repaired only when that
returns `apply`. This is what makes A16 true: the ordering guard and the legal-
transition table are the *same* ones the live path uses, not a second copy with
its own bugs. **DEC-127.**

**Layer 2 — the summary.** Recompute from `campaign_recipient` via
`readProgressFacts()` and compare against the stored counters.

**Drift, audit, metric, publish.**

```ts
export type ReconcileDrift = { [K in keyof ProgressCounts]: number } & { repairedRecipients: number };

/** Positive, negative and zero deltas all reported; the metric value is the L1 norm. */
export function driftMagnitude(drift: ReconcileDrift): number {
  return Object.entries(drift)
    .filter(([key]) => key !== 'repairedRecipients')
    .reduce((total, [, delta]) => total + Math.abs(delta), 0);
}
```

- `driftMagnitude === 0` and no repaired recipients → update `reconciled_at` only.
  **No audit row, no publish, no `progress_seq` bump.** A silent no-op is what
  makes A15's second run provably idempotent.
- Otherwise → repair, `writeProgressSnapshot()` (which bumps `progress_seq`), one
  `audit_log` row with `action = 'progress.reconciled'` and the per-status deltas
  in `metadata`, one metric line, one `campaign.progress` publish, and
  `rt.resync_required` to each `user:{userId}` in the tenant holding
  `CAMPAIGN_READ`.

**The metric**, following `notification-metrics.ts` exactly — identifiers and
numbers, never PII:

```ts
// apps/worker/src/progress-metrics.ts
export type ProgressReconcileMetric = {
  tenantId: string; campaignId: string; executionId: string;
  drift: number; repairedRecipients: number;
};

/** Emits identifiers and magnitudes only; recipient addresses and subjects are intentionally excluded. */
export function progressReconcileDriftMetric(metric: ProgressReconcileMetric): Record<string, string | number> {
  return {
    metric: 'eow_progress_reconcile_drift',
    tenant_id: metric.tenantId,
    campaign_id: metric.campaignId,
    execution_id: metric.executionId,
    value: metric.drift,
    repaired_recipients: metric.repairedRecipients,
  };
}
```

### 3.8 `rt.resync_required`

`catalog/realtime-events.json` puts it on channel `user:{user_id}` with purpose
*"Cursor is outside replay window; client refetches affected resources"*. This
system has **no replay buffer at all**, so the honest reading is: the server emits
it when it knows the client's view must be wrong. Reconciliation repairing drift
is precisely that moment. **DEC-128.**

Payload carries the affected campaign id and nothing else; the client's only
correct response is a REST refetch (ADR-010: realtime is a hint). It never carries
counts — a resync event that carried state would be the very thing it exists to
correct.

### 3.9 The web client

**`apps/web/src/api/realtime.ts`** gains a campaign subscription beside the
existing job one. Both set `socket.auth` before connecting, so a client watching
both merges rather than overwrites:

```ts
export function subscribeToCampaigns(campaignIds: string[]): void {
  socket.auth = { ...(socket.auth as Record<string, unknown>), campaignIds };
  if (!socket.connected) socket.connect();
}
```

**`apps/web/src/screens/history/campaign-realtime.ts`** — pure, socket-free,
directly testable, following `import-realtime.ts`'s precedent:

```ts
export type CampaignProgressEvent = { aggregate_id?: unknown; event_type?: unknown; version?: unknown; data?: unknown };

export function isCampaignProgressEvent(event: CampaignProgressEvent, campaignId: string): boolean {
  return event.aggregate_id === campaignId && event.event_type === 'campaign.progress';
}

/**
 * ADR-010 + BR-SEND-003: a duplicate or out-of-order delivery must never move a
 * counter backwards. `version` is the execution's progress_seq (D-116/DEC-122).
 */
export function applyProgressEvent<T extends { version: number }>(
  current: T | null, event: CampaignProgressEvent, campaignId: string,
): T | null {
  if (!isCampaignProgressEvent(event, campaignId)) return current;
  if (typeof event.version !== 'number') return current;
  if (current && event.version <= current.version) return current;
  return { ...(event.data as object), version: event.version } as T;
}
```

**Connection state.** A `useRealtimeStatus()` hook maps socket lifecycle events to
`'live' | 'reconnecting' | 'offline'` from `socket.on('connect' | 'disconnect' |
'connect_error')`. `'reconnecting'` renders the visible **"Đang kết nối lại"**
state that `design-reference/ui-source-contract.yaml:27`
(`reconnecting_when_realtime_applies`) requires and that this node's gate
condition names.

**Polling stays.** `SendingBanner`'s existing 3-second interval is BR-SEND-004's
"polling fallback" half and is not removed. Its cadence becomes conditional:

```ts
const intervalMs = realtimeStatus === 'live' ? 15_000 : 3_000;
```

15 s while the socket is live is a cheap safety net against a missed event that
still satisfies the p95-under-5-seconds requirement through the socket; 3 s when
it is not is the unchanged behaviour that already works today. On every transition
back to `'live'`, an immediate REST refetch runs — that refetch **is** the
reconnect reconciliation TC-SEND-016 asks for, and it is why the client needs no
replay buffer. **DEC-129.**

### 3.10 The drawer and its route

`apps/web/src/screens/history/CampaignProgressDrawer.tsx`, built from
`design-reference/ui-handoff-v2/source/app/action-overlays.tsx:220` — the live
state block, the progress track, `history-stats`, `history-meta` (which carries
the throughput reading the approved design already shows as *"Tốc độ hiện tại 18
email/phút"*) and the timeline.

The approved drawer shows **four** stat tiles; BR-HIS-002 requires **nine**
fields. This is not an irreducible conflict — AGENTS.md §2.1's STOP-gate case —
because the approved layout already contains a second region (`history-meta`) for
exactly this kind of detail. The four headline tiles keep the approved
presentation (Tổng / Đã gửi / Đang chờ / Lỗi); `delivered`, `bounced`, `skipped`
and *đang xử lý* go into `history-meta` rows, and the tooltip BR-HIS-002 requires
(*"tooltip giải thích sent khác delivered"*) hangs off the "Đã gửi" tile. **DEC-130.**

Route: `/history/:campaignId`, which is the route `EXECPLAN.md:429` names for this
node's exit criterion. `SendingBanner` gains a link to it. The `/history` **list**
route is not created — M6-S3 owns it and will point its rows at this same route.

**Screen-level traceability, and the overlap that must not be papered over.**
`screen-catalog.yaml:583` registers this drawer as **`UI-HIS-002` "Campaign detail
(live progress)"** at exactly this route and this source file, so that is the
screen id this node closes. But `screen-catalog.yaml:571` maps **`UI-HIS-001`
"Send history"** (`/history`, the list) to `BR-SEND-003`, `BR-SEND-004`,
`BR-SEND-005` and `BR-HIS-008` as well — the approved list renders a per-row
`send-progress` bar, so three of this node's five rules have a *second* UI surface
that this node deliberately does not build (non-goal 2).

The consequence is a rule that is backend-complete and UI-complete on UI-HIS-002
while still having an unbuilt UI-HIS-001 surface. Handle it explicitly rather than
silently: close the four rules on their **UI-HIS-002** evidence and state in each
traceability row that the UI-HIS-001 surface is M6-S3's, so `M6-GATE`'s own
condition ("UI-HIS-001, UI-HIS-002 … verified at 3 viewports") is met by the two
nodes together and neither is credited with the other's screen. **DEC-131.**
Recording this now is what stops M6-GATE from discovering a half-built screen
behind a `closed` rule — the exact drift class that has already occurred once in
this run.

---

## 4. Contracts

**`contracts/asyncapi.yaml`** — no new channels; `campaign_progress` and
`rt_resync_required` are already declared. Two comment corrections, because the
file currently states things that this node makes false:

- `campaign_execution_state_changed`'s inline comment says *"No code subscribes to
  or publishes this channel yet."* Still true after this node — the reconciliation
  and progress paths do not touch it — so it stays. Do not delete it as
  "obviously stale"; verify before editing.
- Add a comment to `campaign_progress` recording that `version` carries
  `campaign_execution.progress_seq`, not `campaign.version` (D-116/DEC-122), since
  the dedupe key in `catalog/realtime-events.json` is otherwise ambiguous.

**`catalog/realtime-events.json`** — `campaign.progress`'s `dedupe` value stays
`campaign_id+version`; it is now correct because `version` means `progress_seq`.
No catalog edit is needed, and none should be made: the catalog is a requirements
artifact, not a code mirror.

**`contracts/openapi.yaml`** — `CampaignProgress` gains `eta`
(`{state:'estimating'} | {state:'estimated', secondsRemaining:int} | null`),
`percent` (`integer 0..100`), `actionable` and `progressSeq`. `eta`'s existing
declared type is `null`-only and must be widened; `apps/web` compiles against the
generated types only (ADR-005), so run `pnpm contracts:generate` and
`pnpm contracts:compat-check` in the same checkpoint.

**Environment.** No new variables. `SCHEDULER_TICK_MS`, `REDIS_URL`,
`OUTBOX_DATABASE_URL` and `CAMPAIGN_SEND_BATCH_SIZE` all already exist and are
already documented. The one-command deployment contract is therefore unchanged —
state that explicitly in CP12's commit body rather than leaving its absence to be
read as an omission.

---

## 5. Risks

**R1 — The 60-second scheduler tick makes "realtime" untestable by wall clock.**
A campaign only advances when `campaign-send-scan` runs. Integration tests must
call `scanQueuedCampaigns` / `sendClaimedBatch` **directly** rather than waiting
for the scheduler, exactly as `run.integration.test.ts` already does. Never write a
test that sleeps waiting for a tick.

**R2 — Refactoring the gateway's auth preamble can silently break job rooms.**
`realtime-job-rooms` behaviour is the only realtime code with existing coverage.
After the §3.6 extraction, re-run the import/bulk realtime tests **unmodified** and
confirm the count is unchanged. If a job-room test needs editing to pass, the
refactor is wrong.

**R3 — Real-socket tests are a new test shape for this repo.** Nothing here has
ever started a Socket.IO server in a test. Budget for it: use Nest's
`Test.createTestingModule` with a real HTTP listener on an ephemeral port, connect
a real `socket.io-client`, and always await an explicit event rather than a
timeout. A test that passes by sleeping will flake on this shared host.

**R4 — Pre-existing flake class.** `campaign-execution-db.test.ts` and
`run.integration.test.ts` flake under unrelated Docker load on this host (D-93/D-94,
re-confirmed in the M5-GATE session). Isolate with a standalone re-run before
calling anything a regression.

**R5 — TC-SEC-016 (10 000 SSE connections, 1 000 events/s) cannot run here.** It
requires staging infrastructure the plan explicitly does not have. It is recorded
against BR-SEND-004 as **`partially_closed`** with the reason stated in the
traceability row — not marked passing, not silently dropped. TC-SEND-004 and
TC-SEND-016 close the rule's functional half.

**R6 — The live database carries ~1 446 pre-existing tenant rows** from prior
sessions, and `audit_log` is immutable (BR-SEC-002), so probe tenants with audit
rows cannot be fully deleted. Expected and harmless. Do not attempt a table-wide
cleanup. Extend `test-cleanup-helpers.ts` for the new columns in CP2, not when the
first FK violation appears.

**R7 — Publishing inside a transaction would be a correctness bug, not a style
choice.** §3.4 and §3.5 both publish after commit. A reviewer who "simplifies"
this by moving the publish inside the transaction reintroduces exactly the failure
AGENTS.md §2 forbids.

---

## 6. Checkpoints

Commit at every checkpoint (AGENTS.md §2). The subject names the node; the body
records the workspace check's **test count and skip count**.

### CP0 — baseline

- [ ] **Step 1: Bring infrastructure up**

```bash
pnpm install && pnpm run infra:up
```

- [ ] **Step 2: Record the baseline**

```bash
pnpm run check
```

Expected: green. Record test **files / tests / skipped / failed**. The M5-GATE
handoff closed at **124 files / 789 tests / 0 skipped / 0 failed** — confirm, do
not assume. Every later checkpoint compares against this. Do not proceed on a red
or uncounted baseline.

- [ ] **Step 3: Re-verify the two findings this plan depends on**

```bash
git log --all --follow -- apps/web/src/App.tsx
```

Expected: empty output (§0(a)).

```bash
grep -n "progress-reconcile" apps/worker/src/main.ts apps/scheduler/src/main.ts
```

Expected: the stub in the worker, the enqueue in the scheduler (§0(b)).

### CP1 — ADR-026, before any reconciliation code

Required by AGENTS.md §2 (§0(h)). No code in this checkpoint.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/adr-026-scheduled-progress-reconciliation.md` following the
five-section shape every existing ADR uses (title, Status, Decision, Rationale,
Alternatives). Status: **Accepted**. The decision: *a scheduled worker job may
repair `campaign_recipient` delivery state from the append-only `delivery_event`
ledger, monotonically only, reusing the webhook path's own ordering and legal-
transition guards; drift is reported as audit plus metric before repair.*
Alternatives to record as rejected: detect-and-report only (leaves drift
permanently, so the gate's "drift is 0" condition could never be met by repair);
repair only inside the active send window (leaves post-completion callback drift
permanent — the exact case BR-HIS-008 exists for).

- [ ] **Step 2: Commit**

```bash
git add docs/adr/adr-026-scheduled-progress-reconciliation.md
git commit -m "M6-S1 CP1: ADR-026 scheduled progress reconciliation"
```

### CP2 — migration 028, RED first

- [ ] **Step 1: Write the failing migration tests**

In `apps/worker/src/campaign-execution-db.test.ts` (or a new
`progress-counters-db.test.ts` beside it, following that file's connection
pattern), assert: the ten new `campaign_execution` columns exist with the stated
types and defaults; a negative count is refused with SQLSTATE `23514`;
`reconcilable_campaign_executions` is executable by `eow_app`, revoked from
`PUBLIC`, returns a `sending` execution, returns one finished 1 day ago, and does
**not** return one finished 8 days ago.

- [ ] **Step 2: Run to verify RED**

```bash
pnpm --filter @eow/worker test -- progress-counters-db
```

Expected: FAIL — `column "progress_seq" does not exist`.

- [ ] **Step 3: Write the migration**

Create `database/migrations/028_progress_counters.sql` with §3.1's three parts
verbatim. Write it UTF-8 (AGENTS.md §2; `ARCH-ENCODING` enforces this).

- [ ] **Step 4: Apply and lock**

```bash
docker compose run --rm migrate
```

Add the `028_progress_counters.sql` hash entry to `database/migrations.lock.json`.

- [ ] **Step 5: Prove idempotent re-apply**

```bash
docker compose run --rm migrate
```

Expected: a second run applies nothing and exits 0 (A1).

- [ ] **Step 6: Extend the cleanup helpers**

Update `apps/worker/src/test-cleanup-helpers.ts` for the new columns now, per R6.

- [ ] **Step 7: Run tests and architecture guards**

```bash
pnpm --filter @eow/worker test -- progress-counters-db && pnpm --filter @eow/architecture-tests test
```

Expected: PASS, `ARCH-MIGRATION` green.

- [ ] **Step 8: Commit**

```bash
git add database/migrations/028_progress_counters.sql database/migrations.lock.json apps/worker/src
git commit -m "M6-S1 CP2: migration 028 progress counters and reconciliation scan (A1, A2)"
```

### CP3 — progress math and ETA, RED first (pure, no I/O)

- [ ] **Step 1: Write the failing unit tests**

Create `apps/api/src/campaigns/progress-math.test.ts` covering: `rollupCounts`'
overlap on `bounced`; `progressPercent` returning 0 for `actionable = 0`, 100 only
when every actionable is terminal, and clamping to `0..100`; a monotonic sequence
of counts producing a non-decreasing percent; `estimateEta` returning
`{state:'estimating'}` below `ETA_MIN_SAMPLES`, `null` when `remaining <= 0`, a
non-negative `secondsRemaining` above the threshold, and `estimating` for a window
containing no submitted samples (A3, A4, A5).

- [ ] **Step 2: Run to verify RED**

```bash
pnpm --filter @eow/api test -- progress-math
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `progress-math.ts` in both apps**

Create `apps/api/src/campaigns/progress-math.ts` and
`apps/worker/src/campaign-send/progress-math.ts` with §3.2's code, each naming the
other in its header comment (the parity guard checks for this).

- [ ] **Step 4: Copy the test to the worker**

Create `apps/worker/src/campaign-send/progress-math.test.ts` with the same cases.
Both apps' arithmetic is proven independently — that is the point of a
transliteration.

- [ ] **Step 5: Run to verify GREEN**

```bash
pnpm --filter @eow/api test -- progress-math && pnpm --filter @eow/worker test -- progress-math
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/campaigns/progress-math.ts apps/api/src/campaigns/progress-math.test.ts apps/worker/src/campaign-send/progress-math.ts apps/worker/src/campaign-send/progress-math.test.ts
git commit -m "M6-S1 CP3: progress percent, rollups and ETA arithmetic (A3, A4, A5)"
```

### CP4 — throttle gate and envelope builder, RED first

- [ ] **Step 1: Write the failing throttle tests**

Create `apps/worker/src/campaign-send/progress-throttle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { countRecipient, createThrottleState, markPublished, shouldPublishProgress } from './progress-throttle.js';

describe('shouldPublishProgress', () => {
  it('holds below both bounds', () => {
    const state = createThrottleState(1_000);
    expect(shouldPublishProgress(state, 1_999)).toBe(false);
  });

  it('fires at exactly one second', () => {
    const state = createThrottleState(1_000);
    expect(shouldPublishProgress(state, 2_000)).toBe(true);
  });

  it('fires at exactly 250 recipients inside the same millisecond', () => {
    let state = createThrottleState(1_000);
    for (let i = 0; i < 250; i += 1) state = countRecipient(state);
    expect(shouldPublishProgress(state, 1_000)).toBe(true);
  });

  it('resets both bounds on publish', () => {
    let state = createThrottleState(1_000);
    for (let i = 0; i < 250; i += 1) state = countRecipient(state);
    state = markPublished(state, 1_500);
    expect(shouldPublishProgress(state, 1_999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify RED**

```bash
pnpm --filter @eow/worker test -- progress-throttle
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `progress-throttle.ts`**

§3.3's code verbatim.

- [ ] **Step 4: Write the failing envelope test**

Create `apps/worker/src/campaign-send/progress-event.test.ts` asserting every
`EventEnvelope` required field is present and correctly typed, that `version`
equals the supplied `progressSeq`, and that a JSON round-trip of the payload
contains **no** `@`-bearing string (the crude but effective no-PII assertion for
A8/A21).

- [ ] **Step 5: Run to verify RED, then write `progress-event.ts` in both apps**

Same transliteration rule as CP3: `apps/worker/src/campaign-send/progress-event.ts`
and `apps/api/src/campaigns/progress-event.ts`, each naming the other.

- [ ] **Step 6: Run to verify GREEN**

```bash
pnpm --filter @eow/worker test -- "progress-throttle|progress-event" && pnpm --filter @eow/api test -- progress-event
```

Expected: PASS (A6, A8).

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/campaign-send apps/api/src/campaigns
git commit -m "M6-S1 CP4: throttle gate and campaign.progress envelope builder (A6, A8)"
```

### CP5 — snapshot persistence and the parity guard, RED first

- [ ] **Step 1: Write the failing parity test**

Create `packages/architecture-tests/src/progress-parity.test.ts` modelled on
`suppression-parity.test.ts`: both `progress-snapshot.ts` files exist, each names
the other in a comment, and both contain every required token —
`progress_seq = progress_seq + 1`, `eligibility = 'sendable'`,
`outcome = 'submitted'`, and each of the nine `*_count` column names.

- [ ] **Step 2: Run to verify RED**

```bash
pnpm --filter @eow/architecture-tests test -- progress-parity
```

Expected: FAIL — files do not exist.

- [ ] **Step 3: Write the failing integration test**

In `apps/worker/src/campaign-send/progress-snapshot.integration.test.ts`: seed a
snapshot with a known status mix, call `readProgressFacts()` and assert the counts
sum to `total_snapshot`; call `writeProgressSnapshot()` twice and assert
`progress_seq` increased by exactly 2 and the stored counts equal the facts (A3,
A9's single-writer half).

- [ ] **Step 4: Write both `progress-snapshot.ts` files**

§3.2's SQL, transliterated for `pg.PoolClient` (worker) and `EntityManager` (API).

- [ ] **Step 5: Run to verify GREEN**

```bash
pnpm --filter @eow/worker test -- progress-snapshot && pnpm --filter @eow/architecture-tests test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/campaign-send apps/api/src/campaigns packages/architecture-tests/src/progress-parity.test.ts
git commit -m "M6-S1 CP5: progress snapshot persistence and ARCH-PROGRESS-PARITY (A3, A9)"
```

### CP6 — worker publish path, RED first

- [ ] **Step 1: Write the failing integration test**

In `apps/worker/src/campaign-send/send.integration.test.ts`, add a case that seeds
**600** sendable recipients, runs `sendClaimedBatch` with `batchSize = 600`, a
stub `SmtpSendFn` and a **capturing** publisher, then asserts: at least 3 events
were published (600 / 250, A7); no two events share a `version`; and the final
event's counts equal a fresh `readProgressFacts()` read. Add a second case
asserting a publisher that **throws** does not fail the batch (DEC-124).

- [ ] **Step 2: Run to verify RED**

```bash
pnpm --filter @eow/worker test -- send.integration
```

Expected: FAIL — `sendClaimedBatch` takes no publisher.

- [ ] **Step 3: Wire the publisher into `send.ts` and `run.ts`**

§3.4 exactly: count after each committed row, publish when the gate opens, wrap
every publish in try/catch, and add the mandatory post-`aggregateExecution` flush
in `runOneCampaign`.

- [ ] **Step 4: Write `redis-campaign-event-publisher.ts` and its unit test**

§3.3's code. Test: channel name is `eow:campaign:{id}`; a missing `aggregate_id`
throws.

- [ ] **Step 5: Wire `main.ts`**

Create the campaign publisher beside the existing `publishJobEvent` and pass it
through `scanQueuedCampaigns`.

- [ ] **Step 6: Run to verify GREEN, including the untouched neighbours**

```bash
pnpm --filter @eow/worker test
```

Expected: PASS, and `run.integration.test.ts` passes **unmodified** — if it needed
editing, the signature change was not backward-compatible.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src
git commit -m "M6-S1 CP6: throttled campaign.progress publishing from the send loop (A7, DEC-124)"
```

### CP7 — gateway rooms, RED first (real socket)

- [ ] **Step 1: Write the failing parser test**

Create `apps/api/src/realtime/realtime-campaign-rooms.test.ts` mirroring
`realtime-job-rooms.test.ts`: singular and plural shapes, dedupe, non-string
rejection, over-limit (11 ids) returning `[]` (A12).

- [ ] **Step 2: Run to verify RED, then write `realtime-campaign-rooms.ts`**

§3.6's code.

- [ ] **Step 3: Write the failing real-socket integration test**

Create `apps/api/test/integration/realtime-campaign.test.ts`: boot the Nest app on
an ephemeral port, connect a real `socket.io-client` with a valid session cookie
and `{campaignIds:[id]}`, publish an event to `eow:campaign:{id}` through a real
ioredis client, and await its arrival on the socket. Then the negatives, each
asserting **disconnection and no room membership**: another tenant's campaign id,
no cookie, an expired session, an inactive user, and a user without
`CAMPAIGN_READ` (A10, A11). Await explicit events; never sleep (R3).

- [ ] **Step 4: Run to verify RED**

```bash
pnpm --filter @eow/api test -- realtime-campaign
```

Expected: FAIL — socket connects but joins no campaign room.

- [ ] **Step 5: Extract `authorizeConnection` and add both branches**

§3.6: one shared auth preamble, a campaign branch with `CAMPAIGN_READ` plus the
ownership query, an unconditional `user:{userId}` join, and the second
`psubscribe` pattern with the channel-prefix switch.

- [ ] **Step 6: Run to verify GREEN and that job rooms are untouched (R2)**

```bash
pnpm --filter @eow/api test
```

Expected: PASS, with the import/bulk realtime tests passing **unmodified**.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/realtime apps/api/test/integration/realtime-campaign.test.ts
git commit -m "M6-S1 CP7: tenant-authorised campaign and user rooms (A10, A11, A12)"
```

### CP8 — API read path and webhook publish, RED first

- [ ] **Step 1: Write the failing progress-response test**

In `apps/api/test/integration/campaign-send-http.test.ts`, assert
`GET /campaigns/{id}/progress` now returns `percent`, `actionable`, `progressSeq`
and a real `eta` — `{state:'estimating'}` before enough samples, `null` once
terminal (A5's API half, BR-HIS-002's "cùng nguồn backend").

- [ ] **Step 2: Write the failing webhook-publish test**

In `apps/api/test/integration/webhooks.test.ts`, add a capturing publisher and
assert a `delivered` apply publishes exactly one `campaign.progress` whose
`delivered` is one higher, and that a **rejected** (401 / unmatched) request
publishes nothing (A13).

- [ ] **Step 3: Run to verify RED**

```bash
pnpm --filter @eow/api test -- "campaign-send-http|webhooks"
```

Expected: FAIL — `eta` is still hard-coded `null`, nothing publishes.

- [ ] **Step 4: Implement**

Rewrite `getCampaignProgress` to use `readProgressFacts` + `progress-math`; create
`apps/api/src/realtime/redis-campaign-publisher.ts` (a publish-only ioredis
client, §3.5); publish from `webhooks.service.ts` **after** the transaction
commits.

- [ ] **Step 5: Run to verify GREEN**

```bash
pnpm --filter @eow/api test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "M6-S1 CP8: real ETA on the progress route and webhook-driven publishing (A5, A13)"
```

### CP9 — reconciliation, RED first

- [ ] **Step 1: Write the failing TC-HIS-010 fixture test**

Create `apps/worker/src/progress-reconcile.integration.test.ts`. Seed an execution
with 82 recipients whose `delivery_event` ledger says `delivered`, then force
`campaign_recipient.status` back to `submitted` on 2 of them and set the stored
`delivered_count` to 80. Assert one `reconcileProgress()` run: repairs both rows;
writes exactly one `progress.reconciled` audit row whose metadata carries the
delta; returns a metric with `value` equal to the drift magnitude; and publishes
one `campaign.progress` (A14).

- [ ] **Step 2: Write the failing idempotence test**

A **second** run over the same data changes nothing, writes no second audit row,
and reports `value: 0` (A15).

- [ ] **Step 3: Write the failing no-regression test**

A recipient already at `delivered` with a `delivery_state_at` **later** than the
ledger row's `occurred_at` is left untouched (A16).

- [ ] **Step 4: Run to verify RED**

```bash
pnpm --filter @eow/worker test -- progress-reconcile
```

Expected: FAIL — module not found.

- [ ] **Step 5: Implement `progress-reconcile.ts` and `progress-metrics.ts`**

§3.7 exactly, reusing `decideWebhookOutcome`'s decision (transliterated into the
worker alongside the existing `suppression.ts` precedent, and added to
`ARCH-PROGRESS-PARITY`'s token list).

- [ ] **Step 6: Replace the stub in `main.ts`**

```ts
case 'progress-reconcile': {
  const databaseUrl = process.env.OUTBOX_DATABASE_URL;
  if (!databaseUrl) throw new Error('OUTBOX_DATABASE_URL is required for the narrow cross-tenant progress reconciliation scan. Owner/superuser credentials are forbidden.');
  const results = await reconcileProgress(databaseUrl, process.env.REDIS_URL ?? 'redis://localhost:6379');
  return { executionsScanned: results.length, executionsRepaired: results.filter(r => r.drift > 0).length };
}
```

- [ ] **Step 7: Write the failing resync test, then implement**

Assert `rt.resync_required` is emitted to `user:{userId}` for every tenant user
holding `CAMPAIGN_READ` when — and only when — something was repaired (A17).

- [ ] **Step 8: Run to verify GREEN**

```bash
pnpm --filter @eow/worker test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/worker/src
git commit -m "M6-S1 CP9: progress reconciliation, drift metric and resync (A14, A15, A16, A17, D-115)"
```

### CP10 — web client, RED first

- [ ] **Step 1: Write the failing pure-logic tests**

Create `apps/web/src/screens/history/campaign-realtime.test.ts`: an event with a
higher `version` is applied; an equal or lower `version` is discarded; a different
`aggregate_id` is discarded; a non-numeric `version` is discarded (A18).

- [ ] **Step 2: Run to verify RED, then write `campaign-realtime.ts`**

§3.9's code.

- [ ] **Step 3: Write the failing connection-state test**

Assert `useRealtimeStatus()` maps `disconnect` to `'reconnecting'` and `connect`
back to `'live'`, and that the poll interval is 3 000 ms while reconnecting and
15 000 ms while live (A19's unit half).

- [ ] **Step 4: Implement `subscribeToCampaigns`, the hook, and the banner changes**

§3.9. Keep the existing 3-second poll; make its cadence conditional; refetch
immediately on every transition back to `'live'`.

- [ ] **Step 5: Run to verify GREEN**

```bash
pnpm --filter @eow/web test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "M6-S1 CP10: campaign.progress subscription, monotonic client cursor and reconnecting state (A18, A19, DEC-121)"
```

### CP11 — the drawer, the route and contracts

- [ ] **Step 1: Write the failing drawer test**

Create `apps/web/src/screens/history/CampaignProgressDrawer.test.tsx` asserting
all nine BR-HIS-002 fields render from one response object, the tooltip
distinguishing sent from delivered is present, and `eta === null` renders no ETA
row at all (A20's unit half).

- [ ] **Step 2: Run to verify RED, then build the drawer and the route**

§3.10. Build from the approved overlay markup; add `/history/:campaignId` to the
router; link it from `SendingBanner`.

- [ ] **Step 3: Update the contracts**

§4: widen `CampaignProgress` in `contracts/openapi.yaml`, add the
`campaign_progress` version comment to `contracts/asyncapi.yaml`.

```bash
pnpm contracts:generate && pnpm contracts:compat-check
```

Expected: both green; `apps/web` compiles against generated types only (ADR-005).

- [ ] **Step 4: Run to verify GREEN**

```bash
pnpm run check
```

Expected: green, counts compared to CP0.

- [ ] **Step 5: Commit**

```bash
git add apps/web contracts
git commit -m "M6-S1 CP11: BR-HIS-002 progress drawer, /history/:campaignId route and contract widening (A20)"
```

### CP12 — visual evidence, drift proof and close

- [ ] **Step 1: Capture the visual evidence**

Use the existing `apps/web/e2e/visual-capture.spec.ts` helper pattern and the
out-of-process fixture pattern to seed a mid-send campaign. Capture the drawer at
**3 viewports** into `evidence/visual/M6-S1-realtime-progress/production/`,
including the **reconnecting** state (`design-reference/visual-acceptance.md`
requires it and the gate condition names it).

- [ ] **Step 2: Individually inspect every image**

A green Playwright run is **not** evidence (D-78, reconfirmed as D-104). Open each
file.

- [ ] **Step 3: Prove `eow_progress_reconcile_drift` is 0**

Add `apps/worker/src/progress-reconcile.evidence.test.ts` — an integration test
that runs `reconcileProgress()` twice against the live database and asserts every
returned `drift` is `0` on the second pass, printing each execution's metric line:

```bash
pnpm --filter @eow/worker test -- progress-reconcile.evidence 2>&1 | tee evidence/M6-S1-realtime-progress/reconcile-drift.log
```

Expected: every execution reports `value: 0` (A21). No CLI binary is added — the
test is the runnable artifact, so the proof re-runs with `pnpm check` instead of
depending on a one-off script nobody maintains. This is the gate condition's own
evidence and it must be a re-run, not a recollection.

- [ ] **Step 4: Update traceability**

Close `BR-SEND-003`, `BR-SEND-005`, `BR-HIS-002`, `BR-HIS-008` in
`traceability.csv` with real `code_paths` / `test_files` / `migration_files` /
`asyncapi_channels` / `log_or_metric_or_audit` values. Mark **`BR-SEND-004`
`partially_closed`** with the TC-SEC-016 exclusion stated in its own evidence cell
(R5) — do not mark it `closed`. In every one of the five rows, state that the
**UI-HIS-001** surface is M6-S3's and that this node's screen evidence is
**UI-HIS-002** only (§3.10, DEC-131) — a rule closed without that note reads as if
both screens were verified.

- [ ] **Step 5: Update the ExecPlan**

Record `D-115`…`D-117` in §19 and `DEC-121`…`DEC-131` in §20; replace §10's
placeholder row with migration `028`; correct `DEC-097`'s stale BR-SEND-009
reference per §0(i).

- [ ] **Step 6: Run the full verification set**

```bash
pnpm run check && pnpm contracts:compat-check && python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Expected: green, with test **and skip** counts compared against CP0's baseline.
Then run `ARCH-MIGRATION` and `ARCH-CSV-SHAPE` standalone.

- [ ] **Step 7: Update `state.json` and commit**

Flip `M6-S1-realtime-progress` to `completed` **only** after every success
condition has re-run evidence attached. Note in the commit body that the
one-command deployment contract is unchanged (no new env var, port, migration
runner change or startup change) — §4.

```bash
git add .agents/runs/2026-08-10-eow-master-execplan evidence docs
git commit -m "M6-S1-realtime-progress: completed (5 rules -- 4 closed/1 partially_closed by design)"
```

> `M6-S3-history-recovery` becomes runnable on that flip and inherits three things
> named here: the `/history/:campaignId` route and drawer (**UI-HIS-002**) already
> exist and must be **wired to**, not rebuilt; **UI-HIS-001** is unbuilt and carries
> the second UI surface of `BR-SEND-003/004/005` and `BR-HIS-008` (§3.10, DEC-131);
> and **BR-SEND-009 (pause/resume) is still claimed by no closed slice** — this node
> does not close it and does not pretend to (§0(i)).
