# Handoff — M5-GATE closed; M6-S1-realtime-progress is next

Written 2026-08-18, end of a session that ran the entire `M5-GATE`
evaluation to completion (traceability re-verification, a real BR-CFG-002
implementation slice, a test-coverage-gap closure, and full evidence
assembly for all four success conditions) in one continuous run, then
pushed to `origin/main`. Nothing is in-progress or uncommitted.

This document is a **handoff for a fresh session** (recommended: switch to
Opus for the planning work) — not a continuation of the current one. It
gives you the state and the pointers; it deliberately does not re-derive
content that already lives in `state.json`, `traceability.csv` or
`EXECPLAN.md` — read those directly.

## Where to work

Checkout: `C:\Works\Projects\Email operations workspace\email-operations-workspace`,
branch `main`, HEAD `6deba0c` (`M5-GATE: completed (25 M5 rules -- 23
closed/2 partially_closed by design)`). **Pushed to `origin/main`** this
session (`1a7f5d9..6deba0c`, 53 commits) — this is the first push of this
entire run; every prior node stayed local-only until now. Docker stack is
up and healthy: `postgres`/`redis`/`mailpit`/`api`/`web`/`worker`/
`scheduler` all via `docker compose ps` (confirmed healthy at the end of
this session, 2h uptime on the app containers).

## Mandatory read order (per `AGENTS.md` §1 — do not skip)

1. `AGENTS.md` — the protocol itself.
2. `.agents/runs/2026-08-10-eow-master-execplan/state.json` — the
   `M6-S1-realtime-progress` node's own entry (`dependsOn`,
   `successConditions`, currently empty `evidence`) and `M5-GATE`'s just-
   completed entry (11 evidence items) for the foundation it closed.
3. `.agents/runs/2026-08-10-eow-master-execplan/traceability.csv` — the
   authority on rule status. `BR-SEND-003/004/005`, `BR-HIS-002/008` are
   this node's own rules; read their rows directly (`not_started`
   currently — M6 as a whole is 16 closed / 12 not_started, all 12 being
   the M6-S1/M6-S3 rules not yet touched).
4. `.agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md` §19/§20 for
   any `D-*`/`DEC-*` you need context on — `DEC-004` (Socket.IO per
   ADR-009, no SSE) governs this node's transport choice; `D-03` (the
   original `campaign.progress.updated` vs `campaign.progress` contract
   drift finding) — re-verify it's actually fixed before assuming so, see
   below.
5. `contracts/asyncapi.yaml` — `campaign_progress` (`campaign.progress`)
   and `campaign_execution_state_changed` (`campaign.execution_state_changed`)
   channels are already declared. The latter's own inline comment says
   *"No code subscribes to or publishes this channel yet"* — still true as
   of this handoff.

## What this session completed (all committed, nothing pending)

Closed `M5-GATE`: re-verified `traceability.csv` directly (25 M5 rules,
not the stale 24 the gate's own condition text said), found and closed two
real gaps neither present in the prior handoff (`BR-CFG-002` was
`not_started` — a full TDD implementation slice across `apps/api`,
`apps/worker`, `apps/web`; `BR-CFG-003`/`BR-CFG-007` were `closed` on a
one-time manual check with no automated test), verified all four of the
gate's own success conditions with real re-run evidence (a live
`docker compose run --rm migrate` for migration idempotency, a live probe
against the running stack's real containers for the no-secret-leak
condition), and pushed. Full detail is in `state.json`'s own `M5-GATE`
node entry — 11 evidence items, don't re-derive them here.

**Final workspace baseline this handoff is written against: 124 test
files / 789 tests / 0 skipped / 0 failed** (`pnpm run check`). Two
pre-existing, unrelated flakes were observed and isolated during this
session (`campaign-execution-db.test.ts`, `run.integration.test.ts`) —
both confirmed passing standalone, both matching the already-disclosed
D-93/D-94 flake class (unrelated Docker workloads on this shared host
competing for resources). Expect the same class of flake here; isolate
before calling anything a regression.

## Next: `M6-S1-realtime-progress` (not started — this is the actual next task)

`state.json`'s own node entry:
```json
"dependsOn": ["M5-GATE"],
"successConditions": [
  "Counters are monotonic and computed from campaign_recipient facts",
  "campaign.progress is throttled to at most 1/s or 250 recipients and is tenant-authorised per room",
  "apps/web listens for campaign.progress, not campaign.progress.updated (DRIFT-01 fixed)",
  "Reconnecting state is visible; REST reconciliation fills gaps; rt.resync_required is honoured",
  "eow_progress_reconcile_drift is 0 at completion",
  "BR-SEND-003, BR-SEND-004, BR-SEND-005, BR-HIS-002, BR-HIS-008 closed"
]
```

