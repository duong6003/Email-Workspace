# Handoff — M5-S4-webhook-reconciliation closed; M5-GATE is next

Written 2026-08-18, end of a session that executed the entire
`M5-S4-webhook-reconciliation` node (plan → CP0 through CP7 → close) in one
continuous run. Everything is committed. Nothing is in-progress or
uncommitted.

## Where to work

Checkout: `C:\Works\Projects\Email operations workspace\email-operations-workspace`,
branch `main`, HEAD `be31c4d` (`M5-S4-webhook-reconciliation: completed
(122 files/772 tests/0 skip)`). Not pushed to `origin` — this run never
pushes without separate, explicit per-instance confirmation. Docker stack
is up and healthy: `postgres`/`redis`/`mailpit`/`api`/`web`/`worker`/
`scheduler` all via `docker compose up -d` (confirmed healthy at the end
of this session).

## Mandatory read order (per `AGENTS.md` §1 — do not skip)

1. `AGENTS.md` — the protocol itself.
2. `.agents/runs/2026-08-10-eow-master-execplan/state.json` — the `M5-GATE`
   node's own entry (`dependsOn`, `successConditions`, currently empty
   `evidence`) and `M5-S4-webhook-reconciliation`'s completed entry for
   what it verified.
3. `.agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md` §19/§20 —
   `D-105`…`D-111` and `DEC-107`…`DEC-114` are this session's own findings,
   already written up in full there; do not re-derive them.
4. `.agents/runs/2026-08-10-eow-master-execplan/traceability.csv` — the
   actual authority on which M5 rules are closed. Read directly; the
   summary below is a pointer, not a substitute.
5. `git log 7fce921..be31c4d` for the full M5-S3-send + M5-S4-webhook-
   reconciliation history if you need to see how a specific piece landed,
   commit-by-commit (each commit body is detailed evidence in itself).

## What this session completed (all committed, nothing pending)

`M5-S4-webhook-reconciliation`: the inbound provider webhook (BR-SEND-008).
Migration `027_delivery_events.sql`. Real HMAC signature verification
(`apps/api/src/webhooks/webhook-signature.ts`), a pure decision function
for the event-type × message-status apply rule
(`apps/api/src/webhooks/apply-decision.ts`), the full verify→parse→
resolve→apply algorithm in `webhooks.service.ts`, `suppressRecipient()`
extracted and given a second (webhook) caller. `BR-SEND-008` closed;
`BR-SEND-002` flipped `partially_closed`→`closed`; `BR-CFG-005`'s
exclusion retired; `BR-SEND-011` gained its second-caller evidence.

Two mid-session design corrections, both found and fixed before shipping
(full detail in `EXECPLAN.md` D-109/D-110, not repeated here):
- **D-109**: the original plan called for route-scoped `express.raw()`
  middleware to capture the raw webhook body. This would have silently
  broken in production (the global JSON body parser drains the request
  stream first). Replaced with NestJS's built-in `rawBody: true` app
  option before any code shipped.
- **D-110**: the apply algorithm's decision table checked transition
  *legality* before *staleness*, which made the "out-of-order event is
  ignored" outcome structurally unreachable (found while writing that
  test, before committing). Reordered; both a decision-table unit test and
  an HTTP integration test now cover the corrected order.

