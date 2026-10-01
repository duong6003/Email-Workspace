# M5-S4 Webhook Reconciliation Implementation Plan

> **For agentic workers:** execute this plan checkpoint-by-checkpoint under
> AGENTS.md §2 (evidence precedes status, commit at every checkpoint, compare
> test *and skip* counts against the CP0 baseline). Use
> `superpowers:test-driven-development` (RED before GREEN at every checkpoint)
> and `superpowers:systematic-debugging` on any red. This plan is the spec; do
> not re-derive it from `state.json`.

Node: `M5-S4-webhook-reconciliation` · Depends on: `M5-S3-send` (completed 2026-08-18, commit `8198740`)
Owns rules: **BR-SEND-008** (1 — the only rule `state.json` names, re-confirmed directly against `traceability.csv:91`)
Inherits and closes: the `TC-SEND-014` half of **BR-SEND-002** (`partially_closed`, "TC-SEND-014/015 … remain not_started"), and the `parseWebhookEvent()` half of **BR-CFG-005** (already `closed`, but its evidence cell explicitly excludes the webhook path — that exclusion is retired here)
Test cases: **TC-SEND-008, TC-SEND-014** (TC-SEND-015's *monotonic percent* half stays M6-S1's; its *counter never decreases* half is closed here — see §0(a))
Screens: no new screen. One count-correctness fix on `UI-EMAIL-001` (compose), §3.7
Reserved: migration **027**, decisions **DEC-107…DEC-114**, defects **D-105…D-110** (D-109/D-110 found during CP3/CP4 execution, not pre-registered at planning)
Solo execution (no Codex split — same as M4-S2 through M5-S3).

---

## 0. Read this before touching anything

Eight findings, every one verified directly against the working tree at
`8198740`. Four are pre-existing defects this node is the first able to see;
four are constraints that decide the design and must not be re-litigated
mid-checkpoint.