Read the five rules' full acceptance text directly from `catalog/ba-rules.json`
before planning — do not plan from the one-line summary above.

### What already exists (read before designing anything — avoid rebuilding)

- **`apps/api/src/realtime/realtime.gateway.ts`** — a working Socket.IO
  gateway (`/realtime` namespace) built by `M2-S4-import-bulk`, currently
  scoped to import/bulk job progress only. `handleConnection` authorizes
  `job:{jobId}` room joins by validating the session cookie, checking
  `recipient:read`, then confirming the job actually belongs to the
  caller's tenant — this whole pattern (auth → permission → tenant-
  ownership check → room join) is the template for a new `campaign:{id}`
  room; it is not a new mechanism to invent. It also already emits
  `rt.connection.ready` on connect with a `resume: true` data flag, and
  subscribes to Redis pattern `eow:job:*`, relaying `pmessage` payloads to
  the matching Socket.IO room under the payload's own `event_type`.
- **`apps/api/src/realtime/realtime-job-rooms.ts`** — the `requestedJobIds`
  auth-payload parser (caps at 50 ids, dedupes). A `requestedCampaignIds`
  sibling (likely just one campaign per subscription, not a batch) is the
  probable shape for the new room type.
- **`apps/worker/src/redis-job-event-publisher.ts`** — the only existing
  Redis publisher (`eow:job:{jobId}` channel, `connection.publish(...)`
  with a JSON-serialized event envelope). This is the pattern a new
  campaign-progress publisher follows — there is currently **no**
  equivalent publisher for `campaign.progress` or
  `campaign.execution_state_changed`; nothing writes to any
  `eow:campaign:*` channel today.
- **`apps/web/src/api/realtime.ts`** — the client-side `socket.io-client`
  instance (9 lines) plus `subscribeToJobs(jobIds)`. No campaign-progress
  subscription function exists yet.
- **`apps/web/src/screens/compose/ComposeDraftScreen.tsx`**'s
  `SendingBanner` component — **currently pure 3-second REST polling**
  (`window.setInterval(() => void load(), 3000)` calling
  `getCampaignProgress`), zero socket involvement. This is exactly the
  polling-fallback half of BR-SEND-004's own acceptance text
  ("SSE/WebSocket... polling fallback") already built; the realtime half
  is this node's job to add *alongside* it, not replace it.
- **`apps/api` already has a real, tested `getCampaignProgress`** (closed
  under `BR-SEND-002`, M5-S3/S4) computing real per-status counts from
  `campaign_recipient` with monotonic `sent`/`delivered`/`failed` rollups
  (D-105, M5-S4's own fix). This is very likely the same computation this
  node's `campaign.progress` payload and its "counters are monotonic"
  success condition should reuse, not reimplement.
- **D-03's original finding** (`apps/web` subscribing to the wrong event
  name, `campaign.progress.updated` vs the contract's `campaign.progress`)
  — grepped clean for `campaign.progress.updated` across `apps/web/src`
  this session; the string is not present. Either it was already fixed by
  a prior node as a side effect, or the subscribing code was removed
  entirely (plausible — no campaign-progress socket subscription exists
  at all right now, per the point above). **Confirm which, don't assume
  DRIFT-01 is free** — the gate's own condition still names it explicitly.
- **`eow_progress_reconcile_drift`** does not exist anywhere in code —
  grepped clean outside of the three planning documents that name it as a
  target. `BR-HIS-008`'s reconciliation job and this metric are both to be
  built from nothing.
- **`apps/worker/src/outbox-relay.ts`** exists but is BullMQ-specific
  (import/bulk job dispatch), a different mechanism from the Redis-pub/
  sub realtime relay above — don't confuse the two "relay" concepts when
  reading worker code.

### Design questions this node's plan needs to answer (not yet decided)

1. **Publish path**: does `campaign.progress` get published on every
   `campaign_recipient` status transition (high frequency, needs the
   throttle the gate's own condition already names — 1/s or 250
   recipients), computed and thrown away between throttle windows, or
   does something batch/debounce inside the worker's own send loop
   (`apps/worker/src/campaign-send/send.ts`, `aggregate.ts`) before ever
   touching Redis? The throttle requirement suggests the latter is
   cheaper, but verify against `send.ts`'s own batch-completion points
   before assuming a design.
2. **Room granularity and authorization**: one `campaign:{id}` room,
   authorized the same way `job:{jobId}` is (session → permission →
   tenant-ownership query) — `campaign:manage` or `campaign:read`
   permission, tenant-scoped `SELECT 1 FROM campaign WHERE id = $1 AND
   tenant_id = $2` is the direct analogue of the existing job-ownership
   query in the gateway.
3. **Reconciliation job's own shape**: a scheduled worker job (there is
   already a `scheduler` container/service — check
   `apps/worker/src/campaign-dispatcher.ts` and whatever registers it for
   the established pattern) that recomputes `campaign_recipient`-derived
   counts, compares to whatever was last broadcast, and emits the drift as
   a metric — needs its own storage/comparison mechanism designed, since
   nothing today remembers "what was last broadcast" anywhere.
