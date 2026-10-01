# M5-S2 Schedule Implementation Plan

Node: `M5-S2-schedule` · Depends on: `M4-GATE` (completed 2026-08-17), `M5-S1-sender-config` (completed)
Owns rules: **BR-SCH-001 … BR-SCH-010** (10) + **BR-GEN-003** (reallocated from M1, DEC-027) = **11 rules**
Test cases: **TC-SCH-001 … TC-SCH-013** (13) + **TC-GEN-003**
Overlay: `scheduleSend` (handoff `action-overlays.tsx:142-149`, never ported) · Screen: extends `UI-EMAIL-001` (compose)
Reserved: migration **024** (not 023 — see §0), decisions **DEC-088…093**, defects **D-80…86**
(`DEC-094` is taken: it records the 2026-08-17 partial merge of the preserved branch — see §0.)
Solo execution (no Codex split — same as M4-S2/M4-S3/M4-S4).

---

## 0. Read this before touching anything

Three findings from the 2026-08-17 progress review change the starting conditions
of this node. None of them is optional context.

**(a) Migration 023 is reserved, not free.** The 023-independent majority of the
preserved branch was merged to `main` on 2026-08-17 (commit `6fa4ba3`, DEC-094):
the hardened `database/migrate.sh`, `migration-execution-safety.test.ts`,
`migration-runner-atomicity.test.ts`, the rewritten `migration-immutability.test.ts`,
the `segments.service.ts` `superseded_at` fix and 23 probe fixtures.

Branch `migration-023-campaign-snapshot-hardening` (formerly
`worktree-agent-a8eeee7ebc8e3dc32`, tip `0c7af9a`) still holds **four coupled
items that are guaranteed-red on `main` without each other**, and this node's CP1
must land all four in one go:

1. `database/migrations/023_campaign_snapshot_hardening.sql`
2. `campaign-snapshot-immutability.test.ts`'s four added cases — `022` guards
   neither `id`/`tenant_id`/`frozen_by` on the snapshot trigger nor
   `id`/`tenant_id` on the recipient trigger, and has no
   `campaign_snapshot_counts_valid` CHECK; all three are `023`'s, and those tests
   expect `55000`/`23514` for exactly them (verified against `022`, not assumed)
3. `migration-runner-behavior.test.ts` (1410 lines) — it reads `023` from the
   repo, applies it, and asserts its composite-FK topology
4. the two entity `default:` changes (`variable_schema_json`, `email_snapshot`),
   which mirror `023`'s `ALTER COLUMN … SET DEFAULT`

**This node takes 024.** Taking 023 would collide with that file and put two
checksums against one number in `database/migrations.lock.json` — precisely the
drift `ARCH-MIGRATION` exists to catch. Recorded as DEC-087/DEC-094/D-79.

**(b) That preserved migration would break this node's own headline requirement.**
`023` rewrites `campaign_no_edit_after_send()` to raise `55000` whenever
`OLD.status <> 'draft'` and `scheduled_at_utc` or `scheduled_timezone` changed.
Under that trigger:

- the initial schedule (`draft → scheduled`, setting `scheduled_at_utc` in the
  same `UPDATE`) raises, because `NEW.status <> 'draft'` is enough to arm the guard;
- every reschedule raises.

So `023` cannot be adopted verbatim, and this node cannot silently ignore it
either. §3.1 reconciles the two deliberately: the columns are writable **on the
`draft → scheduled` transition only** and frozen afterwards. Whoever merges
`023` must land that reconciliation with it.

**(c) The campaign status vocabulary is short by two values, and OpenAPI
disagrees with the database.** Verified directly:

| Source | Values |
|---|---|
| `018_campaign_status_values.sql` CHECK | draft, scheduled, queued, validating, sending, paused, completed, **partial_failed**, failed, cancelled |
| `campaign.entity.ts:4` `CampaignStatus` | identical to the CHECK |
| `contracts/openapi.yaml:1126` `CampaignProgress.status` | scheduled, queued, sending, completed, **partially_failed**, failed, cancelled, **missed** |

Two real defects fall out, both pre-existing and neither this node's fault:

- `partially_failed` (OpenAPI) vs `partial_failed` (DB + TS) — a live contract
  drift on an operation that is still a mock, which is why nothing has failed yet.