**(a) `getCampaignProgress` reports `sent` as a number that will *decrease* the
moment this node's first webhook lands.** `campaigns.service.ts:464` returns
`sent: counts.submitted`, and `counts.submitted` is a `GROUP BY status` over
`campaign_recipient`. The instant a `delivered` callback moves a row
`submitted → delivered`, `submitted` drops by one and so does `sent`. The same
arithmetic is on screen: `ComposeDraftScreen.tsx:98` renders "Đã gửi" as
`progress.counts.submitted`. AGENTS.md §4 states the invariant in one line —
*"Progress counters never decrease and reconcile to campaign-recipient facts"* —
and TC-SEND-015's expected result says the same thing (`Progress luôn 0..100 và
không giảm`). This is not a webhook bug; it is a latent defect that M5-S3 could
not observe because `delivered`/`bounced` were unreachable (DEC-096), and that
this node makes reachable in its first passing test. **Record as D-105.** Fixed
in §3.7. The `counts` map itself is correct and stays untouched — it is the
*derived rollups* that are wrong.

**(b) `SmtpProviderAdapter.parseWebhookEvent` spreads an unvalidated,
attacker-controlled payload into the object its own type says it returns.**
`smtp-provider.adapter.ts:19`:

```ts
parseWebhookEvent(payload: unknown) {
  return { type: 'unknown', ...(typeof payload === 'object' && payload ? payload as Record<string, unknown> : {}) }
    as { type: string; providerMessageId?: string; occurredAt?: Date };
}
```

Every key in the request body lands on the returned event, including
`providerMessageId` and `occurredAt`, and the `as` cast tells the compiler to
believe `occurredAt` is a `Date` when it is whatever JSON the caller posted.
Harmless today only because nothing calls it. It is the first thing this node
wires to a public HTTP route, so it must be replaced with a real parser that
*reads named fields and ignores everything else*, not extended.
**Record as D-106.**

**(c) `message_attempt.provider_message_id` is the only join key from a provider
callback back to a recipient, and it is neither indexed nor unique.** `026`
creates three indexes on `message_attempt` — none on `provider_message_id`. Nor
can it be made unique: the deterministic Message-ID (DEC-104) is identical
across re-submissions, so R2's crash-between-accept-and-record window
legitimately produces two `outcome='submitted'` rows sharing one
`provider_message_id`. The resolver must therefore select **distinct** recipients
and require exactly one, and 027 must add the index. **Record as D-107.**

**(d) `suppressRecipient()` does not exist.** `M5-S3-SEND-PLAN.md` §3.7 specified
it as a function and DEC-105 recorded the commitment that *"M5-S4 only has to
add a caller, not a mechanism"*. What shipped is an inline tail inside `send.ts`'s
`recordFailure` (`apps/worker/src/campaign-send/send.ts:345-360`): two statements
guarded by `if (classification.hardBounce)`. The plan document and the code
disagree, and a decision row promises an interface that no caller can reach.
**Record as D-108.** Resolved by §3.5 / DEC-107 — this is the open question the
handoff flagged, and it is answered below *before* CP0, not discovered at CP4.

**(e) Nothing in `apps/api` captures a raw request body, and the one place that
configures body parsing is not on the integration tests' code path.**
`main.ts:10` calls `app.useBodyParser('json', { limit: JSON_BODY_LIMIT_BYTES })`;
every integration test builds its app with `moduleRef.createNestApplication()`
plus `setGlobalPrefix`/`cookieParser`/`HttpExceptionFilter` and never calls
`useBodyParser`. An HMAC over the request body needs the exact bytes that were
signed — `JSON.stringify(req.body)` is **not** those bytes (key order, unicode
escaping, whitespace). Any raw-body wiring placed in `main.ts` would therefore be
verified in production and silently absent in every test, which is worse than no
verification at all. Not a defect — a constraint that picks the design in §3.8.
**DEC-112.**

**(e-2, found at CP3, D-109): a second, route-scoped body parser is the wrong
fix for (e) and would have shipped a silent defect.** The design first written
here for §3.8 was module-scoped `express.raw()` middleware
(`NestModule.configure`) on `WebhooksController`'s route. Verified against
`@nestjs/platform-express`'s `express-adapter.js` before implementing: `main.ts`'s
global `app.useBodyParser('json', …)` registers Express's own `json()` parser as
global middleware, which — for any request whose `Content-Type` is
`application/json`, which every real provider webhook is — reads and fully drains
the request stream **before** any route-scoped module middleware added later in
the bootstrap sequence gets a chance to run. A second parser (`express.raw()`)
reaching an already-drained stream does not error; it silently produces an
**empty buffer**, which would make every production signature check fail closed
in a way indistinguishable from "provider stopped sending", not the loud, named
failure R1 exists to guarantee. This is exactly the wrong-data-not-wrong-error
class AGENTS.md §2's "a suite that stops running is not a passing suite" warns
about, one layer down: a middleware that stops producing useful data is not a
working middleware. Verified instead that NestJS ships the mechanism built for
precisely this (Stripe-webhook-style) case: `NestApplicationOptions.rawBody`.
Passing `{ rawBody: true }` to `NestFactory.create()` attaches a `verify` callback
to body-parser's own json/urlencoded parsers
(`getBodyParserOptions()`/`rawBodyParser` in `get-body-parser-options.util.js`)
that stashes the exact pre-parse bytes onto `req.rawBody: Buffer` for **every**
request, with zero risk of double-consuming the stream, because it observes bytes
the existing parser is already reading rather than adding a second reader.
`TestingModule.createNestApplication()` accepts the identical
`NestApplicationOptions` (confirmed in `@nestjs/testing`'s `testing-module.js`:
both call sites construct `NestApplication` with the same options object), which
satisfies DEC-112's actual goal — test/prod parity — more literally than
module-scoped middleware ever did, since it is one flag read at app-construction
time rather than something dependent on Nest's own module-bootstrap ordering.
**§3.8 revised accordingly; DEC-112's goal stands, its mechanism does not.**

**(f) A secret this route needs must live in the *API* process's environment.**
D-91/DEC-100 established that `EnvSecretStore` is a per-process `Map` with a
`process.env` fallback, invisible across processes. The webhook route is served
by `apps/api`, so `EnvSecretStore.resolve()` there works — provided the reference
names a real environment variable of the API container. This is why §3.2 resolves
the signing secret through the existing `SecretStore` seam rather than inventing a
second mechanism, and why §3.8 adds the variable to `env.ts`, `compose.yaml` and
`.env.deploy.example` together (AGENTS.md §2's deployment-contract clause).

**(g) `EXECPLAN.md` §10's placeholder row is dedupe-only and cannot express
ordering.** It reserves `delivery_events` with `UNIQUE (provider,
provider_event_id)`. That makes a *replay* a no-op, which is half of this node's
success conditions; it says nothing about *"out-of-order events do not regress
state"*, because two distinct events with distinct ids arriving in the wrong
order both pass the unique index. 027 therefore also carries `occurred_at` on the
event and `delivery_state_at` on `campaign_recipient` (§3.1), and the apply rule
combines both with the message state machine (§3.4).

**(h) `send-state-machine.ts` already contains this node's transition law, in the
same app.** `apps/api/src/campaigns/send-state-machine.ts` declares exactly two
inbound edges for the states this node writes — `submitted->delivered` and
`submitted->bounced` — and gives both terminal states zero outbound edges. It
lives in `apps/api`, so the webhook service **imports** it (no duplication
question here, unlike §3.5). A `delivered` arriving after a `bounced` is refused
by `isLegalMessageTransition` alone, before any timestamp comparison.

**Migration numbering:** `026` is the highest applied (`database/migrations/`
verified, `migrations.lock.json` in sync). **This node takes 027.**

---

## 1. What this slice turns from definition into fact

M5-S3 made an email leave the building and recorded, from the SMTP transaction
alone, that the provider *accepted* it. That is the last fact the sender can
observe by itself. Everything after — did it arrive, did it bounce, did the human
mark it as spam — is knowledge that exists only at the provider and is pushed
back over an unauthenticated public HTTP endpoint, out of order, more than once,
and by anyone on the internet who guesses the URL.

**This slice is where the system starts believing something it did not observe,
and therefore the first place where "believing" needs a proof.**

### The rule, in its own words

| Rule | What it actually requires | P |
|------|---------------------------|---|
| BR-SEND-008 | *"Webhook trùng không tăng count; chữ ký sai trả 401/400 và không ghi state."* A duplicate webhook must not inflate any count; a bad signature returns 401/400 and writes **no** state. Feature text (TC-SEND-008): *delivered/bounced/complaint webhooks are signature-verified, idempotent, and mapped back to a message*. | P0 |

Two inherited half-rules close with it:

- **BR-SEND-002** (`partially_closed`): its evidence cell names `TC-SEND-014`
  (duplicate-event counting) as out of M5-S3's scope. TC-SEND-014 is this node's.
- **BR-CFG-005** (`closed`): its evidence cell ends *"parseWebhookEvent()/inbound
  delivery-status webhooks remain out of scope (BR-SEND-008, not_started)"*. That
  written exclusion is retired here.

The binding sentence for this node, in the shape M4-S4, M5-S2 and M5-S3 each had
one:

> **The payload is evidence, never authority: the only fact a callback is
> allowed to contribute is its own `(provider, provider_event_id, type,
> occurred_at)`, and every identity in the transaction — tenant, recipient,
> campaign, current state — is re-derived from PostgreSQL through a key the
> system itself generated.**

Everything hard about this node collapses onto that sentence. The tenant is not
in the payload; it is resolved from `message_attempt.provider_message_id`, a
Message-ID *this system* minted deterministically (DEC-104). Idempotency is not a
cache; it is a unique index on the event id. "Does not regress state" is not
application logic that could be forgotten; it is the intersection of a state
machine that has no edge out of a terminal state and a timestamp comparison
against the last applied event. A design where the callback body supplies
`tenantId` or `campaignRecipientId` — the shape almost every provider-webhook
tutorial shows — hands a cross-tenant write primitive to an unauthenticated
endpoint, and is the exact defect class AGENTS.md §4's first invariant exists to
prevent.

### Hard non-goals

- **No realtime, no percent, no ETA.** `BR-SEND-003/004/005` are M6-S1's. This
  node fixes the *count correctness* half of monotonicity (D-105) because it is
  the node that breaks it; it computes no percentage and pushes nothing over a
  socket. **DEC-108.**
- **No per-event outbox row.** `aggregate` already emits
  `campaign.execution_state_changed` on the terminal transition. Emitting an
  outbox row per delivery event would mean one row per recipient per campaign
  with no consumer until M6-S1, and `delivery_event` is *already* the durable,
  append-only, uniquely-keyed record M6-S1 or M6-S3 can read or replay. The
  outbox exists to publish facts that would otherwise be lost; this fact is not.
  **DEC-109.**
- **No re-opening a terminal execution.** A bounce that arrives after
  `aggregate` has moved the campaign to `completed` updates the *recipient*, not
  the campaign. `aggregateExecution` counts a row as done when it leaves
  `pending`/`queued` (`aggregate.ts:44`), so a delivery event can never change
  its verdict, and there is no `completed → partial_failed` edge in
  `LEGAL_CAMPAIGN_EXECUTION_EDGES` to take even if one wanted to. Campaign status
  answers *"did we finish sending"*; per-recipient status answers *"what happened
  to this message"*. Conflating them would make a campaign's terminal state
  non-terminal for as long as a provider keeps sending events. **DEC-110.**
- **No storage for unmatched events.** A signature-valid event whose
  `provider_message_id` matches no `message_attempt` row has **no tenant**, and
  `delivery_event` is a tenant-owned table under `FORCE ROW LEVEL SECURITY`.
  Writing a `tenant_id IS NULL` row would require weakening that policy for every
  row in the table to keep a record with no owner and no consumer. The route
  answers `200 {status:'unmatched'}`, logs it with the event id, and stores
  nothing. **DEC-111.**
- **No per-tenant webhook secret.** See §3.2 — a per-tenant secret cannot be
  selected before the tenant is known, and the tenant is only knowable by reading
  the database using an unverified payload field. One deployment-level secret per
  provider, resolved from the API process's own environment. **DEC-114.**
- **No second provider.** `020_sender_config.sql:9` constrains `provider` to
  `CHECK (provider IN ('smtp'))`. The route validates `{provider}` against the
  adapter registry and returns **404** for anything else; it does not invent an
  adapter this system has no configuration for.
- **No queue, no retry job.** Processing is synchronous inside the request. A
  provider's own retry is the recovery mechanism, which is why an unexpected
  server error must surface as **5xx** (retryable) while a rejected signature
  must surface as **401** (never retried). Deferring the apply to BullMQ would
  make TC-SEND-014's "read the counters after the replay" assertion a polling
  loop, i.e. a D-33-class flake, and would buy nothing: the work is two
  statements. **DEC-113.**
- **No history/delivery-log UI.** `UI-HIS-001/002` are M6-S3's.

---

## 2. Acceptance criteria

| # | Criterion | Rule | Test case | Proof layer |
|---|-----------|------|-----------|-------------|
| A1 | `delivery_event`'s `UNIQUE (provider, provider_event_id)` rejects a second row with `23505`; `event_type`/`outcome` CHECKs reject an unknown value with `23514`; the table is `FORCE ROW LEVEL SECURITY` with a tenant policy, and `eow_app` holds `SELECT, INSERT` only (never `UPDATE`/`DELETE` — the ledger is append-only) | BR-SEND-008 | TC-SEND-008 | migration + integration |
| A2 | A signature-valid `delivered` event for a `submitted` recipient returns **200** `{status:'applied'}`, moves that row to `delivered`, sets `delivery_state_at` to the event's `occurred_at`, and writes exactly one `delivery_event` row with `outcome='applied'` | BR-SEND-008 | TC-SEND-008 | integration (real PostgreSQL) |
| A3 | Replaying the **identical** event (same `provider_event_id`, same signature) returns 200 `{status:'duplicate'}`, leaves exactly **one** `delivery_event` row, and leaves `counts.delivered` at exactly 1 — asserted by reading `GET /campaigns/{id}/progress` before and after the replay, not by trusting the response body | BR-SEND-008, BR-SEND-002 | TC-SEND-014 | integration |
| A4 | An event signed with the **wrong secret** returns **401**, writes zero `delivery_event` rows, and leaves the recipient at `submitted` — asserted by row count and status re-read, not by the status code alone | BR-SEND-008 | TC-SEND-008 | integration |
| A5 | A **tampered body** carrying the signature computed over the original body returns 401 and writes nothing — proving the HMAC covers the payload, not just the timestamp | BR-SEND-008, BR-SEC-005 | TC-SEND-008 | integration |
| A6 | A missing, empty or malformed `X-EOW-Signature` header returns **400** and writes nothing; a well-formed signature whose timestamp is outside the ±300s tolerance returns **401** and writes nothing | BR-SEND-008 | TC-SEND-008 | integration |
| A7 | A `bounced` event whose `occurred_at` is **earlier** than an already-applied event's returns 200 `{status:'ignored'}` with `outcome='ignored_out_of_order'`, and the recipient's status and `delivery_state_at` are identical to their pre-request values | BR-SEND-008 | TC-SEND-008 | integration |
| A8 | A `delivered` event for a recipient that is `failed` (or `pending`, or already `bounced`) is recorded with `outcome='ignored_illegal_transition'` and changes no status — the decision comes from `isLegalMessageTransition`, asserted by a unit test over the full event-type × current-status grid *and* by one integration case | BR-SEND-008, BR-SEND-002 | TC-SEND-008 | unit + integration |
| A9 | A `bounced` event suppresses the recipient **in the same transaction** as the state change: `recipient.subscription_status='bounced'`, `suppressed_at` set, `suppression_reason='hard_bounce'`, exactly one `recipient.suppressed` audit row; freezing a *second* campaign afterwards skips that person with `skipped_reason='status_bounced'` | BR-SEND-011 (webhook half), BR-SEND-008 | TC-SEND-011, TC-SEND-008 | integration |
| A10 | A `complaint` event suppresses with `suppression_reason='complaint'` and leaves the message status untouched; a `complaint` for an already-suppressed recipient writes no second audit row and does not overwrite the first reason | BR-SEND-011 | TC-SEND-011 | integration |
| A11 | A signature-valid event whose `providerMessageId` matches no `message_attempt` row returns 200 `{status:'unmatched'}` and writes **zero** rows to `delivery_event`, `campaign_recipient`, `recipient` and `audit_log` | BR-SEND-008 | TC-SEND-008 | integration |
| A12 | Cross-tenant: a payload carrying tenant A's identifiers but tenant B's `providerMessageId` applies **only** to tenant B's recipient; extra payload keys named `tenantId`/`campaignRecipientId`/`status` are ignored entirely — proven by posting them with hostile values and asserting nothing in tenant A changed | domain invariant, BR-GEN-002 | TC-SEND-008 | integration |
| A13 | Two genuinely concurrent POSTs of the same event id produce exactly one `delivery_event` row and one state change — real concurrency (`Promise.all`), not sequential | BR-SEND-008 | TC-SEND-014 | integration (concurrent) |
| A14 | `GET /campaigns/{id}/progress`'s `sent`, `delivered` and `failed` never decrease across the sequence submit → deliver → bounce, while `counts` still sums to `totalSnapshot` at every step (D-105) | BR-SEND-002 | TC-SEND-014, TC-SEND-015 (count half) | integration |
| A15 | With the signing secret unset the route returns **503** and writes nothing — it never falls back to accepting unverified events; the route declares `@Public()` explicitly (ARCH-RBAC) and is exempt from `CsrfGuard` by carrying no session | BR-SEND-008, BR-AUTH-004 | TC-SEND-008 | integration + architecture |
| A16 | A body larger than the webhook limit is rejected with **413** before any handler code runs, and writes nothing | BR-SEC-005 | TC-SEND-008 | integration |
| A17 | No log line, `audit_log` metadata or stored `delivery_event.payload` contains the signing secret or a rendered message body | BR-SEC-003 | TC-SEND-013 (partial) | integration |
| A18 | The compose screen's "Đã gửi" tile does not decrease when delivery events land, and a delivered count is visible — captured at 3 viewports and **individually inspected** | BR-SEND-002 | TC-SEND-015 (count half) | e2e + visual |

---

## 3. Locked design

### 3.1 Migration 027 — `027_delivery_events.sql`

Forward-only; touches no published migration. Applied via
`docker compose run --rm migrate`, lock entry added, `ARCH-MIGRATION` re-run
standalone.

```sql
-- M5-S4 -- inbound provider delivery events. EXECPLAN SS10 reserved
-- `delivery_events` with UNIQUE (provider, provider_event_id); that key makes a
-- replay a no-op but says nothing about ordering (SS0(g)), so this migration also
-- carries occurred_at here and delivery_state_at on campaign_recipient. Singular
-- table name, matching every other table in this schema (campaign,
-- campaign_execution, message_attempt).

