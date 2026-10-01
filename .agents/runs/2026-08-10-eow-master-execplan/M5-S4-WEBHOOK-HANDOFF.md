# Handoff — M5-S3-send fully closed; start M5-S4-webhook-reconciliation next

Written 2026-08-18, end of a session that executed the entire `M5-S3-send`
node (plan → CP0 through CP8 → evidence review → close) in one continuous
run, following one mid-session context compaction. Everything from this
session is committed. Nothing is in-progress or uncommitted.

## Where to work

Checkout: `C:\Works\Projects\Email operations workspace\email-operations-workspace`,
branch `main`, HEAD `8198740` (`M5-S3 CP8: web surface + visual evidence
review, close M5-S3-send`). Not pushed to `origin` — this session never
pushes without separate, explicit per-instance confirmation (unchanged
discipline from prior handoffs). Docker stack is in its normal state:
`postgres`/`redis`/`mailpit`/`api`/`web`/`worker`/`scheduler` all up via
`docker compose up -d` (this session had stopped `api`/`web`/`worker`/
`scheduler` for the run's duration for CPU-contention reasons — see below —
and restarted them all before finishing).

## What this session completed (all committed, nothing pending)

`M5-S3-send`: the persisted send pipeline (validate → freeze → partition →
send → aggregate). Migration `026_campaign_execution.sql`. Real DAG in
`apps/worker/src/campaign-send/` replacing five fabricated-success stubs.
Rate limiting (Redis minute-buckets + Postgres daily ceiling), crash
recovery (stale-claim sweep), suppression on hard bounce, deterministic
content hash and Message-ID. `getCampaignProgress`/`cancelCampaignSend`
HTTP surface. Compose-screen sending/completed/partial_failed/failed
banners + stop-send confirmation, 15 visual-evidence screenshots
individually inspected. `BR-SEND-001/002/006/007/010/011/012` closed (or
`partially_closed` where a named test case is explicitly a later node's —
see `traceability.csv`); `BR-CFG-004/005` flipped to `closed`. Full detail
is in `EXECPLAN.md` §18's "M5-S3-send — what changed" subsection, §19's
D-87 through D-104, and §20's DEC-096 through DEC-106 — read those before
this handoff's summary if you need the actual reasoning, this file is a
pointer, not the source of truth.