- `missed` is in OpenAPI but in neither the CHECK nor the TS union, and
  `blocked` (BR-SCH-009's required state) is in none of the three.

BR-SCH-007 needs `missed` and BR-SCH-009 needs `blocked`, so this node must widen
the CHECK anyway (§3.1). The `partial_failed`/`partially_failed` drift is
**disclosed and fixed in the same migration+contract pass** rather than left for
M5-S3 to trip over. Record as D-80.

---

## 1. What this slice turns from definition into fact

M4-S4 made a campaign stop being a query and become a fixed set of rows — but
only through `POST /campaigns/{id}/send`, which freezes and lands in `queued`
where **nothing consumes it**. `POST /campaigns/{id}/schedule` is still M4-S1's
mock: `campaigns.service.ts:363` returns a literal object from an in-memory shape,
and `campaigns.controller.ts:67` is the only mutating campaign route with **no
`CsrfGuard`, no `tenantId`, and no actor** — it never touches the database at all.

This slice is the moment a campaign acquires a *future*: a stored instant, a
stored zone, a dispatcher that fires exactly once, and a defined answer for what
happens when the dispatcher is late.

### The eleven rules, in their own words

| Rule | What it actually requires | P |
|------|---------------------------|---|
| BR-SCH-001 | `scheduled_at` at least 2 minutes ahead and at most 12 months out; **both thresholds configurable**. Outside → 422 carrying the min/max timestamps. | P0 |
| BR-SCH-002 | User picks an IANA zone; backend stores `scheduled_at` in UTC **and the original zone name**. Round-trip displays the correct local time, DST included. | P0 |
| BR-SCH-003 | A local time that does not exist (spring-forward gap) is rejected; an ambiguous one (fall-back repeat) **must require an explicit offset choice**. API returns candidate offsets and never guesses. | P1 |
| BR-SCH-004 | Schedule succeeds only when sender, template, audience, consent and variable validation pass; returns a `validation_report`; no job is created if a blocking error exists. | P0 |
| BR-SCH-005 | A scheduled campaign can be edited or cancelled up to a **2-minute lock window**; editing **re-creates the snapshot and validation**. Inside the window an update returns 409; cancelling before it moves to `cancelled`. | P0 |
| BR-SCH-006 | The scheduler uses a distributed lock / idempotency so a due campaign is enqueued **exactly once**, even with multiple replicas. | P0 |
| BR-SCH-007 | If the worker is late the campaign still runs and records `actual_started_at` / `delay_seconds`; past a threshold it alerts. | P1 |
| BR-SCH-008 | Cancelling a not-yet-started campaign sends nothing and releases any quota reservation; status `cancelled`, pending recipients `0` queued, audit records actor and reason. | P0 |
| BR-SCH-009 | A sender account disabled before run time makes the campaign **`blocked`**; the system never silently switches sender. Owner is warned and can pick a new sender and revalidate. | P0 |
| BR-SCH-010 | Create / edit / cancel / failure of a schedule creates a notification for the owner; it carries campaign, time+zone, state and link, and leaks no secret. | P2 |
| BR-GEN-003 | Every timestamp stored UTC; API returns ISO-8601 UTC **plus `timezone_name`**; the UI renders in the selected zone. | P0 |

The binding sentence for this node, in the same shape M4-S2/S3/S4 each had one:
**PostgreSQL is the only authority on whether a campaign is due, and the claim
that flips it from `scheduled` to `queued` is a single atomic SQL statement.**
BullMQ's delayed job is an accelerator and the periodic scan is a safety net;
both converge on that one claim, so neither can produce a second dispatch. A
design where the queue holds the authoritative due-state is the exact defect
class ADR-012 and AGENTS.md §2 ("never make a UI socket payload the only copy of
business state") exist to prevent — here applied to the queue rather than the
socket.

### Hard non-goals

- **No sending.** M5-S3 owns `validate → freeze → partition → send → aggregate`,
  batching, retries, provider submission and Mailpit arrival. This slice makes a
  campaign become due and land in `queued` with a frozen snapshot, exactly where
  `sendCampaign` already leaves it. Nothing consumes `queued` when this node
  closes — deliberately visible, not pretended (the DEC-081 precedent).
- **No quota validation.** BR-SCH-004's acceptance names "quota validation", but
  no quota ledger exists until M7-S1 (`BR-CFG-006`), and `CAMPAIGN_AUDIENCE_LIMIT`
  is a static ceiling, not a consumable reservation (`config/env.ts:18-24` says so
  in its own comment). The `validation_report` therefore carries sender, template,
  audience and variable sections and **explicitly omits quota**, disclosed in the
  response shape rather than faked as passing. Same reasoning retires BR-SCH-008's
  "releases any quota reservation" clause to M7-S1. Record as DEC-088.
- **No realtime emission.** `schedule.state_changed` already exists in
  `contracts/asyncapi.yaml:60-64` and `catalog/realtime-events.json`, but **no
  code anywhere subscribes to or publishes any campaign channel** (verified: zero
  hits for `campaign.state_changed`/`schedule.state_changed` in `apps/api/src` and
  `apps/worker/src`). M6-S1 owns realtime. This node writes the **outbox row**,
  which is the durable record M6-S1 will relay — the same thing M4-S4 did with
  `campaign.snapshot_frozen` and M2-S4 did with `bulk-update.job.created` before
  their consumers existed.
- **No history surface.** BR-SCH-007's "History hiển thị thời gian dự kiến và
  thực tế" needs `/history/:campaignId`, which is `UI-HIS-002`, `not_inventoried`,
  owned by M6-S3. This node **persists** `actual_started_at`/`delay_seconds` and
  proves them by integration test; rendering them is M6-S3's. Record as DEC-089.
- **No general state machine.** BR-SEND-001 is M5-S3's. This node performs exactly
  five transitions — `draft→scheduled`, `scheduled→queued` (dispatch),
  `scheduled→cancelled`, `scheduled→missed`, `scheduled→blocked` — and builds no
  general machine.
- **`023` is adopted at CP1, as a four-item unit, not piecemeal.** §0(a) lists the
  four; landing any one without the others is red. CP1 applies `023` *before*
  `024` so the reconciled `campaign_no_edit_after_send()` in `024` is the one that
  survives — both are `CREATE OR REPLACE` on the same function, so ordering is the
  whole correctness argument here (§5 R1).

---

## 2. Acceptance criteria

| # | Criterion | Rule | Test case | Proof layer |
|---|-----------|------|-----------|-------------|
| A1 | `POST /campaigns/{id}/schedule` with a valid future instant + IANA zone stores `scheduled_at_utc` in UTC and `scheduled_timezone` as the original zone name, and returns both plus the ISO-8601 UTC instant | BR-SCH-002, BR-GEN-003 | TC-SCH-002, TC-GEN-003 | integration |
| A2 | Round-trip through three zones (`Asia/Ho_Chi_Minh` no-DST, `Europe/Berlin` DST, `UTC`) returns the same local wall time the caller sent, across a DST boundary in both directions | BR-SCH-002, BR-GEN-003 | TC-SCH-002 | unit + integration |
| A3 | An instant less than the configured minimum lead (default 2 min) or beyond the configured maximum horizon (default 12 months) is refused **422 carrying the computed `minAt`/`maxAt`** — not a bare message | BR-SCH-001 | TC-SCH-001 | integration |
| A4 | A local time inside a spring-forward gap is refused 422 with `code: NONEXISTENT_LOCAL_TIME`; the system never silently shifts it | BR-SCH-003 | TC-SCH-003, TC-SCH-011 | unit + integration |
| A5 | An ambiguous fall-back local time is refused 422 with `code: AMBIGUOUS_LOCAL_TIME` **and both candidate offsets**; supplying one explicitly then succeeds | BR-SCH-003 | TC-SCH-003, TC-SCH-011 | unit + integration |
| A6 | Scheduling freezes a snapshot through the **same `freezeCampaignSnapshot`** `sendCampaign` uses (one function, one freeze path — DEC-080), landing the campaign in `scheduled` rather than `queued` | BR-SCH-004, BR-CMP-007 | TC-SCH-004 | integration |
| A7 | Scheduling returns a `validation_report` and creates **no** schedule when a blocking error exists (missing sender / missing template version / audience over limit / uncovered missing variables) — asserted per blocking cause, not once generically | BR-SCH-004 | TC-SCH-004 | integration |
| A8 | Rescheduling a campaign outside the lock window supersedes the live snapshot and freezes a **new** one; the superseded snapshot stays readable and immutable | BR-SCH-005 | TC-SCH-005 | integration |
| A9 | Any schedule mutation inside the 2-minute lock window returns 409 | BR-SCH-005 | TC-SCH-005 | integration |
| A10 | A due campaign claimed concurrently by two dispatchers produces exactly one `scheduled → queued` transition and one outbox row; the loser observes zero claimed rows | BR-SCH-006 | TC-SCH-006, TC-SCH-012 | integration (real PostgreSQL, genuinely concurrent) |
| A11 | Re-running the dispatcher over an already-claimed campaign is a no-op — proven by running the claim twice and asserting row counts, not by trusting the first result | BR-SCH-006 | TC-SCH-006 | integration |
| A12 | A campaign due ≤ 15 minutes ago still dispatches and records `actual_started_at` and a `delay_seconds` matching the real lateness | BR-SCH-007 | TC-SCH-007 | integration |
| A13 | A campaign due > 15 minutes ago (threshold configurable) transitions to `missed`, dispatches nothing, and writes a notification | BR-SCH-007, BR-SCH-010 | TC-SCH-007 | integration |
| A14 | Cancelling a `scheduled` campaign before the lock window moves it to `cancelled`, supersedes its snapshot, leaves **0** recipients queued, and audits actor + reason | BR-SCH-008 | TC-SCH-008 | integration |
| A15 | A campaign whose sender config is `disabled` at claim time transitions to `blocked`, dispatches nothing, never substitutes another sender, and notifies the owner; the frozen `sender_json` is unchanged | BR-SCH-009 | TC-SCH-009, TC-SCH-013 | integration |
| A16 | Schedule created / rescheduled / cancelled / missed / blocked each write an `audit_log` row (`schedule.created`, `schedule.rescheduled`, `schedule.cancelled`, `schedule.missed`, `schedule.blocked`) and a durable notification, and **no notification body contains a secret, SMTP credential or recipient custom value** | BR-SCH-010, BR-SEC-003 | TC-SCH-010 | integration |
| A17 | Two concurrent `POST /schedule` with the same `Idempotency-Key` create exactly one schedule and one snapshot; the same key with a materially different payload returns 409; a missing key returns 400 | BR-CMP-010, BR-GEN-005 | TC-SCH-006 | integration |
| A18 | Cross-tenant: a scheduled campaign is unreadable, unreschedulable and unclaimable from another tenant | domain invariant | — | integration |
| A19 | The `scheduleSend` overlay shows the resolved local time + zone, blocks submission while in flight, and surfaces the DST/lead-time 422s as human-readable copy rather than a raw problem body | BR-SCH-001, BR-SCH-003, BR-GEN-003 | TC-SCH-001, TC-SCH-011 | e2e + visual |
| A20 | The compose screen shows a `scheduled` banner (time, zone, countdown to lock) with "Hủy lịch" and "Đổi giờ" actions, and every field read-only | BR-SCH-005, BR-SCH-008 | TC-SCH-005 | e2e + visual |

---

## 3. Locked design

### 3.1 Migration 024 — `024_campaign_schedule.sql`

`campaign.scheduled_at_utc` and `campaign.scheduled_timezone` already exist
(`001_initial.sql:58-59`) with `idx_campaign_status_schedule (tenant_id, status,
scheduled_at_utc)` already in place (`001_initial.sql:97`). So this migration adds
the *missing* half: the two status values, the lateness columns, the dispatch
claim's supporting index, and the trigger reconciliation from §0(b).

```sql
-- M5-S2 -- scheduling. 001_initial.sql already published scheduled_at_utc,
-- scheduled_timezone and idx_campaign_status_schedule; 018 published the status
-- CHECK. Both are untouched here (forward-only).

-- BR-SCH-007 needs 'missed'; BR-SCH-009 needs 'blocked'. 018's CHECK has
-- neither, and contracts/openapi.yaml:1126 additionally spells partial_failed as
-- "partially_failed" -- a live drift on a still-mocked operation (D-80). The DB
-- spelling wins (it is what campaign.entity.ts and every row already use); the
-- OpenAPI enum is corrected in CP5 to match, not the other way round.
ALTER TABLE campaign DROP CONSTRAINT campaign_status_known;
ALTER TABLE campaign
  ADD CONSTRAINT campaign_status_known CHECK (status IN (
    'draft', 'scheduled', 'blocked', 'missed',
    'queued', 'validating', 'sending', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled'
  ));

-- BR-SCH-007: expected vs actual, persisted here, rendered by M6-S3 (DEC-089).
ALTER TABLE campaign
  ADD COLUMN IF NOT EXISTS actual_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS delay_seconds integer,
  ADD CONSTRAINT campaign_delay_seconds_nonnegative
    CHECK (delay_seconds IS NULL OR delay_seconds >= 0);

-- A scheduled campaign must carry both halves of BR-SCH-002 or neither.
ALTER TABLE campaign
  ADD CONSTRAINT campaign_schedule_complete CHECK (
    (scheduled_at_utc IS NULL AND scheduled_timezone IS NULL)
    OR (scheduled_at_utc IS NOT NULL AND scheduled_timezone IS NOT NULL)
  );

-- The dispatch claim (SS3.4) is a partial-index scan over due rows only. The 001
-- index is (tenant_id, status, scheduled_at_utc) and therefore cannot serve a
-- cross-tenant sweep, which is exactly what the dispatcher performs.
CREATE INDEX IF NOT EXISTS idx_campaign_due_schedule
  ON campaign (scheduled_at_utc)
  WHERE status = 'scheduled' AND deleted_at IS NULL;

-- SS0(b) reconciliation. 022's version guards seven content columns whenever
-- OLD.status is non-draft, and does NOT mention scheduled_at_utc/timezone -- so
-- today a scheduled campaign's time is silently PATCHable. The preserved-but-
-- unmerged 023 goes to the opposite extreme and blocks the draft->scheduled
-- transition itself. Neither is right: the schedule columns must be writable on
-- the transition INTO scheduled, and frozen once there.
CREATE OR REPLACE FUNCTION campaign_no_edit_after_send()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('queued', 'validating', 'scheduled', 'blocked', 'missed', 'sending', 'completed')
    AND (
      OLD.name IS DISTINCT FROM NEW.name
      OR OLD.subject IS DISTINCT FROM NEW.subject
      OR OLD.template_id IS DISTINCT FROM NEW.template_id
      OR OLD.template_version_id IS DISTINCT FROM NEW.template_version_id
      OR OLD.sender_json IS DISTINCT FROM NEW.sender_json
      OR OLD.audience_json IS DISTINCT FROM NEW.audience_json
      OR OLD.settings_json IS DISTINCT FROM NEW.settings_json
    ) THEN
    RAISE EXCEPTION 'Campaign content cannot be edited after it has been frozen for sending'
      USING ERRCODE = '55000';
  END IF;

  -- BR-SCH-005: the schedule instant is set on the draft->scheduled transition
  -- and immutable thereafter. Changing it requires cancel-then-reschedule, which
  -- is the rule's own "chinh sua tao lai snapshot va validation" -- not an
  -- in-place UPDATE.
  IF OLD.status <> 'draft'
    AND (
      OLD.scheduled_at_utc IS DISTINCT FROM NEW.scheduled_at_utc
      OR OLD.scheduled_timezone IS DISTINCT FROM NEW.scheduled_timezone
    )
    AND NOT (OLD.status = 'scheduled' AND NEW.status IN ('cancelled', 'missed'))
    THEN
    RAISE EXCEPTION 'A scheduled campaign''s time cannot be edited in place; cancel and reschedule'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
```

The `NOT (... NEW.status IN ('cancelled','missed'))` carve-out exists because
cancel and misfire both **clear** the schedule columns in the same `UPDATE` that
changes status. Without it the trigger would make its own required transitions
impossible — the identical trap DEC-082 recorded for `001`'s blanket
`UNIQUE(campaign_id)`. Write the failing test for that carve-out *first* (CP1).

Applied via `docker compose run --rm migrate` — never `docker exec`/`docker cp` —
then `database/migrations.lock.json` gets its 024 entry and `ARCH-MIGRATION` is
re-run **standalone**.

### 3.2 Zone arithmetic — `apps/api/src/campaigns/schedule-time.ts`

**No new dependency.** ADR-018 and AGENTS.md §5 require license/security/
maintenance/bundle review before adding one, and `Intl.DateTimeFormat` with a
`timeZone` gives everything BR-SCH-002/003 need. One pure module, no I/O, unit-
tested in isolation before any HTTP path exists:

```ts
export type LocalScheduleInput = { localDateTime: string; timeZone: string; offsetMinutes?: number };
export type ResolvedSchedule = { scheduledAtUtc: Date; timeZone: string; offsetMinutes: number };
export type ScheduleResolutionError =
  | { code: 'UNKNOWN_TIME_ZONE'; timeZone: string }
  | { code: 'NONEXISTENT_LOCAL_TIME'; localDateTime: string; timeZone: string; suggestedAtUtc: Date }
  | { code: 'AMBIGUOUS_LOCAL_TIME'; localDateTime: string; timeZone: string; candidateOffsetMinutes: [number, number] };

export function resolveLocalSchedule(input: LocalScheduleInput): ResolvedSchedule | ScheduleResolutionError;
```

Mechanism, stated so the executor does not reinvent it: compute the zone's offset
at two probe instants bracketing the candidate (local − 24h, local + 24h), build
one UTC candidate per distinct offset, then **format each candidate back into the
zone** and keep only those whose formatted local time equals the requested one.
Zero survivors → `NONEXISTENT_LOCAL_TIME` (spring-forward gap). Two → 
`AMBIGUOUS_LOCAL_TIME` with both offsets, resolvable only by an explicit
`offsetMinutes`. Exactly one → resolved. This is round-trip *verification*, not
offset arithmetic, so it is correct for any zone rule Node's ICU knows, including
historical and half-hour zones.

Returns errors as values rather than throwing (the `renderTemplateVariables`
strict-mode precedent at `template-variable-renderer.ts`, detected with
`'code' in result`), so the service maps them to 422 bodies and the unit tests
assert the discriminated union directly.

### 3.3 Scheduling — `CampaignsService.scheduleCampaign`

`campaigns.service.ts:363`'s mock and the guard-less controller route both go.
New signature mirrors `sendCampaign` exactly:

```ts
async scheduleCampaign(
  tenantId: string, campaignId: string, idempotencyKey: string | undefined,
  body: ScheduleCampaignDto, actor: CampaignActor,
): Promise<CampaignScheduleAccepted>
```

Inside one `runInTenantContext` transaction:

1. `findActiveById(id, /* lock */ true)` — the same pessimistic lock
   `sendCampaign`/`updateDraft`/`acceptAudienceWaiver` take.
2. `resolveLocalSchedule(...)` → 422 on any error value (A4/A5).
3. Lead/horizon bounds (A3), from two **new** `config/env.ts` entries, both
   `z.coerce.number()` with the BR-SCH-001 defaults spelled as defaults, not
   literals in code:
   `SCHEDULE_MIN_LEAD_SECONDS` (default `120`) and
   `SCHEDULE_MAX_HORIZON_DAYS` (default `365`). 422 carries the computed
   `minAt`/`maxAt` as ISO-8601 UTC.
4. Build the `validation_report` (A7) from the checks that already exist —
   `campaignCompleteness`, `computeCampaignVariableValidation`,
   `computeAudienceWaiverStatus`, the `CAMPAIGN_AUDIENCE_LIMIT` ceiling, and
   sender-config status. **Nothing is reimplemented**; the report is a projection
   of those results, and `quota` is absent by design (DEC-088).
5. Blocking error → 422 with the report, **no** state change.
6. `freezeCampaignSnapshot(manager, tenantId, campaign, actor, webOrigin,
   audienceLimit, { targetStatus: 'scheduled', scheduledAtUtc, scheduledTimezone })`.

`freezeCampaignSnapshot` currently hard-codes `status: 'queued'` in three places
(its `FrozenSnapshot` type, the `CampaignsRepository.save` at
`campaign-snapshot.ts:175`, and its return). DEC-080 committed this node to
wiring **the same function**, so it gains one options parameter rather than a
parallel copy:

```ts
type FreezeTarget =
  | { targetStatus: 'queued' }
  | { targetStatus: 'scheduled'; scheduledAtUtc: Date; scheduledTimezone: string };
```

`sendCampaign` passes `{ targetStatus: 'queued' }` and must be **unchanged in
behaviour** — CP2 re-runs M4-S4's entire `campaign-snapshot-freeze.test.ts` and
`campaign-snapshot-immutability.test.ts` unmodified as the regression proof, not
a rewritten version of them.

7. Audit `schedule.created`; outbox `schedule.state_changed` (aggregate
   `campaign`, version = the post-freeze version) — the channel already exists in
   `asyncapi.yaml:60-64`, no contract addition needed.
8. Notification for the owner (BR-SCH-010): campaign name, local time + zone,
   deep link. **No sender host, port, credential or recipient custom value.**

**Reschedule** is not a separate endpoint: it is `POST /schedule` on an already
`scheduled` campaign, and it runs cancel-then-schedule inside one transaction —
supersede the live snapshot, return to `draft`, then re-run steps 2-8. That is
BR-SCH-005's own sentence ("chỉnh sửa tạo lại snapshot và validation") executed
literally, it reuses `cancelCampaign`'s proven supersede path, and it is what
makes §3.1's trigger carve-out sufficient. Record as DEC-090.

**Lock window** (BR-SCH-005): any schedule mutation is refused 409 when
`scheduled_at_utc - now() <= SCHEDULE_LOCK_WINDOW_SECONDS` (new env entry,
default `120`). Checked **inside** the transaction after the row lock — checking
before it is a TOCTOU bug the dispatcher will win.

**Cancel** (BR-SCH-008): `cancelCampaign` currently hard-refuses anything but
`queued` (`campaigns.service.ts:409`). It gains `scheduled` as a legal source
state, transitioning to `cancelled` (not `draft` — a cancelled *schedule* is a
terminal state per BR-SCH-008's "Status cancelled", whereas M4-S4's
cancel-to-refresh legitimately returns to `draft`). Both paths supersede the live
snapshot. The two outcomes differing by source state is deliberate and is why
A14's assertion is on `cancelled`, not `draft`. Record as DEC-091.

### 3.4 Dispatch — exactly once (BR-SCH-006)

Existing infrastructure, verified: `apps/scheduler/src/main.ts` already runs a
BullMQ `Queue('campaign-execution')` ticking every `SCHEDULER_TICK_MS`
(default 60 s, floor 5 s) and enqueuing `campaign-misfire-scan` with a
bucket-derived `jobId`; `apps/worker/src/main.ts:18` handles that job as a stub
returning `note: 'Implement canonical PostgreSQL due-campaign scan in the
vertical slice'`. **This node is that vertical slice.**

The claim is one statement, and it is the whole of BR-SCH-006:

```sql
UPDATE campaign
   SET status = 'queued', actual_started_at = now(),
       delay_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - scheduled_at_utc))::integer)
 WHERE id = $1 AND tenant_id = $2
   AND status = 'scheduled'            -- the guard: only one UPDATE can match
   AND deleted_at IS NULL
 RETURNING id, scheduled_at_utc, delay_seconds;
```

`status = 'scheduled'` in the `WHERE` is the distributed lock. A second
dispatcher matches zero rows — no advisory lock, no Redis lock, no lease table.
This is the same claim-by-predicate pattern `bulk-processor.ts`'s
`claimPendingRows` already uses and the same reason it is safe. A10 proves it
with two genuinely concurrent transactions against real PostgreSQL; A11 proves
re-running is a no-op by row count.

Ordering inside the worker, per due campaign:

1. Read `scheduled_at_utc`; compute lateness.
2. `lateness > SCHEDULE_MISFIRE_GRACE_SECONDS` (new env entry, default `900` —
   the runbook's `send_if_late_within_15_minutes`, now configurable rather than a
   literal) → claim to **`missed`**, clear schedule columns, audit
   `schedule.missed`, notify, stop. (A13)
3. Else resolve the frozen snapshot's `sender_json.senderConfigId` and read
   `sender_config.status`. `disabled` → claim to **`blocked`**, audit
   `schedule.blocked`, notify, **never substitute a sender**, stop. (A15)
4. Else run the claim above → `queued`, audit `schedule.dispatched`, outbox
   `schedule.state_changed`. Nothing consumes `queued`; M5-S3 does. (A12)

The BullMQ delayed job added at schedule time is an **accelerator only** — it
carries `{campaignId, tenantId}` with `jobId = schedule-{campaignId}-{version}`
so a reschedule cannot leave a stale duplicate live. If Redis loses it, the
60-second scan still finds the row. If both fire, the claim admits one. Record
as DEC-092: the delayed job is a latency optimisation and is never the authority.

Cross-tenant note: the scan is by definition a cross-tenant sweep, so it uses the
**narrow `OUTBOX_DATABASE_URL` boundary** the outbox relay already established
(`worker/main.ts:20-21`: "Owner/superuser credentials are forbidden"), not a
tenant-context connection. Per-campaign work then re-enters
`runInTenantTransaction` with that campaign's tenant. Any other shape re-opens
the cross-tenant bypass the standardization workstream closed.

### 3.5 Notifications (BR-SCH-010)

`writeJobNotification` (`apps/worker/src/notification-writer.ts:24`) types
`entityType` as `'import_job' | 'bulk_job'` — it must widen to include
`'campaign'`. The column it writes is `notification.entity_type`, declared in
`001_initial.sql:77` as a bare nullable `text` with **no CHECK constraint** (and
none added by `021_notification_center.sql`, whose only CHECK is on
`action_state`). So this is a TypeScript-only widening with no migration.
Five `messageKey`s: `schedule.created`, `schedule.rescheduled`,
`schedule.cancelled`, `schedule.missed`, `schedule.blocked`. Severity `success`
for the first three, `critical` for the last two.

BR-SEC-003 applies: A16 asserts positively that no notification `body`/`params`
contains an SMTP host, port, credential, `secret_ref` or recipient custom value.

### 3.6 Web surface

`SendConfirmOverlay.tsx:20` currently states in its own docstring that
`"Hẹn giờ" remains omitted -- M5-S2 owns real scheduling`. This node makes it
real. Port the handoff's `scheduleSend` overlay (`action-overlays.tsx:142-149`:
`.schedule-send-form`, `.schedule-grid`, `.schedule-preview`,
`.variable-policy`), replacing its hardcoded `2026-08-11 / 08:30 /
Asia/Ho_Chi_Minh / "121 email; 7 người thiếu dữ liệu"` with real values:

- Zone list from `Intl.supportedValuesOf('timeZone')`, defaulting to
  `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- `.schedule-preview` shows the resolved instant rendered **in the chosen zone**
  plus the UTC instant — BR-GEN-003's UI half, and the only place a user can
  catch a zone mistake before it becomes a send.
- Real counts from `validateCampaignAudience`, exactly as `SendConfirmOverlay`
  already does.
- One `Idempotency-Key` per overlay mount in a `useRef` — the M4-S4 pattern at
  `SendConfirmOverlay.tsx:34`, for the same reason (a per-click key defeats the
  rule it is meant to satisfy).
- 422 `NONEXISTENT_LOCAL_TIME` / `AMBIGUOUS_LOCAL_TIME` / lead-time bodies render
  as human copy with the suggested or candidate times offered as one-click fixes,
  never as a raw problem body (A19).

`ComposeDraftScreen` gains a `scheduled` banner alongside M4-S4's frozen banner:
local time + zone, a countdown to the lock window, and "Đổi giờ" / "Hủy lịch".
Inside the lock window both actions disable themselves with the reason stated —
the client must not offer an action the server will 409 (A20).

---

## 4. HTTP surface

| Method | Path | operationId | Permission | Returns |
|--------|------|-------------|------------|---------|
| POST | `/campaigns/{campaignId}/schedule` | `scheduleCampaign` | `campaign:manage` | 202 `CampaignScheduleAccepted` |
| POST | `/campaigns/{campaignId}/schedule/cancel` | `cancelCampaignSchedule` | `campaign:manage` | 202 `CampaignScheduleAccepted` |

`POST /schedule` **gains `@UseGuards(CsrfGuard)`, tenant scoping and an actor** —
it has none today (`campaigns.controller.ts:67`), which was tolerable for a
handler returning a literal and is not for one that writes rows and enqueues
work. It also gains the required `Idempotency-Key` header, matching
`send`'s precedent at `campaigns.controller.ts:71-73`.

Schedule-cancel is a **separate route** from M4-S4's `POST /cancel` because the
two have different legal source states and different terminal states (§3.3,
DEC-091); overloading one route would make the 409 messages unreadable and hide
which rule refused.

New schemas, all additive:

```yaml
CampaignScheduleRequest:
  required: [localDateTime, timeZone]
  properties:
    localDateTime: {type: string, pattern: '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'}   # zone-less by design
    timeZone: {type: string}                                                     # IANA name
    offsetMinutes: {type: integer}                                               # only for AMBIGUOUS_LOCAL_TIME
CampaignScheduleAccepted:
  {campaignId, snapshotId, status, scheduledAtUtc, timeZone, offsetMinutes,
   lockedAt, totalSnapshot, sendableCount, skippedCount, idempotencyReplayed}
CampaignScheduleValidationReport:
  {blocking: boolean, sender, template, audience, variables}   # no quota -- DEC-088
```

`localDateTime` is deliberately **zone-less**. Accepting an ISO string with an
offset would let the client pre-resolve the ambiguity BR-SCH-003 exists to force
into the open, making A5 untestable through the real API. Record as DEC-093.

**Two OpenAPI corrections land in the same CP5 pass**, both from §0(c):
`CampaignProgress.status` gets `partial_failed` (not `partially_failed`) and the
full ten-plus-two status vocabulary. `openapi-compat-check` will flag the enum
rename as breaking; the written justification is that
`getCampaignProgress` is still `campaigns.service.ts`'s in-memory mock with no
implementation behind it and no client consuming `partially_failed` — the same
never-implemented argument M4-S3 §3.1 and M4-S4 §4 both already made in writing
rather than silently past the check.

---

## 5. Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | The preserved `023` branch merges later and its trigger silently overwrites §3.1's reconciled `campaign_no_edit_after_send()` — both are `CREATE OR REPLACE` on the same function, so **last migration applied wins**, and the loser fails no test until a reschedule is attempted | CP1 writes a test asserting the *reconciled* semantics (schedule columns writable on `draft→scheduled`, frozen after, clearable on cancel/missed) by behaviour, not by reading the function body. That test fails loudly if 023 lands on top without merging the carve-out — which is the only cheap moment anyone will notice |
| R2 | `Intl`-based zone resolution depends on the Node build's ICU. A `small-icu` build silently resolves every zone to UTC, which would make A2/A4/A5 pass vacuously in one environment and fail in another | CP2's first assertion is a guard: `Intl.DateTimeFormat('en', {timeZone: 'Europe/Berlin'})` must produce a genuinely different offset in January vs July. If it does not, the suite **fails with an explicit "full ICU required" message** rather than testing nothing. `.nvmrc` and the Dockerfile's Node base are both checked in CP2 and the requirement documented in `docs/deployment/environment-variables.md` |
| R3 | The dispatcher is a cross-tenant sweep. Getting its connection wrong re-opens exactly the bypass the standardization workstream closed with RLS | Reuses the existing narrow `OUTBOX_DATABASE_URL` boundary verbatim (§3.4) and re-enters `runInTenantTransaction` per campaign. CP4 includes a negative test proving the dispatcher's own connection cannot read a tenant's rows outside a tenant context |
| R4 | `freezeCampaignSnapshot` gains a parameter and is now called from two places. A regression here silently breaks M4-S4's five closed rules, and M4-GATE is already closed | CP2 re-runs M4-S4's existing `campaign-snapshot-freeze.test.ts` and `campaign-snapshot-immutability.test.ts` **unmodified**. If either needs editing to pass, that is a behaviour change requiring an explicit decision row, not a test edit |
| R5 | Time-dependent tests (lock window, misfire grace, DST) are the classic flake source, and this run has already paid for one flaky suite (D-33, then the P1 serialisation fix) | No `setTimeout`-based waiting and no reliance on wall-clock proximity: lead/lock/grace thresholds are injected config, and due-ness is created by **writing a past `scheduled_at_utc`**, not by waiting. DST tests use fixed historical instants, never `now()` |
| R6 | BullMQ delayed jobs survive a reschedule and fire against a stale version | Deterministic `jobId = schedule-{campaignId}-{version}` plus the §3.4 claim: a stale job matches zero rows because the claim's `status='scheduled'` guard already failed or the version moved. Proven by test, not by reasoning |
| R7 | This host currently cannot run the suite at all — no `node_modules` in the worktree, no PostgreSQL on 5432, Docker engine returning 500 (found 2026-08-17) | Resolve infrastructure **before CP1**, not at CP7. A node whose evidence cannot be produced must not start; if Docker cannot be restored, that is a genuine BLK-class blocker to record in `state.json`, not something to work around with unit tests standing in for integration ones |

---

## 6. Checkpoints

**CP0 — infrastructure.** Restore `pnpm install`, PostgreSQL and the Docker
engine (R7). Baseline: full `pnpm run check` green with its **test count and skip
count recorded** — the count is the baseline every later checkpoint is compared
against (AGENTS.md §2). Do not proceed on a red or uncounted baseline.

**CP1a — land the held-back `023` unit.** Merge branch
`migration-023-campaign-snapshot-hardening` and take **all four** items from
§0(a) together: the migration, the four immutability cases,
`migration-runner-behavior.test.ts`, and the two entity defaults. Apply `023` via
`docker compose run --rm migrate`, add its lock entry, and run the **full**
`apps/api` suite — this is the first time any of `023` has ever executed, and
M4-S4's five closed rules are what it can break. Any red here is a genuine
finding about `023`, to be resolved explicitly, not by dropping the test.

**CP1b — migration 024, RED first.** Write failing tests first: status CHECK
admits `missed`/`blocked`; `campaign_schedule_complete` rejects a half-set
schedule; the reconciled trigger allows setting schedule columns on
`draft→scheduled`, raises `55000` on an in-place change while `scheduled`, and
**allows** clearing them on `scheduled→cancelled`/`missed` (the §3.1 carve-out,
and R1's canary — this last one fails against `023`'s trigger, which is the point:
it proves `024` won the `CREATE OR REPLACE` ordering). Then write
`024_campaign_schedule.sql`, apply, add the lock entry, re-run `ARCH-MIGRATION`
standalone. Closes A-level DB behaviour only.

**CP2 — `schedule-time.ts` + freeze parameterisation, RED first.** Unit tests for
`resolveLocalSchedule` across `Asia/Ho_Chi_Minh` (no DST), `Europe/Berlin` (both
transitions), `Australia/Lord_Howe` (30-minute DST shift) and `UTC`, opening with
R2's ICU guard. Then parameterise `freezeCampaignSnapshot` and re-run M4-S4's two
snapshot suites **unmodified** (R4). A2/A4/A5.

**CP3 — HTTP schedule + reschedule + cancel.** `scheduleCampaign`,
`cancelCampaignSchedule`, `CsrfGuard`, permissions, `IdempotencyService` wiring,
the new `config/env.ts` entries. A1/A3/A6/A7/A8/A9/A14/A17/A18 against real
infrastructure, A17's concurrency case genuinely concurrent.

**CP4 — dispatcher.** Replace `worker/main.ts`'s `campaign-misfire-scan` stub
with the real scan + claim; add the delayed-job accelerator at schedule time.
A10/A11/A12/A13/A15/A16, plus R3's cross-tenant negative and R6's stale-job case.
This is the checkpoint that closes BR-SCH-006/007/009.

**CP5 — contracts.** OpenAPI additions per §4 **plus the two `CampaignProgress`
corrections from §0(c)**, `openapi-compat-check` with the enum-rename
justification written out, `redocly bundle`, `pnpm contracts:generate`
(never hand-edit `packages/contracts/src/openapi.d.ts`). Confirm
`schedule.state_changed` needs no AsyncAPI change (it already exists).

**CP6 — web.** `scheduleSend` overlay ported and wired; compose `scheduled`
banner; `apps/web/src/api/campaigns.ts` gains `scheduleCampaign` /
`cancelCampaignSchedule`. A19/A20 e2e specs added to
`apps/web/e2e/visual-capture.spec.ts` following the existing M4-S3/M4-S4 helper
pattern.

**CP7 — VISUAL EVIDENCE + close.** Capture 3 viewports × the states this node
adds (schedule form idle / submitting / DST-error / lead-time-error, compose
scheduled banner, locked-window disabled state) into
`evidence/visual/M5-S2-schedule/production/`. **Individually inspect every
image** — a green Playwright run is not evidence (D-78, and M4-S4 CP7 found two
real defects this way that the passing suite did not). Then close BR-SCH-001…010
and BR-GEN-003 in `traceability.csv` with real `code_paths` / `test_files` /
`migration_files` / `openapi_operation_ids` / `log_or_metric_or_audit`; update
`screen-catalog.yaml` + `ui-inventory.yaml` for `scheduleSend`; record
DEC-088…095 in EXECPLAN §20, D-80…86 in §19, and migration 024 in §10; re-run the
full suite with **counts compared to CP0's baseline**, plus
`openapi-compat-check`, `redocly bundle`, `validate_plan.py` and `ARCH-MIGRATION`
standalone; only then flip `M5-S2-schedule` to `completed`.

> `M5-S3-send` becomes `ready` on that flip. It inherits two debts named here and
> must not be planned without them: **BR-CFG-004/005 remain `partially_closed`**
> (D-75/DEC-074 — the worker/send-path half was deferred to M5-S3, and zero
> references to `sending_policy`/`SendingPolicy`/`defaultSenderConfigId` exist in
> `apps/worker` today), and **nothing consumes `queued`** until M5-S3 builds the
> dispatch DAG. `M5-GATE` additionally needs `BR-CFG-002`, which no open slice
> currently claims.