-- ---------------------------------------------------------------------------
-- (1) The append-only event ledger. UNIQUE (provider, provider_event_id) IS the
-- idempotency key (BR-SEND-008, A1/A3): a replay conflicts and applies nothing.
-- Tenant-owned, because every row that reaches it has already been resolved to
-- exactly one tenant through a Message-ID this system minted (DEC-111 explains
-- why an unmatched event is not stored at all rather than stored tenant-less).
-- ---------------------------------------------------------------------------
CREATE TABLE delivery_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  provider text NOT NULL CHECK (provider IN ('smtp')),
  provider_event_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'delivered', 'bounced', 'complaint', 'deferred', 'unknown'
  )),
  provider_message_id text NOT NULL,
  campaign_recipient_id uuid NOT NULL REFERENCES campaign_recipient(id),
  execution_id uuid REFERENCES campaign_execution(id),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN (
    'applied', 'ignored_out_of_order', 'ignored_illegal_transition', 'ignored_not_applicable'
  )),
  payload jsonb NOT NULL,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX idx_delivery_event_recipient
  ON delivery_event (tenant_id, campaign_recipient_id, occurred_at);

-- ---------------------------------------------------------------------------
-- (2) The ordering guard (SS3.4, A7). "Out-of-order events do not regress
-- state" needs a per-row high-water mark: the occurred_at of the event that
-- produced the current delivery state. NULL until the first event applies.
-- ---------------------------------------------------------------------------
ALTER TABLE campaign_recipient
  ADD COLUMN IF NOT EXISTS delivery_state_at timestamptz;