4. **`rt.resync_required`**: the channel exists in `asyncapi.yaml`
   already (`rt_resync_required`) but nothing currently emits it or
   listens for it client-side — confirm this by grepping before assuming
   either direction is built.

## Non-obvious environmental notes (carry forward — established over many sessions)

- Host-run tests vs. docker-composed containers is a real split — see any
  prior `*-HANDOFF.md` in this directory for the full detail (not
  repeated here to avoid the fourth copy of the same paragraph). The short
  version: integration tests run host-side against the same Postgres/
  Redis the docker containers use (same `eow` database, ports 55432/56379
  via `.env`'s `EOW_POSTGRES_BIND`/`PORT`), while `api`/`web`/`worker`/
  `scheduler` run containerized. A live probe against the running stack
  (as this session did for the SMTP-secret-leak condition) goes through
  `http://localhost:8080/api/v1/...` (the `web` container's Nginx proxy),
  not a direct port on `api` (not published to the host).
- **This host runs unrelated Docker workloads alongside this repo's own
  stack** (`pgadmin4_container`, `postgres_container`, `redis`,
  `phpmyadmin`, `mariadb` — confirmed present again this session, 18-19h
  uptime, unrelated to this project). Budget for `pnpm run check` flakes;
  isolate via standalone re-run before calling anything a regression, per
  the discipline every prior handoff in this directory has already
  established.
- **This live database has ~1446 pre-existing tenant rows** — accumulated
  test debris from many prior sessions' integration test runs sharing the
  same `eow` database. `audit_log` is immutable (`BR-SEC-002` trigger, no
  `DELETE` permitted ever), so any test/probe tenant with an audit_log row
  cannot be fully deleted — this is expected, harmless, and already the
  established norm; don't attempt to "clean up" the whole table.
- `PROVIDER_WEBHOOK_SECRET` and other genuinely-optional secret-like env
  vars need `''` -> `undefined` Zod preprocessing from the start (D-111) —
  relevant if this node adds any new optional realtime-auth secret.

## Working discipline (unchanged, carried forward from every prior node)

- Evidence before status — never flip `closed`/`completed` before the
  artifact justifying it exists and has been re-run.
- Compare the workspace check's test *and skip* count against the
  previous node's own baseline (124/789/0/0 as of this handoff), not just
  its exit code.
- Real bugs found during work get fixed at the root cause and disclosed
  (`D-*`/`DEC-*`), not silently worked around.
- Commit at every checkpoint, one commit per logical step, per AGENTS.md
  §2 — this session's own M5-GATE work is 9 commits, not one giant one, by
  design.
- Push/merge-commit actions require separate, explicit per-instance user
  confirmation — this session pushed only after the user explicitly said
  so in chat; one approval does not cover a future push.

## Suggested skills for the next session

- **`superpowers:brainstorming`** — before writing a plan, this node has
  real open design questions (see above) that a spec/plan shouldn't paper
  over with an assumed answer. Worth a short exploration pass first,
  especially on the publish-path and reconciliation-job design questions.
- **`superpowers:writing-plans`** — once the design questions above are
  resolved, write `M6-S1-REALTIME-PROGRESS-PLAN.md` the same way every
  prior `M*-S*-PLAN.md` in this directory was written: TDD task-by-task,
  RED before GREEN, one commit per task.
- **`superpowers:test-driven-development`** — this node touches a
  Socket.IO gateway, a Redis publisher and a scheduled reconciliation
  job — none of which are naturally covered by a request/response
  integration test the way most of this codebase's prior work has been;
  plan the test strategy for asynchronous/realtime behavior deliberately,
  not as an afterthought.
- **`superpowers:systematic-debugging`** — for triaging whether D-03
  (`campaign.progress.updated`) is genuinely already fixed or whether the
  subscribing code was simply deleted along the way, before either
  closing it silently or re-fixing something already fixed.
- **`superpowers:verification-before-completion`** — before flipping this
  node to `completed`, since `M6-S3-history-recovery` and eventually
  `M6-GATE` depend on it.