Final verification: `pnpm run check` clean, 116 test files / 693 tests / 0
skipped / 0 failed (was 103/610/0/0 at this node's own CP0 baseline).

## Non-obvious environmental notes (carry these forward — found the hard way this session)

1. **Host-run vs docker-composed, and why.** Running the full `docker
   compose` app stack (`api`/`web`/`worker`/`scheduler`) *alongside*
   `vitest`'s own parallel test execution causes real `beforeAll` timeout
   flakes from CPU contention (this session's own D-93). If a node's test
   suite is large, consider `docker compose stop api web worker scheduler`
   (keep `postgres`/`redis`/`mailpit` — tests need those) for the duration
   of heavy test-writing, and run the API/web processes host-side only when
   you actually need a live browser/e2e check: compiled API via
   `node apps/api/dist/main.js` with explicit env vars (`DATABASE_URL`,
   `REDIS_URL`, `SESSION_SECRET`, `WEB_ORIGIN`, `SMTP_HOST=127.0.0.1`,
   `SMTP_PORT=1025`, `API_PORT=3000` — pull real values from `.env`), and
   Vite via `npx vite --port 5173` in `apps/web`. **Always rebuild
   `apps/api` (`pnpm --filter @eow/api run build`) before starting the
   host-run compiled API** if you've touched its source since the last
   build — a stale `dist/` silently serves old routes (this was D-50 in an
   earlier node, still true). **Restore the docker stack
   (`docker compose up -d api web worker scheduler`) before ending your own
   session** — this session did, don't leave it stopped for the next one.
2. **`http://localhost:5173`, never `127.0.0.1:5173`.** Vite's dev server
   binds IPv6-only by default on this host; the loopback IPv4 form will not
   connect from the Browser tool.
3. **Seed fixtures for states no HTTP endpoint can produce must run
   out-of-process, against compiled or `tsx`-imported source, never through
   a live NestJS app.** This session's own example:
   `apps/worker/scripts/seed-campaign-send-fixture.mjs` — `apps/worker` has
   no NestJS/TypeORM decorators, so it can `tsx`-import
   `../src/campaign-send/{validate,partition,send,aggregate}.ts` directly.
   If a future fixture needs `apps/api` internals instead, decorator
   metadata means you need the compiled `dist/`, not a raw `tsx` import —
   see `apps/api/scripts/seed-demo-user.mjs` for that pattern.
4. **`ALTER TABLE ... DISABLE/ENABLE TRIGGER` inside test cleanup is *not*
   connection-scoped if issued via separate `pool.query()` calls** — each
   call can round-robin to a different physical connection, silently
   defeating an advisory lock meant to serialize it. If you add a new test
   file that needs to disable an immutability trigger for fixture cleanup,
   use `apps/worker/src/test-cleanup-helpers.ts`'s `purgeCampaignSendFixtures()`
   pattern (one checked-out client, one real transaction) rather than
   copying the older `pool.query()`-per-statement style — this session hit
   a real, reproducible bug from exactly that copy (D-98).
5. **RLS is opt-in per query, not per connection** — any query against a
   tenant-owned table must run inside `runInTenantContext`/
   `runInTenantTransaction`, including fallback/read-path queries that feel
   incidental. This session found a real instance
   (`apps/worker/src/campaign-send/run.ts`'s `currentExecutionId` fallback,
   D-95) where a forgotten wrapper silently returned zero rows under
   `FORCE ROW LEVEL SECURITY` instead of erroring — easy to miss because it
   fails silent, not loud.
6. **A secret written by `apps/api`'s `EnvSecretStore` is invisible to
   `apps/worker`** — it's a per-process in-memory `Map` with a
   `process.env` fallback, and the two are separate OS processes. If
   `M5-S4`'s webhook route needs to verify a provider-signed payload against
   a stored secret, the same cross-process boundary applies: the worker
   (which will presumably ingest the webhook, or the API, whichever owns
   the route) can only resolve a secret from its own `process.env`, not
   from whatever the other process holds in memory (D-91, DEC-100).
7. **`packages/architecture-tests`' `ARCH-CSV-SHAPE` test enforces field
   count on every row of `traceability.csv`** — any edit that adds a
   sentence containing a literal comma to a cell must wrap that cell in
   double quotes, or the row's field count silently shifts and the test
   fails with a specific row/line number (this session tripped this
   exact fitness function while closing out its own rows — an easy, fast
   fix once you see the error, but confirm your traceability edits pass
   `npx vitest run src/csv-shape.test.ts` from
   `packages/architecture-tests` before trusting a full-suite green).
8. **A green Playwright run is not evidence** (D-78's standing discipline,
   reconfirmed this session as D-104): this session's own e2e screenshots
   initially missed an async-fetch race (counts tiles empty at shutter
   time) that only surfaced from individually opening every captured image.
   Budget time for this on any node that captures visual evidence — it is
   not optional per `AGENTS.md`.

## Next: M5-S4-webhook-reconciliation (not started — this is the actual next task)

`state.json` status: `M5-S4-webhook-reconciliation`'s only dependency,
`M5-S3-send`, is `completed`. Fresh check just run:
```
M5-S2-schedule                -> completed
M5-S3-send                    -> completed   <- just closed this session
M5-S4-webhook-reconciliation  -> pending      <- next
M5-GATE                       -> pending      <- gated on M5-S4
M6-S1-realtime-progress       -> pending
```
`state.json`'s own node entry for `M5-S4-webhook-reconciliation`:
```json
"successConditions": [
  "Signature-verified provider callbacks update canonical delivery state",
  "Replaying an event changes nothing; out-of-order events do not regress state",
  "Signature forgery is rejected and tested",
  "BR-SEND-008 closed"
]
```

### Scope (rules this node owns, per `traceability.csv` and this session's own DEC-096/105)

- **`BR-SEND-008`** (P0, `not_started`): "Webhook trùng không tăng count;
  chữ ký sai trả 401/400 và không ghi state." (a duplicate webhook must not
  inflate any count; a bad signature must return 401/400 and write no
  state). Test cases `TC-SEND-008`, `TC-SEND-014`. This is the **only**
  `BR-SEND-*` rule this node needs to close per `state.json`'s own
  `successConditions` — re-confirm against `traceability.csv` directly
  before scoping anything else in or out.
- `delivered`/`bounced` message states exist in the vocabulary already
  (`send-state-machine.ts`, `026`'s CHECK constraints) but are legal and
  currently **unreached** — this node is what reaches them (DEC-096
  recorded this boundary explicitly when M5-S3 declined to build it).
- `suppressRecipient`-shaped logic (hard-bounce → `recipient.suppressed_at`/
  `suppression_reason`/audit row, all in one transaction) already exists,
  but **only inline**, inside `apps/worker/src/campaign-send/send.ts`'s
  `recordFailure` function (around line 345) — it was **not** extracted
  into a standalone, importable function the way the M5-S3 plan document
  (`M5-S3-SEND-PLAN.md` §3.7) said it would be. DEC-105 commits this node
  to reusing that mechanism rather than growing a second suppression path,
  so the first real decision here is *how*: extract `send.ts`'s inline SQL
  into a shared function both callers (the send path and the new webhook
  path) can call, or duplicate the four-statement transaction verbatim the
  same way `retry-backoff.ts` is duplicated between `apps/api` and
  `apps/worker` (DEC-106's precedent) — plan this explicitly rather than
  discovering the gap mid-checkpoint.
- `apps/api/src/sender-config/provider-adapter.ts` already declares
  `parseWebhookEvent(payload: unknown): ProviderWebhookEvent` on the
  `EmailProviderAdapter` interface; `SmtpProviderAdapter`'s implementation
  (`smtp-provider.adapter.ts:19`) is a **trivial passthrough stub**
  (`{ type: 'unknown', ...payload }`) with no signature verification, no
  real event-type mapping, and is not wired to any HTTP route or worker
  consumer yet. This is this node's to make real.
- No webhook signing-secret column exists anywhere in the schema yet (`020`
  through `026` — checked). Next free migration number is **`027`**. ADR-014
  ("Provider adapter plus canonical internal message/delivery states; verify
  signed webhooks and deduplicate events") is the accepted architectural
  basis — read it in full before designing the signature-verification
  mechanism.
- `EXECPLAN.md` §10's migration table has a placeholder row:
  `*_delivery_events.sql` → `delivery_events` with
  `UNIQUE (provider, provider_event_id)` — a starting sketch, not a locked
  design; re-derive the real shape from `BR-SEND-008`'s acceptance text and
  this node's own `successConditions` (out-of-order events must not
  regress state, which the placeholder's uniqueness alone does not
  guarantee — you'll likely need an ordering/version column too).

### Before writing any code

1. Use the `superpowers:writing-plans` skill to draft
   `M5-S4-WEBHOOK-PLAN.md` in `.agents/runs/2026-08-10-eow-master-execplan/`,
   same shape as `M5-S3-SEND-PLAN.md` (read it in full first — it is the
   most recent, most directly relevant sibling plan, including its own §0
   pre-registered-findings pattern, its acceptance-criteria table shape,
   and its non-goals discipline).
2. Re-confirm `BR-SEND-008`'s exact acceptance text and test-case IDs
   directly from `traceability.csv`, not from this handoff's paraphrase.
3. Decide the `suppressRecipient` extraction question above explicitly, in
   the plan, before CP0.
4. TDD RED-first for every checkpoint, per this run's established
   discipline (see `M5-S3-SEND-PLAN.md`'s own checkpoints, or any completed
   node's `evidence` array in `state.json`, for the shape).

## Working discipline (unchanged, carried forward from prior handoffs)

- Evidence before status — never flip `closed`/`completed` before the
  artifact justifying it exists and has been re-run.
- Individually inspect every visual-evidence image a node produces — do
  not trust a green Playwright run alone (D-78, reconfirmed as D-104 this
  session).
- Real bugs found during TDD get fixed at the root cause and disclosed
  (`D-*`/`DEC-*`), not silently worked around or left for later.
- Run `packages/architecture-tests`' full suite (not just the file you
  think you touched) before trusting a full-workspace check green —
  fitness functions like `ARCH-CSV-SHAPE`/`ARCH-TEST-HYGIENE` catch
  mistakes in files you didn't expect to break.
- Push/merge-commit actions require separate, explicit per-instance user
  confirmation — do not treat one approval as blanket authorization for
  future pushes/commits.