-- ---------------------------------------------------------------------------
-- (3) D-107: provider_message_id is the only join key from a callback back to a
-- recipient and 026 left it unindexed. It cannot be UNIQUE -- the deterministic
-- Message-ID (DEC-104) repeats across re-submissions, which is exactly what
-- makes M5-S3 R2's crash window detectable -- so the resolver selects DISTINCT
-- and requires exactly one recipient (SS3.4).
-- ---------------------------------------------------------------------------
CREATE INDEX idx_message_attempt_provider_message_id
  ON message_attempt (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- (4) The tenant resolver. An inbound webhook carries no session, so the lookup
-- that finds the owning tenant must run before any tenant context exists. Same
-- narrow SECURITY DEFINER shape as 013/025/026: a fixed query returning nothing
-- but the ids the caller needs, so the API stays eow_app/NOBYPASSRLS and no
-- broad cross-tenant read is ever granted. DISTINCT per D-107.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_provider_message(p_provider_message_id text)
RETURNS TABLE (tenant_id uuid, campaign_recipient_id uuid, execution_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT message_attempt.tenant_id,
                  message_attempt.campaign_recipient_id,
                  message_attempt.execution_id
  FROM message_attempt
  WHERE message_attempt.provider_message_id = p_provider_message_id
    AND message_attempt.outcome = 'submitted'
  LIMIT 2
$$;
REVOKE ALL ON FUNCTION resolve_provider_message(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_provider_message(text) TO eow_app;

-- Append-only: no UPDATE, no DELETE grant. A correction is a new event row.
GRANT SELECT, INSERT ON TABLE delivery_event TO eow_app;
ALTER TABLE delivery_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_event FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_event_tenant_isolation ON delivery_event
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
```

`LIMIT 2` is deliberate: the caller must be able to distinguish "exactly one
recipient" from "more than one", and a `LIMIT 1` would silently pick a winner if
two different recipients ever shared a Message-ID. Two rows ⇒ treat as unmatched
and log it — an ambiguous mapping is not a mapping.

### 3.2 The signature scheme (BR-SEND-008's first clause)

One deployment-level secret per provider, resolved through the **existing**
`SecretStore` seam (`apps/api/src/sender-config/secret-store.ts`) so there is no
second secret mechanism to audit:

```
X-EOW-Signature: t=1755513600,v1=<hex sha256 hmac>
signed payload = `${t}.${rawBody}`      # raw bytes, never a re-serialisation
tolerance      = 300 seconds either side of now
```

`apps/api/src/webhooks/webhook-signature.ts` — a pure function, no Nest, no DB:

```ts
export type SignatureFailure = 'malformed' | 'expired' | 'mismatch';
export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

export function verifyWebhookSignature(input: {
  rawBody: Buffer;
  header: string | undefined;
  secret: string;
  now: Date;                      // injected -- R4's no-wall-clock discipline
  toleranceSeconds?: number;
}): SignatureResult;
```

- `malformed` (⇒ **400**): header absent, empty, missing `t=` or `v1=`, `t` not
  an integer, `v1` not lowercase hex, or `v1` of the wrong length.
- `expired` (⇒ **401**): `|now - t| > tolerance`. Bounds the replay window that
  the `delivery_event` unique index bounds permanently — belt and braces, because
  the index cannot help before the row is written.
- `mismatch` (⇒ **401**): digests differ. Compared with
  `crypto.timingSafeEqual` over two equal-length Buffers, with the length check
  done first (`timingSafeEqual` throws on unequal lengths, which would itself be
  a length oracle if allowed to surface as a 500).

**Why not a per-tenant secret.** Selecting a tenant's secret requires knowing the
tenant; the only tenant hint in an unverified request is `providerMessageId`,
which would mean *reading the database on behalf of an unauthenticated,
unverified caller* to decide how to authenticate them — an enumeration oracle
gated on nothing. One secret per provider per deployment matches what this system
actually is (one webhook URL per deployment, one provider), keeps verification
strictly before any database access, and leaves the multi-account case to M7-S2
if it ever arrives with a real requirement. **DEC-114.**

**Fail closed.** If `PROVIDER_WEBHOOK_SECRET` resolves to `undefined` the route
returns **503** and touches nothing (A15). It never degrades to "accept
unverified" — the entire rule is that an unverified event writes no state.

### 3.3 The parser (D-106, BR-CFG-005's webhook half)

`SmtpProviderAdapter.parseWebhookEvent` is **replaced**, not extended. It reads
named fields and ignores every other key:

```ts
// provider-adapter.ts -- widened. The reason the old shape was unsafe is
// recorded as D-106: the previous stub spread the caller's whole payload into
// this object and cast the result.
export type ProviderWebhookEvent = {
  eventId: string | null;
  type: 'delivered' | 'bounced' | 'complaint' | 'deferred' | 'unknown';
  providerMessageId: string | null;
  occurredAt: Date | null;
};
```

```ts
// smtp-provider.adapter.ts
parseWebhookEvent(payload: unknown): ProviderWebhookEvent {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  const occurred = text(body.occurredAt);
  const parsed = occurred ? new Date(occurred) : null;
  const type = text(body.type);
  return {
    eventId: text(body.id) ?? text(body.eventId),
    type: type === 'delivered' || type === 'bounced' || type === 'complaint' || type === 'deferred' ? type : 'unknown',
    providerMessageId: text(body.messageId) ?? text(body.providerMessageId),
    occurredAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
  };
}
```

A `null` `eventId` or `providerMessageId` is a **400** at the route
(`WEBHOOK_PAYLOAD_INVALID`) — the two fields without which no idempotency and no
mapping is possible. A `null` `occurredAt` falls back to the verified signature
timestamp `t`, which is inside the tolerance window by construction; this is
recorded in the plan rather than left implicit because it is the one place a
provider omission is tolerated. `FakeProviderAdapter.parseWebhookEvent` is
updated to satisfy the widened type (returning
`{eventId:null, type:'delivered', providerMessageId:null, occurredAt:null}`); it
is a connection-test fake with no webhook caller and stays that way.

### 3.4 The apply algorithm (the whole of §1's binding sentence)

`apps/api/src/webhooks/webhooks.service.ts`, one method, in this exact order.
Steps 1–3 write nothing at all.

1. **Verify** (§3.2). Any failure ⇒ 400/401/503, return. *No database access has
   happened yet.*
2. **Parse** (§3.3) the already-verified bytes. Missing `eventId`/
   `providerMessageId` ⇒ 400.
3. **Resolve**, outside any tenant context, via
   `SELECT tenant_id, campaign_recipient_id, execution_id FROM resolve_provider_message($1)`.
   Zero rows, or two ⇒ 200 `{status:'unmatched'}`, nothing written (DEC-111).
4. **Apply**, inside `runInTenantContext(dataSource, tenantId, …)` — one
   transaction, RLS engaged (the M5-S3 lesson recorded as D-95: RLS is opt-in per
   query, so *every* statement below is inside this callback):

   a. `SELECT status, delivery_state_at, recipient_id FROM campaign_recipient
      WHERE id = $1 AND tenant_id = $2 FOR UPDATE` — the row lock is what makes
      A13's concurrency case deterministic.

   b. Decide the outcome from the locked row, before writing anything. **D-110
      (found at CP4, correcting this table as first written):** the ordering
      check must run **before** the legality check for `delivered`/`bounced`,
      not after. `delivered` and `bounced` are each reachable from exactly one
      inbound edge (`submitted->…`) and have zero outbound edges (SS3.6), so
      the instant the *first* such event applies, the row leaves `submitted`
      permanently — meaning a *second* event of the same class, checked
      legality-first, always fails `isLegalMessageTransition` (its own current
      status is no longer `submitted`) and reads as `ignored_illegal_transition`
      **regardless of its timestamp**. Under that order `ignored_out_of_order`
      is not merely rare, it is unreachable by any two sequential requests —
      the exact defect this table exists to prevent, discovered by trying to
      write A7 as an integration test and finding no sequence of two real HTTP
      requests could ever produce it. Checking ordering first is also the
      literal reading of §3.6's own sentence — *"an older event from
      overwriting a newer one of **the same legality class**"* — a staleness
      question asked about events that are candidates for the same class of
      transition, resolved before asking whether this particular one is legal:

      | event `type` | condition | outcome | state written |
      |---|---|---|---|
      | `delivered`/`bounced` | `delivery_state_at IS NOT NULL AND occurred_at <= delivery_state_at` | `ignored_out_of_order` | none |
      | `delivered`/`bounced` | (not stale, per above) and `!isLegalMessageTransition(status, type)` | `ignored_illegal_transition` | none |
      | `delivered` | (not stale) and legal | `applied` | `status='delivered'`, `delivery_state_at=occurred_at` |
      | `bounced` | (not stale) and legal | `applied` | `status='bounced'`, `delivery_state_at=occurred_at`, **+ suppression (§3.5, `hard_bounce`)** |
      | `complaint` | always | `applied` | **suppression only** (`complaint`); message status untouched — a complaint is about the human, not the delivery |
      | `deferred`/`unknown` | always | `ignored_not_applicable` | none |

      A8's "already bounced" case (a `delivered` event for a `bounced`
      recipient) still reads as `ignored_illegal_transition`, not
      `ignored_out_of_order`, provided its `occurred_at` is not older than the
      bounce's own `delivery_state_at` — the acceptance criterion assumes the
      ordinary case (a same-time-or-later illegal event), and CP4's own test
      picks a timestamp accordingly, disclosed there rather than left to be
      rediscovered.

   c. `INSERT INTO delivery_event (…) VALUES (…) ON CONFLICT (provider,
      provider_event_id) DO NOTHING RETURNING id`. **Zero rows ⇒ this event was
      already processed**: return 200 `{status:'duplicate'}` without executing
      (d), leaving the transaction with nothing but a no-op insert. This is the
      single point at which BR-SEND-008's "trùng không tăng count" is enforced;
      the state updates in (d) are *additionally* guarded by their own
      `WHERE status = …` predicates, so neither layer is load-bearing alone.

   c is deliberately after b and before d: the ledger row records the outcome
   that was decided, and no state change can happen without a ledger row.

   d. Execute the "state written" column of b's table, if any.

5. Return `{status, eventId}` where `status ∈ {'applied','duplicate','ignored','unmatched'}`.

Response code is **200** for every one of these (including `duplicate` and
`ignored`): they are all "the event has been definitively handled, do not send it
again", which is what a webhook's status code means to the sender. An unexpected
exception surfaces as 5xx through the existing `HttpExceptionFilter`, which is
the provider's cue to retry — and is safe precisely because step 4 is one
transaction (DEC-113).

**Payload storage.** `delivery_event.payload` stores the parsed, normalised event
(`{eventId, type, providerMessageId, occurredAt}`), not the raw body. The raw
body is attacker-controlled, unbounded in key count, and may carry provider
metadata this system has no policy for; A17 asserts what is stored contains no
message body and no secret.

### 3.5 Suppression — the extract-or-duplicate question, decided (D-108, DEC-107)

**Decision: extract in `apps/worker` (behaviour-preserving), transliterate in
`apps/api`, and bind the two copies with a new architecture fitness function.**

The handoff framed this as "extract or duplicate". Verified facts that decide it:

- `apps/api/tsconfig.json` and `apps/worker/tsconfig.json` both set
  `rootDir: "src"`, and neither `package.json` declares a dependency on any
  workspace package. A relative import across `apps/` is not merely discouraged —
  it does not compile.
- The two call sites do not share a client type. The worker holds a
  `pg.PoolClient` inside `runInTenantTransaction`; the API holds a TypeORM
  `EntityManager` inside `runInTenantContext`. Even with a shared module, the
  body could not be shared without an adapter layer that exists for no other
  reason.
- Creating a new `@eow/*` package to host it is a repository-topology change
  (ADR-004) plus a dependency review (AGENTS.md §5), to share two SQL statements
  that still could not be one implementation. **Rejected as disproportionate**,
  and recorded as the rejected alternative in DEC-107 rather than left unsaid.

So, concretely:

1. `apps/worker/src/campaign-send/suppression.ts` — new file:

```ts
import type pg from 'pg';

export type SuppressionReason = 'hard_bounce' | 'complaint';

/**
 * BR-SEND-011. Suppression is a single fact with two producers: this app's
 * synchronous hard-bounce path (send.ts) and apps/api's webhook path
 * (apps/api/src/webhooks/suppression.ts). Cross-app import is impossible
 * (rootDir: src, no shared package) and the two callers hold different client
 * types, so the API copy is a transliteration, not a duplicate that could have
 * been an import -- DEC-107, following DEC-106's retry-backoff.ts precedent.
 * ARCH-SUPPRESSION-PARITY holds the two in step mechanically.
 *
 * MUST be called inside the caller's existing tenant transaction: the rule's
 * own acceptance is that the suppression is created atomically with the event.
 * First cause wins -- a later complaint does not overwrite an earlier
 * hard_bounce, and writes no second audit row.
 */
export async function suppressRecipient(
  client: pg.PoolClient,
  tenantId: string,
  recipientId: string,
  reason: SuppressionReason,
  traceId: string,
): Promise<boolean> {
  const updated = (await client.query(
    `UPDATE recipient SET subscription_status = 'bounced', suppressed_at = now(), suppression_reason = $3,
            version = version + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND suppressed_at IS NULL`,
    [recipientId, tenantId, reason],
  )) as { rowCount: number };
  if (updated.rowCount === 0) return false;
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
     VALUES ($1, NULL, 'recipient.suppressed', 'recipient', $2, $3, $4::jsonb)`,
    [tenantId, recipientId, traceId, JSON.stringify({ reason })],
  );
  return true;
}
```

   `send.ts:recordFailure`'s `if (classification.hardBounce)` block is replaced by
   a call to it with `traceId = \`campaign-send:${row.id}\``.
   **One behaviour change comes with it, and it is deliberate:** the extracted
   version adds `AND suppressed_at IS NULL` and therefore stops bumping `version`
   and writing a second audit row when an already-suppressed recipient hard-bounces
   again. The current inline version re-writes the row every time. The existing
   `send.integration.test.ts` A11 assertions are the regression net and must be
   re-run **unmodified**; CP2 additionally adds the RED test for the new guard, so
   the change is proven, not assumed. **Recorded as part of DEC-107.**

2. `apps/api/src/webhooks/suppression.ts` — the same post-conditions against an
   `EntityManager`, with a header comment naming the worker file and DEC-107.

3. `packages/architecture-tests/src/suppression-parity.test.ts` — **ARCH-SUPPRESSION-PARITY**:
   asserts both files exist, that each names the other in a comment, and that both
   contain all four post-condition tokens (`subscription_status = 'bounced'`,
   `suppressed_at = now()`, `suppression_reason`, `'recipient.suppressed'`) and
   the `suppressed_at IS NULL` guard. Editing one without the other fails
   `pnpm check` in the same edit that caused the drift. This is AGENTS.md §5's
   *"extend the suite whenever a convention proves to have been violated
   silently"* applied to the exact convention that was silently violated (D-108).

### 3.6 Ordering, restated as the property being tested

Two independent mechanisms, both required, each proven by its own test:

- **The state machine** forbids leaving a terminal state at all. `delivered` and
  `bounced` have no outbound edges (`send-state-machine.ts:35-42`), so no later
  event of any timestamp can move a settled row (A8).
- **The high-water mark** (`delivery_state_at`) forbids an *older* event from
  overwriting a newer one of the same legality class (A7).

Neither is sufficient alone: the machine cannot order two `delivered` events, and
the timestamp cannot stop a `delivered` event from resurrecting a `failed` row.

### 3.7 Progress counters (D-105)

`campaigns.service.ts:463-466` becomes:

```ts
// D-105. These four are *rollups*, and every one must be monotonic per
// AGENTS.md SS4 ("progress counters never decrease"). `submitted` alone is not:
// a delivery webhook (M5-S4) moves a row out of `submitted` into `delivered` or
// `bounced`, so `sent: counts.submitted` visibly went backwards the moment this
// node's first callback landed. `counts` itself stays exact and still sums to
// totalSnapshot -- it is the derived numbers that needed the fix.
queued: counts.pending + counts.queued,                          // remaining work: may fall, by definition
sent: counts.submitted + counts.delivered + counts.bounced,      // ever left the building: never falls
delivered: counts.delivered,                                     // never falls (terminal state)
failed: counts.failed + counts.bounced,                          // delivery failures included: never falls
```

`sent` and `failed` deliberately overlap on `bounced`: a bounced message *was*
sent and *did* fail. They are two different questions, not two slices of one
partition — the partition is `counts`, which is unchanged and still the only
thing BR-SEND-002's "sum to `total_snapshot`" applies to. `ComposeDraftScreen.tsx:98`
switches its "Đã gửi" tile from `progress.counts.submitted` to `progress.sent`
and gains a "Đã nhận" tile bound to `progress.delivered` (Vietnamese copy matching
the handoff's register).

### 3.8 Module wiring and the raw body (§0(e)/(e-2), D-109)

```
apps/api/src/webhooks/
├── webhooks.controller.ts     @Controller('webhooks') · one @Public() route
├── webhooks.service.ts        §3.4's algorithm
├── webhooks.module.ts         plain @Module -- no raw-body middleware needed
├── webhook-signature.ts       §3.2's pure verifier
├── suppression.ts             §3.5's API-side transliteration
├── provider-registry.ts       { smtp: SmtpProviderAdapter } -- unknown ⇒ 404
└── dto/
    └── provider-webhook.dto.ts  the response shape (ARCH-MODULE requires dto/)
```

The raw body is captured by NestJS's own `rawBody` application option (D-109),
not a second body parser. `apps/api/src/main.ts` gains `rawBody: true` on
`NestFactory.create()`; the webhook test app's own `moduleRef.createNestApplication({
rawBody: true })` call passes the identical option. Both attach the same
`verify` callback to the **one** existing `express.json()` parser that
`useBodyParser('json', …)` already registers globally — the handler reads
`req.rawBody: Buffer` (typed via `RawBodyRequest<Request>` from `@nestjs/common`),
the exact signed bytes, alongside the framework's already-parsed `req.body` that
every other route continues to use unchanged. `WEBHOOK_BODY_LIMIT_BYTES` (1 MiB —
16× tighter than the global `JSON_BODY_LIMIT_BYTES`, since the global limit exists
for CSV import previews and an unauthenticated endpoint has no business accepting
16 MiB from anyone, A16) is enforced by passing `{ limit: WEBHOOK_BODY_LIMIT_BYTES
}` as `useBodyParser`'s options for the webhook route specifically — see the
per-route body-parser note below.

Because `useBodyParser('json', …)` applies one limit to *every* JSON route, a
single 1 MiB global limit would also shrink every other route's existing 16 MiB
allowance. The fix is the same one D-109 already established: NestJS's body
parser is per-adapter-instance, not per-route, so the webhook route's tighter
limit is enforced **inside the handler**, by checking `req.rawBody.length` before
any signature work and returning 413 explicitly (`PayloadTooLargeException`) —
same client-visible contract as the body-parser-level 413 the `HttpExceptionFilter`
already maps (A16), just enforced one layer up because this route cannot have its
own parser instance.

`WebhooksModule` (a plain `@Module`, no `NestModule`/`MiddlewareConsumer`) is
registered in `app.module.ts`'s `imports`.

**Deployment contract** (AGENTS.md §2 — these four move together):

| File | Change |
|---|---|
| `apps/api/src/config/env.ts` | `PROVIDER_WEBHOOK_SECRET: z.string().min(32).optional()` — optional so every existing test app still boots; the route fails closed at request time (A15), which is the honest place for it |
| `compose.yaml` (`api` service) | `PROVIDER_WEBHOOK_SECRET: ${EOW_PROVIDER_WEBHOOK_SECRET:-}` |
| `.env.deploy.example` | `EOW_PROVIDER_WEBHOOK_SECRET=` with a comment: unset ⇒ the webhook endpoint returns 503, which is the correct posture for a deployment with no provider callbacks configured |
| `docs/deployment/environment-variables.md` | the variable, the endpoint URL, the header format, the ±300s tolerance, and the 503-when-unset behaviour |

---

## 4. HTTP surface

| Method | Path | operationId | Access | Returns |
|--------|------|-------------|--------|---------|
| POST | `/webhooks/providers/{provider}` | `ingestProviderWebhook` | `@Public()` (signature-verified, no session) | 200 `ProviderWebhookResult` |

```yaml
/webhooks/providers/{provider}:
  post:
    security: []                       # same declaration /auth/login uses
    operationId: ingestProviderWebhook
    parameters:
      - {name: provider, in: path, required: true, schema: {enum: [smtp]}}
      - {name: X-EOW-Signature, in: header, required: true, schema: {type: string},
         description: 't=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">'}
    requestBody:
      required: true
      content:
        application/json:
          schema: {$ref: '#/components/schemas/ProviderWebhookPayload'}
    responses:
      '200': {description: Event handled, content: {application/json: {schema: {$ref: '#/components/schemas/ProviderWebhookResult'}}}}
      '400': {$ref: '#/components/responses/Problem'}    # malformed signature or payload
      '401': {$ref: '#/components/responses/Problem'}    # forged, tampered or expired
      '404': {$ref: '#/components/responses/Problem'}    # unknown provider
      '413': {$ref: '#/components/responses/Problem'}    # over the 1 MiB webhook limit
      '503': {$ref: '#/components/responses/Problem'}    # signing secret not configured

ProviderWebhookPayload:               # the inbound body. Deliberately NOT named
  type: object                        # ProviderWebhookEvent -- that TypeScript type
  required: [id, type, messageId]     # is the *parsed* shape (§3.3), not this one
  properties:
    id:         {type: string, description: Provider event id; the idempotency key}
    type:       {enum: [delivered, bounced, complaint, deferred]}
    messageId:  {type: string, description: The Message-ID this system minted at send time}
    occurredAt: {type: string, format: date-time}
ProviderWebhookResult:
  type: object
  required: [status]
  properties:
    status:  {enum: [applied, duplicate, ignored, unmatched]}
    eventId: {type: [string, 'null']}
```

`CampaignProgress` needs **no schema change** — `sent`/`delivered`/`failed` are
already `integer, minimum: 0`. §3.7 changes what those integers mean (from "rows
currently in state X" to "rows that have ever reached state X or beyond"), which
is a semantic change inside an unchanged type; it is documented in the schema
description in the same edit, not left for a reader to infer. `contracts/asyncapi.yaml`
gains **nothing** (DEC-109).

Contract commands, in order, at CP6: `pnpm contracts:generate` (never hand-edit
`packages/contracts/src/openapi.d.ts`), `openapi-compat-check`, `redocly bundle`.

---

## 5. Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | `rawBody: true` is set in `main.ts` but not in the test app's `createNestApplication()` (or vice versa), so signature verification is proven by a test that is not exercising the production path; or the D-109 defect (a second body parser silently reading an empty, already-drained stream) recurs in a different form | §0(e-2)/D-109: `rawBody: true` is one flag, identical at both call sites, verified against `@nestjs/testing`'s source to construct `NestApplication` the same way `NestFactory.create()` does. CP3's first RED test asserts `req.rawBody` is a non-empty `Buffer` matching the literal bytes sent *before* any signature test is written, so a wiring failure is a named failure (undefined/empty buffer) rather than a confusing 401 |
| R2 | A signature scheme that verifies a re-serialised body (`JSON.stringify(req.body)`) passes every test written against a client that serialises identically, and fails against every real provider | The verifier takes `rawBody: Buffer` and nothing else. CP3 includes A5's tampered-body case and one test that signs a body with **different key order and unicode escaping** than the parsed object would produce, asserting it still verifies |
| R3 | Timing-attack surface, or a 500 from `timingSafeEqual` on unequal-length buffers becoming a length oracle | Length is compared first and returns `mismatch`; only equal-length Buffers reach `timingSafeEqual`. Unit-tested with a short digest, a long digest and a non-hex digest |
| R4 | Time-dependent tests (the ±300s tolerance, `occurred_at` ordering) become this run's established flake source (D-33) | No wall-clock waiting anywhere. `verifyWebhookSignature` takes an injected `now`; ordering cases are created by **writing explicit `occurred_at` values** minutes apart, never by sleeping. Same discipline as M5-S2 R5 and M5-S3 R4, which both held |
| R5 | The cross-tenant resolver becomes a broad read grant, re-opening what the standardization workstream closed | `resolve_provider_message` returns three ids and nothing else, is `REVOKE ALL … FROM PUBLIC`, and is the only statement outside a tenant context. A12 asserts a hostile payload cannot reach another tenant, and the apply transaction runs entirely inside `runInTenantContext` (D-95's lesson: RLS is opt-in *per query*) |
| R6 | The §3.5 extraction silently changes the M5-S3 send path, and BR-SEND-011 is already `closed` | CP2 re-runs `send.integration.test.ts` **unmodified** immediately after the extraction, before any webhook code exists, so a regression is attributed to the refactor rather than found four checkpoints later. The one intended behaviour change (`suppressed_at IS NULL`) gets its own RED test in the same checkpoint. Same mitigation shape as M5-S3 R6, which caught a real bug |
| R7 | `delivery_event.campaign_recipient_id` is `NOT NULL REFERENCES campaign_recipient(id)`, so every test file that creates delivery events must delete them before `campaign_recipient` in cleanup — the exact FK-violation class D-93 already produced once | Extend `purgeCampaignSendFixtures()` (worker) and the API test cleanup routines to delete `delivery_event` first, in the **same** one-client-one-transaction pattern D-98 established. Do not copy the older `pool.query()`-per-statement style |
| R8 | The host-contention flake class (D-93): a large suite plus the full docker app stack times out `beforeAll` | `docker compose stop api web worker scheduler` (keep `postgres`/`redis`/`mailpit`) for the duration of heavy test-writing; restore with `docker compose up -d api web worker scheduler` before ending the session. A timeout is isolated by a standalone re-run before it is ever called a defect |
| R9 | `ARCH-CSV-SHAPE` fails on the traceability edits because a new cell contains a literal comma | Wrap any cell containing a comma in double quotes and run `npx vitest run src/csv-shape.test.ts` from `packages/architecture-tests` before trusting a full-suite green |

---

## 6. Checkpoints

Commit at every checkpoint (AGENTS.md §2). The subject names the node; the body
records the workspace check's **test count and skip count**.

**CP0 — baseline.** `pnpm install`, `pnpm run infra:up`, Docker engine healthy.
Full `pnpm run check` green with test **and skip** counts recorded — the number
every later checkpoint is compared against (M5-S3 closed at 116 files / 693
tests / 0 skipped / 0 failed; confirm, do not assume). Apply R8's stack-stop
first. Do not proceed on a red or uncounted baseline.

**CP1 — migration 027, RED first.** Write the failing DB tests before the SQL:
`delivery_event`'s unique index rejects a second `(provider, provider_event_id)`
with `23505`; an unknown `event_type`/`outcome` is refused with `23514`; `eow_app`
can `INSERT`/`SELECT` but **not** `UPDATE`/`DELETE`; RLS refuses a row for another
tenant; `campaign_recipient.delivery_state_at` exists and defaults to NULL;
`resolve_provider_message` is executable by `eow_app`, refuses `PUBLIC`, returns
one row for a submitted attempt, zero for an unknown id, and two for an ambiguous
one; `idx_message_attempt_provider_message_id` exists. Then write
`027_delivery_events.sql`, apply it via `docker compose run --rm migrate`, add the
`migrations.lock.json` entry, and re-run `ARCH-MIGRATION` standalone (4 files).
Extend the cleanup helpers per R7 **in this checkpoint**, not when the first FK
violation appears. A1.

**CP2 — suppression extraction, RED first (D-108/DEC-107).** New RED test in
`send.integration.test.ts`: a second hard bounce against an already-suppressed
recipient writes **no** second `recipient.suppressed` audit row and does not bump
`recipient.version`. Then create `apps/worker/src/campaign-send/suppression.ts`,
rewire `recordFailure`, add
`packages/architecture-tests/src/suppression-parity.test.ts`
(ARCH-SUPPRESSION-PARITY — it must fail while the API-side file is absent, so
write `apps/api/src/webhooks/suppression.ts` in this checkpoint too). Re-run
`send.integration.test.ts` **unmodified apart from the added test** (R6), and
`packages/architecture-tests`' full suite. A9/A10's mechanism half.

**CP3 — signature verification and the route's negative space, RED first.**
`webhook-signature.test.ts` first — a pure unit suite over valid, malformed (six
shapes), expired-past, expired-future, short-digest, long-digest, non-hex, and
forged-with-wrong-secret, plus R2's different-serialisation case, all with an
injected `now` — then `webhook-signature.ts` to pass it. Then the HTTP layer,
RED first: a test proving the route receives the exact raw request-body bytes
via `req.rawBody` (R1/D-109 — found and fixed mid-checkpoint: the plan's
original module-scoped `express.raw()` design would have silently raced
`main.ts`'s existing global JSON parser and read an already-drained, empty
stream in production; replaced with NestJS's built-in `rawBody: true`
application option, §3.8), plus the HTTP negatives against a real app: 400
malformed, 401 forged, 401 tampered, 401 expired, 404 unknown provider, 413
oversize, 503 secret unset — **each asserting zero `delivery_event` rows and an
unchanged `campaign_recipient.status`**, because "returns 401" is not the rule,
"returns 401 **and writes no state**" is. Then write `provider-registry.ts`,
`webhooks.module.ts` (a plain `@Module`, no middleware), and a controller whose
service still throws on the success path. A4, A5, A6, A15, A16, A17.

**CP4 — parse and apply, RED first.** `parseWebhookEvent`'s unit suite first
(named fields read, unknown keys ignored, hostile `tenantId`/`campaignRecipientId`
keys ignored, unknown type ⇒ `'unknown'`, invalid date ⇒ `null` — D-106), then the
full event-type × current-status grid as a unit test over §3.4b's decision table,
then the integration cases: applied, duplicate replay, out-of-order, illegal
transition, unmatched, ambiguous mapping, hard-bounce suppression + the
second-campaign freeze assertion, complaint suppression, cross-tenant hostility,
and the genuinely concurrent double-POST (`Promise.all`, not sequential). Then
write `webhooks.service.ts`. A2, A3, A7, A8, A9, A10, A11, A12, A13.

**CP5 — progress monotonicity (D-105), RED first.** The RED test drives
`GET /campaigns/{id}/progress` through submit → deliver → bounce and asserts
`sent`, `delivered` and `failed` never decrease while `counts` still sums to
`totalSnapshot` at every step. It must **fail on the current code** — if it
passes, the D-105 claim is wrong and the finding must be re-examined before
anything is changed. Then apply §3.7 to `campaigns.service.ts` and
`ComposeDraftScreen.tsx`, and re-run `campaign-send-http.test.ts` unmodified. A14.

**CP6 — contracts.** §4's OpenAPI additions including the `CampaignProgress`
description change; `pnpm contracts:generate`; `openapi-compat-check`; `redocly
bundle`; confirm `apps/web` compiles against the generated types only (ADR-005).
No AsyncAPI change (DEC-109) — state that in the commit body rather than leaving
its absence to be read as an omission.

**CP7 — deployment contract, VISUAL EVIDENCE and close.** §3.8's four-file env
change together; re-run the deployment smoke test if Docker is available. Capture
A18 at 3 viewports into `evidence/visual/M5-S4-webhook/production/` using the
existing `apps/web/e2e/visual-capture.spec.ts` helper pattern and the
out-of-process fixture pattern (handoff note 3) to seed delivered/bounced states;
**individually inspect every image** — a green Playwright run is not evidence
(D-78, reconfirmed as D-104). Then close `BR-SEND-008` in `traceability.csv` with
real `code_paths`/`test_files`/`migration_files`/`openapi_operation_ids`/
`log_or_metric_or_audit`; flip `BR-SEND-002` from `partially_closed` to `closed`
(its TC-SEND-014 exclusion is now false) and update `BR-CFG-005`'s evidence cell
to retire its `parseWebhookEvent` exclusion; record DEC-107…114 in `EXECPLAN.md`
§20, D-105…108 in §19, and migration 027 in §10 (replacing the placeholder row);
re-run the full suite with **counts compared to CP0's baseline**, plus
`openapi-compat-check`, `redocly bundle`, `validate_plan.py`, and both
`ARCH-MIGRATION` and `ARCH-CSV-SHAPE` standalone (R9); restore the docker stack
(R8); only then flip `M5-S4-webhook-reconciliation` to `completed`.

> `M5-GATE` becomes runnable on that flip, and inherits two things named here:
> **`BR-CFG-002` is still claimed by no open slice** (M5-S3's own handoff note,
> re-verified — this node does not close it and does not pretend to), and
> **TC-SEND-015's monotonic-*percent* half remains M6-S1's** — this node closes
> only its counter-never-decreases half (D-105), which is why BR-SEND-003 is
> untouched in `traceability.csv`.