Final verification: `pnpm run check` clean, **122 test files / 772 tests /
0 skipped / 0 failed** (was 116/693 at this node's own CP0 baseline).

## Non-obvious environmental notes (carry forward — found the hard way)

Everything from the prior `M5-S4-WEBHOOK-HANDOFF.md` (host-run vs.
docker-composed split, `localhost:5173` not `127.0.0.1`, out-of-process
fixture pattern, RLS-per-query, cleanup-transaction pattern, ARCH-CSV-SHAPE
quoting) still applies and is not repeated here. New this session:

1. **This host runs unrelated Docker workloads alongside this repo's own
   stack** (`docker ps -a` showed `pgadmin4_container`, `postgres_container`,
   `redis`, `phpmyadmin`, `mariadb` — all unrelated to this project, all
   up for 16h+). This is the most likely cause of an unusually high flake
   rate this session: reaching one clean `pnpm run check` at CP7 took
   **five full attempts**, each failing attempt hitting a *different* file
   this session never touched (`run.integration.test.ts` three separate
   ways — timeout, deadlock, FK violation, all matching M5-S3's own
   already-disclosed D-93 class; `campaign-snapshot-post-freeze.test.ts`;
   `auth-http.test.ts`'s own audit-timing race, matching M5-S3 CP2's
   already-disclosed flake for that exact test). Every single one was
   isolated via standalone re-run and confirmed passing before being
   called a flake, never assumed. **Do not touch those unrelated
   containers** — out of scope, likely someone else's active work on this
   shared host. Just budget for more `pnpm run check` retries than usual.
2. **`${VAR:-}` in `compose.yaml` produces an empty string, not an absent
   key, when `.env` doesn't set it.** `EOW_PROVIDER_WEBHOOK_SECRET` being
   unset made the `api` container crash-loop until this was caught (D-111)
   — Zod's `.optional()` does not cover an empty string, only `undefined`.
   If a future node adds another genuinely-optional secret-like env var
   with a blank default, preprocess `''` → `undefined` in its Zod schema
   from the start, or repeat this exact bug.
3. **The webhook route can be exercised for real, end-to-end, from a seed
   script** — `apps/worker/scripts/seed-campaign-webhook-fixture.mjs`
   signs and POSTs real HTTP requests to a running API's own
   `/api/v1/webhooks/providers/smtp`, using `PROVIDER_WEBHOOK_SECRET` from
   its environment. This is more realistic evidence than a raw DB
   `UPDATE` and is the new pattern for reaching `delivered`/`bounced`
   states in any future e2e/visual work — reuse it rather than inventing a
   third way to fake those states.
4. **Killing background dev-server processes on Windows**: `netstat -ano |
   grep ":<port>"` finds the PID, `tasklist //FI "PID eq <pid>"` identifies
   it before touching anything (a leftover Vite on 5173 from an earlier
   session was found and correctly *reused*, not killed, this way — check
   before assuming a port conflict means "kill it").

## Next: M5-GATE (not started — this is the actual next task)

`state.json`'s own node entry for `M5-GATE`:
```json
"dependsOn": ["M5-S1-sender-config", "M5-S2-schedule", "M5-S3-send", "M5-S4-webhook-reconciliation"],
"successConditions": [
  "All 24 M5 rules closed",
  "TC-SCH-*, TC-CFG-* and the TC-SEND-* send subset mapped and executing",
  "Migrations 011-013 apply forward and idempotently",
  "No SMTP credential appears in any log, metric, trace or API response"
]
```
All four dependencies are now `completed`. **This does not mean the gate
will pass cleanly** — re-confirmed directly against `traceability.csv`
just now, not inferred:

- `traceability.csv` currently has **25** M5 rules, not 24 (the success
  condition's own number is stale or was an estimate at planning time —
  re-verify this discrepancy first, don't just proceed past it).
- Of those 25: **20 closed, 4 `partially_closed`, 1 `not_started`.**
  - `BR-CFG-002` (`not_started`, P0): "Campaign validation chặn sender
    pending/failed/disabled." Explicitly unowned by any M5 sub-node —
    M5-S1's own evidence cell says it's out of scope ("acceptance text is
    campaign-send-time validation, which is M5-S3 scope"), but M5-S3's own
    plan/handoff never claimed it either. **This is a real gap, not a
    documentation lag** — M5-S3-send's own handoff flagged this exact gap
    and it was never picked up.
  - `BR-SCH-004`, `BR-SCH-007` (M5-S2's own partial closures — schedule
    validation report / history delay display).
  - `BR-SEND-006`, `BR-SEND-007` (M5-S3's own partial closures — both are
    the deferred crash-recovery test cases, `TC-SEND-017`/`018`, explicitly
    named as out of M5-S3-send's scope in its own evidence).

Before writing any code: read each of these five rows in `traceability.csv`
in full (not the truncated summary above), decide whether `BR-CFG-002`
needs a small new implementation slice or was actually satisfied
elsewhere and the CSV is just stale, and decide whether the two
`TC-SEND-017/018` crash-recovery cases need real coverage or were already
effectively proven by M5-S3 CP4/CP5's own crash/kill-mid-batch tests under
a different test-case label (check `apps/worker/src/campaign-send/
send.integration.test.ts`'s A15 cases before assuming a gap exists).
**Do not flip M5-GATE to `completed` by inference from its dependencies
being done** — that was deliberately left undone this session precisely
because the gate's own conditions need independent verification.

TC-SCH-*/TC-CFG-*/TC-SEND-* mapping-and-executing and the SMTP-credential-
never-logged conditions have strong existing evidence scattered across
M5-S1/S2/S3/S4's own evidence trails (e.g. A21/A17-style secret-leak tests
exist in `send.integration.test.ts` and `webhooks-http.test.ts`) but have
never been assembled into one gate-level check — that assembly is this
node's own job, not something to assume is implicitly done.

## Working discipline (unchanged, carried forward)

- Evidence before status — never flip `closed`/`completed` before the
  artifact justifying it exists and has been re-run.
- Individually inspect every visual-evidence image a node produces — do
  not trust a green Playwright run alone.
- Real bugs found during work get fixed at the root cause and disclosed
  (`D-*`/`DEC-*`), not silently worked around.
- Compare the workspace check's test *and skip* count against the
  previous node's own baseline, not just its exit code.
- Push/merge-commit actions require separate, explicit per-instance user
  confirmation — do not treat one approval as blanket authorization.

## Suggested skills for the next session

- **`superpowers:writing-plans`** — `M5-GATE` is a verification-and-
  possibly-small-implementation node; if `BR-CFG-002` genuinely needs new
  code (not just a stale CSV row), write a short plan for that slice
  before touching code, same discipline as every M5 sub-node this run.
- **`superpowers:test-driven-development`** — if any real gap is found
  and needs code (most likely `BR-CFG-002`), RED-first as established.
- **`superpowers:systematic-debugging`** — for triaging whether
  `BR-SEND-006`/`007`'s `TC-SEND-017/018` gap is real or already covered
  under a different label, before deciding to write new tests.
- **`superpowers:verification-before-completion`** — before flipping
  `M5-GATE` to `completed`, since that status change gates the entire
  M6 milestone starting.
