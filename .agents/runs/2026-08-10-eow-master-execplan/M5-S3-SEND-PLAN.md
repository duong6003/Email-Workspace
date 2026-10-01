# M5-S3 Send Implementation Plan

> **For agentic workers:** execute this plan checkpoint-by-checkpoint under
> AGENTS.md §2 (evidence precedes status, commit at every checkpoint, compare
> test *and skip* counts against the CP0 baseline). Use
> `superpowers:test-driven-development` (RED before GREEN at every checkpoint)
> and `superpowers:systematic-debugging` on any red. This plan is the spec; do
> not re-derive it from `state.json`.

Node: `M5-S3-send` · Depends on: `M5-S2-schedule` (completed 2026-08-18, commit `7fce921`)
Owns rules: **BR-SEND-001, BR-SEND-002, BR-SEND-006, BR-SEND-007, BR-SEND-010, BR-SEND-011, BR-SEND-012** (7)
Inherits and closes: the deferred send-path half of **BR-CFG-004 / BR-CFG-005** (`partially_closed`, D-75/DEC-074)
Test cases: **TC-SEND-001, -002, -006, -007, -010, -011, -012, -014, -017, -018** (10 of the 19 `TC-SEND-*`; the rest are M6/M5-S4)
Screens: extends `UI-EMAIL-001` (compose) · Overlay: extends `SendConfirmOverlay` (already ported), adds the stop-send confirmation
Reserved: migration **026**, decisions **DEC-096…DEC-105**, defects **D-87…D-92**
Solo execution (no Codex split — same as M4-S2/M4-S3/M4-S4/M5-S2).

---

## 0. Read this before touching anything

Six findings, all verified directly against the working tree at `7fce921`. None
of them is optional context; four of them are pre-existing defects this node is
the first to be able to see.

**(a) The two inherited debts, restated so they are not re-derived.**
`state.json`'s `M5-S3-send.nextAction` names both:

1. `BR-CFG-004` / `BR-CFG-005` are `partially_closed` (D-75, DEC-074). The
   worker/send-path half was deferred here. Verified still true: `grep -rn
   "sending_policy\|SendingPolicy\|defaultSenderConfigId" apps/worker` returns
   **zero hits**.
2. **Nothing consumes `queued`.** `sendCampaign` (M4-S4) and the dispatcher's
   claim (M5-S2, `campaign-dispatcher.ts:127-134`) both land a campaign in
   `queued` and stop. This node builds the DAG that picks it up. Until it does,
   `queued` is a terminal state in practice — deliberately visible, per DEC-081.

**(b) `worker/main.ts`'s `campaign-execution` worker is five literal stubs, and
one of them fabricates a snapshot id.** `apps/worker/src/main.ts:13-19`:

```ts
case 'validate':   return {valid:true};
case 'snapshot':   return {snapshotId:crypto.randomUUID()};
case 'send-batch': await job.updateProgress(100); return {sent:...length};
case 'aggregate':  return {reconciled:true};
case 'notify':     return {notificationCreated:true};
```

`validate` claims validity without reading anything; `snapshot` invents a UUID
that corresponds to no row; `send-batch` reports `sent: n` having sent nothing
and sets progress to 100%. These are the exact five DAG nodes this node's
success condition names, and every one of them currently reports success it did
not earn. This is the same class of defect as D-42/D-69 and must be recorded as
a defect in its own right, not quietly overwritten. **Record as D-87.**

**(c) `campaign_recipient.status` has no vocabulary, no CHECK, and today makes
BR-SEND-002's own acceptance arithmetically false.** `001_initial.sql:71`
declares `status text NOT NULL DEFAULT 'queued'` with no constraint. M4-S4's
freeze (`campaign-snapshot.ts:177`) writes `status: 'queued'` for **every**
frozen row — including rows with `eligibility = 'skipped'`. BR-SEND-002 requires
eight values (`pending, queued, submitted, delivered, bounced, failed, skipped,
cancelled`) and requires that "counts by status sum to `total_snapshot`". Today
they sum to `total_snapshot` only by collapsing skipped recipients into
`queued`, which is the one thing the rule exists to prevent. **Record as D-88.**
Fixed by 026 (§3.1) plus the freeze correction in §3.2.

**(d) Existing tests write `campaign_recipient.status` values that are not in
the vocabulary, so adding the CHECK will turn them red — and that is correct.**
Four call sites, all verified:

| File | Line | Value written |
|---|---|---|
| `apps/api/test/integration/campaign-snapshot-immutability.test.ts` | 259 | `'sending'` |
| `apps/api/test/integration/campaign-snapshot-immutability.test.ts` | 262 | `'sending'` |
| `apps/api/test/integration/campaign-snapshot-immutability.test.ts` | 340, 553 | `'sent'` |
| `apps/api/test/integration/recipients.test.ts` | 250-256 | `'sent'` |

Neither `sending` nor `sent` is a message state in BR-SEND-002 — they are
*campaign* states borrowed by tests written when the column had no vocabulary at
all. Updating those four literals to `'submitted'` is a **fixture correction**,
not a weakened assertion: each of those tests asserts that the status column
*remains writable* while the frozen columns are locked, and `'submitted'` proves
that identically. This is disclosed here in advance precisely so it is not
mistaken at CP1 for "editing a test to make it pass" (AGENTS.md §5).
**Record as D-89.**

**(e) Neither `sender_config` nor `sending_policy` carries a rate limit, so
BR-SEND-007 has nothing to obey.** `EXECPLAN.md` §10 planned `sender_accounts
(…, rate_limit)`, but the migration M5-S1 actually shipped
(`020_sender_config.sql`) has no such column, and `sending_policy` has only
`default_sender_config_id` and `reply_to`. Verified by reading 020 in full. So
"the worker honours the sending policy" — the exact clause deferred from
`BR-CFG-004/005` — is currently unimplementable in both directions: the worker
does not read the policy, *and* the policy has no send-shaping fields to read.
026 adds them (§3.1). **Record as D-90.**

**(f) `EnvSecretStore` cannot deliver a secret to the worker, because the worker
is a different process.** `apps/api/src/sender-config/secret-store.ts:7-11` is a
per-instance `Map` with a `process.env[reference]` fallback. `put()` writes only
to the API process's heap. Therefore the send path can resolve a sender secret
**only** when `secret_ref` names a real environment variable in the worker's own
environment. This is a genuine architectural boundary, not a bug to paper over:
§3.6 makes an unresolvable secret a **validate-node failure with an explicit
error code**, so a campaign never silently sends unauthenticated. The local
Mailpit path is unaffected (`username` is empty ⇒ nodemailer sends no `AUTH`).
**Record as D-91 and DEC-100.**

**(g) `SmtpProviderAdapter.send()` throws `SENDING_DEFERRED_TO_M5_S3`**
(`smtp-provider.adapter.ts:10`) and `getCampaignProgress` is still M4-S1's
in-memory mock returning fabricated counts *and a fabricated ETA*
(`campaigns.service.ts:399-400`: `total:1250, queued:530, sent:700,
delivered:682, failed:20, eta: now+8min` for any campaign id, including one that
does not exist). Both are this node's to replace. The ETA specifically must
become `null`, not a smaller lie: BR-SEND-005 (ETA) is M6's, so this node has no
basis to compute one. **Record as D-92.**

**Migration numbering:** `019` was never used; `025` is the highest applied.
**This node takes 026.**

---

## 1. What this slice turns from definition into fact

M4-S4 made a campaign's audience stop being a query and become a fixed set of
rows. M5-S2 made a campaign acquire a future, and a dispatcher that claims it
exactly once. Both stop at `queued`. **This slice is the moment an email
actually leaves the building** — and, equally, the moment the system acquires a
defensible answer to "how many were sent, how many failed, and can I prove no
one got two copies".

### The seven rules, in their own words

| Rule | What it actually requires | P |
|------|---------------------------|---|
| BR-SEND-001 | Campaign execution moves through `queued, validating, sending, paused, completed, partial_failed, failed, cancelled`. A transition outside the machine returns **409**; every transition carries a timestamp and an actor or system reason. | P0 |
| BR-SEND-002 | Every campaign recipient is in exactly one of `pending, queued, submitted, delivered, bounced, failed, skipped, cancelled`. Counts per status **sum to `total_snapshot`**, and no event is counted twice. | P0 |
| BR-SEND-006 | Transient errors retry with exponential backoff **plus jitter**; permanent errors never retry. Default max 5 attempts; every attempt records the provider response and a `next_retry_at`. | P0 |
| BR-SEND-007 | The worker obeys tenant / sender / provider rate limits and the daily quota. Nothing exceeds the configured rate, **waiting messages are never lost**, and a provider `429` is retried according to `Retry-After`. | P0 |
| BR-SEND-010 | Cancelling mid-send stops what has not gone out and marks it `cancelled`; already-submitted messages keep receiving delivery events. Final counts **distinguish sent from cancelled**, and the UI warns that sent email cannot be recalled. | P1 |
| BR-SEND-011 | A hard bounce or complaint updates recipient suppression so later campaigns skip that person. The suppression is created **atomically with the event**, and the current campaign does not retry a permanent error. | P0 |
| BR-SEND-012 | A message is rendered from the **snapshot** template and merge data; the worker never reads live recipient data. A retry for the same recipient produces logically identical content, and a `content_hash` is stored. | P0 |

The binding sentence for this node, in the same shape M4-S4 and M5-S2 each had
one:

> **PostgreSQL is the only authority on which recipients are still owed a send,
> and the claim that flips a batch of them out of `pending` is a single atomic
> SQL statement.**

Everything hard about this node collapses onto that sentence. Exactly-once
delivery is that claim's `WHERE status = 'pending'` guard. Crash recovery is the
absence of any in-memory work list to lose. A duplicate job is a claim that
matches zero rows. Rate limiting can throttle freely without losing work,
because unsent rows simply stay `pending` in the database rather than living in
a queue. A design where BullMQ holds the authoritative list of who still needs
an email is the same defect class ADR-012 and AGENTS.md §2 exist to prevent —
here applied to the queue rather than to the socket, exactly as M5-S2 §1 argued
for the dispatcher.

### Hard non-goals

- **No webhooks.** `BR-SEND-008` and the `delivered`/`bounced` message states
  reachable only from a provider callback are `M5-S4-webhook-reconciliation`'s.
  This node writes the two states it can observe synchronously (`submitted`,
  `failed`) and leaves `delivered`/`bounced` legal-but-unreached in the
  vocabulary, the same deliberately-visible boundary DEC-081 drew around
  `queued`. **DEC-096.**
- **No progress percentage, no ETA, no realtime.** `BR-SEND-003/004/005` are
  M6-S1's. `getCampaignProgress` returns real *counts* here (BR-SEND-002's own
  evidence surface) and `eta: null` — see D-92. This node writes the
  `campaign.execution_state_changed` **outbox row**, which is the durable record
  M6-S1 will relay, exactly as M4-S4 did with `campaign.snapshot_frozen` and
  M5-S2 with `schedule.state_changed`, both before their consumers existed.
- **No pause/resume.** `BR-SEND-009` is M6-S1's. `paused` stays in the campaign
  status vocabulary (018 already admits it) but **this node's transition
  allow-list contains no edge into or out of it**, so an attempted pause is a
  409 from the state machine rather than a silently accepted no-op. M6 adds the
  edge; it does not need to add the state. **DEC-097.**
- **No quota ledger.** `BR-CFG-006` is M7-S1's. BR-SEND-007's "quota ngày" is
  implemented as a **configured per-sender daily ceiling** enforced by counting
  this tenant's own `message_attempt` rows in the current UTC day — not as a
  consumable reservation, and not as a cross-feature quota system. The
  distinction is recorded in the response shape and in `traceability.csv`, not
  papered over. **DEC-098.**
- **No history surface.** `UI-HIS-001`/`UI-HIS-002` are `not_inventoried` and
  owned by M6-S3. This node's web surface is confined to the compose screen's
  existing frozen banner plus the stop-send confirmation BR-SEND-010's
  acceptance requires.
- **No observability dashboard.** `BR-SEND-013` is M7-S3's. This node emits the
  `correlation_id` that dashboard will need (it is a column on
  `campaign_execution`, §3.1) and asserts by test that no log line or audit
  metadata contains a secret or a full message body — but builds no dashboard.

---

## 2. Acceptance criteria

| # | Criterion | Rule | Test case | Proof layer |
|---|-----------|------|-----------|-------------|
| A1 | `campaign_recipient.status` accepts exactly the eight BR-SEND-002 values and rejects a ninth with `23514`; the 026 backfill leaves every `eligibility='skipped'` row at `status='skipped'` | BR-SEND-002 | TC-SEND-002 | migration + integration |
| A2 | For a freshly frozen campaign, `SUM(count per status) = campaign_snapshot.total_snapshot` — asserted after freeze, after partition, after send, and after aggregate, not once at the end | BR-SEND-002 | TC-SEND-002 | integration |
| A3 | The transition table refuses every edge not in §3.3's allow-list with **409** and a code naming the attempted edge; each accepted transition writes an `audit_log` row carrying `actorId` (or `null` + `systemReason`) and a timestamp | BR-SEND-001 | TC-SEND-001 | unit + integration |
| A4 | `validate` moves `queued → validating`, and on a blocking failure moves `validating → failed` **without sending anything**, per blocking cause asserted separately: no live snapshot, sender missing, sender disabled, sender secret unresolvable | BR-SEND-001, BR-CFG-004 | TC-SEND-001 | integration |
| A5 | `freeze` binds the execution to one snapshot: a second `campaign_execution` insert for the same `(campaign_id, snapshot_id)` violates the unique index, and re-running the node returns the **same** execution id rather than creating a second row | BR-SEND-001 | TC-SEND-018 | integration |
| A6 | `partition` claims only `eligibility='sendable' AND status='pending'` rows, assigns dense `batch_no` by `ORDER BY id`, and re-running it claims **zero** additional rows — proven by running it twice and comparing row counts, not by trusting the first result | BR-SEND-002 | TC-SEND-018 | integration |
| A7 | `send` submits every sendable recipient to Mailpit exactly once; the Mailpit HTTP API reports `sendable_count` messages, each recipient's `status='submitted'` with a non-null `provider_message_id`, and a second run of the same batch submits **nothing further** | BR-SEND-001, BR-SEND-002 | TC-SEND-018 | integration (real SMTP) |
| A8 | Suppressed recipients (`subscription_status IN ('unsubscribed','bounced')`) and duplicates are never submitted: the frozen set already excludes them with a `skipped_reason`, and the send node's claim additionally cannot reach them because they are not `eligibility='sendable'` | BR-SEND-011 | TC-SEND-011 | integration |
| A9 | A transient provider error schedules a retry at `next_retry_at` following `base * 2^(attempt-1)` capped, **with jitter inside a bounded band**, records the provider response on a `message_attempt` row, and stops at `max_attempts` with the recipient `failed` | BR-SEND-006 | TC-SEND-006 | unit (backoff fn) + integration |
| A10 | A permanent provider error (5.x.x) is **never** retried: attempt 1 is the only `message_attempt` row, the recipient is `failed`, and `next_retry_at` is null | BR-SEND-006, BR-SEND-011 | TC-SEND-006, TC-SEND-011 | integration |
| A11 | A permanent *hard-bounce* class error additionally suppresses the recipient in the **same transaction** as the attempt row: `recipient.subscription_status='bounced'`, `suppressed_at` set, `suppression_reason='hard_bounce'`; a subsequent campaign freeze skips them with `skipped_reason='status_bounced'` | BR-SEND-011 | TC-SEND-011 | integration |
| A12 | A provider `429` carrying `Retry-After: 30` produces `next_retry_at ≥ attempted_at + 30s` and **no** attempt before it; the backoff formula does not override the header | BR-SEND-006, BR-SEND-007 | TC-SEND-017 | integration |
| A13 | With `sender_config.rate_limit_per_minute = N`, a batch of `> N` recipients submits at most `N` in the window and leaves the remainder at `status='queued'` in PostgreSQL — **nothing lost**, and the next window drains them | BR-SEND-007, BR-CFG-005 | TC-SEND-007 | integration (real Redis) |
| A14 | The per-sender daily ceiling refuses further submissions once reached and the execution lands in `partial_failed` rather than claiming completion | BR-SEND-007 | TC-SEND-007 | integration |
| A15 | Killing the worker mid-batch (after the claim, before the attempt row) and re-running produces **no duplicate submission**: total Mailpit messages equal `sendable_count`, and the orphaned `queued` rows are reclaimed by the stale-claim sweep | BR-SEND-006, BR-SEC-005 | TC-SEND-018 | integration (recovery) |
| A16 | Delivering the same DAG job twice concurrently produces one execution, one claim per recipient and one submission per recipient — genuinely concurrent, not sequential | BR-SEND-001, BR-SEND-002 | TC-SEND-014, TC-SEND-018 | integration (real PostgreSQL, concurrent) |
| A17 | A retry for the same recipient after the **live `recipient` row has been mutated** produces an identical `content_hash` — the worker demonstrably reads `email_snapshot`, not the live row | BR-SEND-012 | TC-SEND-012 | integration |
| A18 | `POST /campaigns/{id}/send/cancel` while `sending` moves the campaign to `cancelled`, flips every `pending` recipient to `cancelled`, leaves `submitted` rows untouched, and the final counts report sent and cancelled as **separate** numbers | BR-SEND-010 | TC-SEND-010 | integration |
| A19 | `GET /campaigns/{id}/progress` returns real per-status counts summing to `total_snapshot`, `eta: null`, and **404** for a campaign that does not exist (today it returns fabricated counts for any id — D-92) | BR-SEND-002 | TC-SEND-002 | integration |
| A20 | Cross-tenant: a `queued` campaign in tenant B is neither claimable, sendable, cancellable nor readable from tenant A, and the worker's own scan connection cannot read tenant rows outside a tenant transaction | domain invariant | — | integration |
| A21 | No `audit_log` metadata, notification body, outbox payload or log line emitted by this node contains an SMTP secret, a `secret_ref` value, or a full rendered message body | BR-SEC-003, BR-SEND-013 (partial) | TC-SEND-013 (partial) | integration |
| A22 | The compose screen shows the `sending` / `completed` / `partial_failed` states with real counts, and the stop-send confirmation states in plain language that already-sent email cannot be recalled | BR-SEND-010 | TC-SEND-010 | e2e + visual |

---

## 3. Locked design

### 3.1 Migration 026 — `026_campaign_execution.sql`

Forward-only. Touches no published migration. Applied via
`docker compose run --rm migrate`, lock entry added, `ARCH-MIGRATION` re-run
standalone.

```sql
-- M5-S3 -- the send pipeline's own state. EXECPLAN SS10 reserved
-- `campaign_executions`/`message_attempts` for this node; both are named in the
-- singular here to match every other table in this schema (campaign,
-- campaign_snapshot, campaign_recipient, sender_config, outbox_event).

-- ---------------------------------------------------------------------------
-- (1) BR-SEND-002's vocabulary. D-88: the column has had no CHECK since 001 and
-- M4-S4's freeze wrote 'queued' even for skipped rows, so the rule's own
-- "counts sum to total_snapshot" was true only by collapsing two facts into one
-- value. Backfill first, constrain second.
-- ---------------------------------------------------------------------------
UPDATE campaign_recipient SET status = 'skipped' WHERE eligibility = 'skipped';
UPDATE campaign_recipient SET status = 'pending'
  WHERE eligibility = 'sendable' AND status = 'queued';

ALTER TABLE campaign_recipient
  ADD CONSTRAINT campaign_recipient_status_known CHECK (status IN (
    'pending', 'queued', 'submitted', 'delivered', 'bounced', 'failed', 'skipped', 'cancelled'
  )),
  ADD CONSTRAINT campaign_recipient_skipped_status_agrees CHECK (
    (eligibility = 'skipped' AND status = 'skipped')
    OR (eligibility = 'sendable' AND status <> 'skipped')
  );

ALTER TABLE campaign_recipient
  ADD COLUMN IF NOT EXISTS execution_id uuid,
  ADD COLUMN IF NOT EXISTS batch_no integer,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD CONSTRAINT campaign_recipient_attempt_count_nonnegative
    CHECK (attempt_count >= 0);

-- The partition/send claim's index. Partial: only rows still owed work.
CREATE INDEX IF NOT EXISTS idx_campaign_recipient_sendable_pending
  ON campaign_recipient (tenant_id, campaign_id, id)
  WHERE eligibility = 'sendable' AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_campaign_recipient_retry_due
  ON campaign_recipient (next_retry_at)
  WHERE status = 'queued';

-- ---------------------------------------------------------------------------
-- (2) The execution. One row per (campaign, snapshot) -- the unique index IS
-- the DAG's idempotency key (SS3.3, A5): re-running `freeze` for the same
-- snapshot cannot create a second execution, so no distributed lock is needed.
-- ---------------------------------------------------------------------------
CREATE TABLE campaign_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  campaign_id uuid NOT NULL REFERENCES campaign(id),
  snapshot_id uuid NOT NULL REFERENCES campaign_snapshot(id),
  status text NOT NULL DEFAULT 'validating' CHECK (status IN (
    'validating', 'sending', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled'
  )),
  correlation_id text NOT NULL,
  batch_size integer NOT NULL DEFAULT 100 CHECK (batch_size BETWEEN 1 AND 5000),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  sender_config_id uuid REFERENCES sender_config(id),
  failure_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (campaign_id, snapshot_id)
);
CREATE INDEX idx_campaign_execution_active
  ON campaign_execution (tenant_id, status, started_at DESC);

-- ---------------------------------------------------------------------------
-- (3) BR-SEND-006's "every attempt has a provider response and next_retry_at".
-- One row per attempt, never updated -- an append-only attempt log is what makes
-- "no duplicate counting" (BR-SEND-002) checkable rather than asserted.
-- ---------------------------------------------------------------------------
CREATE TABLE message_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  execution_id uuid NOT NULL REFERENCES campaign_execution(id),
  campaign_recipient_id uuid NOT NULL REFERENCES campaign_recipient(id),
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  outcome text NOT NULL CHECK (outcome IN ('submitted', 'transient_error', 'permanent_error')),
  provider_message_id text,
  error_code text,
  error_class text CHECK (error_class IN ('transient', 'permanent', 'auth', 'config')),
  provider_response text,
  retry_after_seconds integer CHECK (retry_after_seconds IS NULL OR retry_after_seconds >= 0),
  next_retry_at timestamptz,
  content_hash text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_recipient_id, attempt_no)
);
CREATE INDEX idx_message_attempt_execution ON message_attempt (tenant_id, execution_id, attempted_at);
-- BR-SEND-007's daily ceiling counts submissions, not attempts.
CREATE INDEX idx_message_attempt_daily_rate
  ON message_attempt (tenant_id, execution_id, attempted_at)
  WHERE outcome = 'submitted';

-- ---------------------------------------------------------------------------
-- (4) D-90: the send-shaping fields BR-SEND-007 and BR-CFG-004/005 need and
-- 020 never shipped. Defaults are deliberately conservative -- a tenant that
-- has configured nothing must not be given an unlimited send rate.
-- ---------------------------------------------------------------------------
ALTER TABLE sender_config
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS daily_send_limit integer,
  ADD CONSTRAINT sender_config_rate_limit_positive CHECK (rate_limit_per_minute > 0),
  ADD CONSTRAINT sender_config_daily_limit_positive
    CHECK (daily_send_limit IS NULL OR daily_send_limit > 0);

ALTER TABLE sending_policy
  ADD COLUMN IF NOT EXISTS batch_size integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS tenant_rate_limit_per_minute integer NOT NULL DEFAULT 600,
  ADD CONSTRAINT sending_policy_batch_size_bounded CHECK (batch_size BETWEEN 1 AND 5000),
  ADD CONSTRAINT sending_policy_max_attempts_bounded CHECK (max_attempts BETWEEN 1 AND 20),
  ADD CONSTRAINT sending_policy_tenant_rate_positive CHECK (tenant_rate_limit_per_minute > 0);

-- ---------------------------------------------------------------------------
-- (5) BR-SEND-011's suppression, on the table that already governs future
-- eligibility. 006 published subscription_status IN
-- ('active','paused','unsubscribed','bounced') and M4-S2's resolver already
-- skips 'bounced' with skipped_reason='status_bounced' -- so suppression needs
-- no new exclusion path, only a durable record of why and when.
-- ---------------------------------------------------------------------------
ALTER TABLE recipient
  ADD COLUMN IF NOT EXISTS suppressed_at timestamptz,
  ADD COLUMN IF NOT EXISTS suppression_reason text,
  ADD CONSTRAINT recipient_suppression_reason_known CHECK (
    suppression_reason IS NULL
    OR suppression_reason IN ('hard_bounce', 'complaint')
  ),
  ADD CONSTRAINT recipient_suppression_complete CHECK (
    (suppressed_at IS NULL AND suppression_reason IS NULL)
    OR (suppressed_at IS NOT NULL AND suppression_reason IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- (6) The worker's cross-tenant scan, in the exact narrow shape 013 and 025
-- already established: a fixed SECURITY DEFINER function returning nothing but
-- the two ids the scan needs, so the worker stays eow_app/NOBYPASSRLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION queued_campaign_executions(p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT campaign.id, campaign.tenant_id
  FROM campaign
  WHERE campaign.status IN ('queued', 'validating', 'sending')
    AND campaign.deleted_at IS NULL
  ORDER BY campaign.updated_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION queued_campaign_executions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queued_campaign_executions(integer) TO eow_app;

GRANT SELECT, INSERT, UPDATE ON TABLE campaign_execution TO eow_app;
GRANT SELECT, INSERT ON TABLE message_attempt TO eow_app;
ALTER TABLE campaign_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_execution FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_execution_tenant_isolation ON campaign_execution
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE message_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY message_attempt_tenant_isolation ON message_attempt
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
```

Two constraints deserve their justification in writing:

`campaign_recipient_skipped_status_agrees` is what makes D-88 impossible to
reintroduce. Without it, a future freeze could again write `status='queued'` on
a skipped row and BR-SEND-002's arithmetic would silently go wrong again — the
exact "invisible to the workspace check" failure mode AGENTS.md §5 asks the
architecture tests to catch, expressed here as a database constraint because the
database is where it can be made unrepresentable.

`UNIQUE (campaign_recipient_id, attempt_no)` plus never updating a
`message_attempt` row is what makes "no double counting" a *query* rather than a
belief. Counting submissions is `COUNT(*) WHERE outcome='submitted'`, and the
unique index guarantees a retried job cannot inflate it. **DEC-099.**

### 3.2 The freeze correction

`campaign-snapshot.ts:177` currently writes `status: 'queued'` for every row.
It becomes:

```ts
status: row.eligibility === 'skipped' ? 'skipped' : 'pending',
```

`pending` — not `queued` — because in BR-SEND-002's vocabulary `queued` means
*claimed by the send pipeline*, and a frozen-but-undispatched recipient has not
been. This is a behaviour change to a closed node's code (M4-S4), so it is
recorded as a decision rather than made silently, and CP1 re-runs M4-S4's
`campaign-snapshot-freeze.test.ts`, `campaign-snapshot-immutability.test.ts` and
`campaign-snapshot-post-freeze.test.ts`. Those three suites assert
`campaign.status`, snapshot counts and column-level immutability; none asserts a
`campaign_recipient.status` literal except the four fixture writes in §0(d).
**DEC-101.**

### 3.3 The state machines (BR-SEND-001)

Two machines, one file: `apps/api/src/campaigns/send-state-machine.ts`, imported
by both the API and the worker so there is exactly one allow-list.

**Campaign-level** (the only edges this node implements):

| From | To | Trigger | Reason recorded |
|---|---|---|---|
| `queued` | `validating` | DAG `validate` starts | system |
| `validating` | `sending` | DAG `partition` claimed ≥ 1 row | system |
| `validating` | `failed` | blocking validation failure | system + `failure_code` |
| `validating` | `completed` | zero sendable recipients | system |
| `sending` | `completed` | aggregate: all actionable terminal, none failed | system |
| `sending` | `partial_failed` | aggregate: all terminal, ≥ 1 failed | system |
| `sending` | `failed` | aggregate: all actionable failed | system |
| `sending` | `cancelled` | `POST /send/cancel` | actor + reason |

Every other edge is `409 ILLEGAL_TRANSITION` naming `from` and `to`. `paused`
has **no edge in either direction** — DEC-097. The function is pure and
unit-tested exhaustively over the full 12 × 12 grid, so "transition outside the
machine returns 409" is proven by enumeration rather than by three examples.

**Message-level** (`campaign_recipient.status`):

```
pending ──claim──> queued ──submit ok──> submitted ──(M5-S4 webhook)──> delivered | bounced
   │                  │
   │                  ├──transient, attempts < max──> queued (with next_retry_at)
   │                  └──permanent, or attempts = max──> failed
   ├──cancel──> cancelled
   └──(frozen skipped)──> skipped   [terminal, set at freeze, never re-entered]
```

`skipped` is entered only by the freeze and is terminal; `delivered`/`bounced`
are legal but unreachable until M5-S4 (DEC-096).

### 3.4 The DAG — five nodes, every one idempotent

Replaces `worker/main.ts`'s five stubs (D-87). New file
`apps/worker/src/campaign-send/` with one module per node plus a `run.ts`
orchestrator. Each node is re-runnable; the orchestrator therefore needs no
checkpoint of its own.

| Node | What it does | Why re-running is a no-op |
|---|---|---|
| `validate` | Loads campaign + live snapshot + sender config; resolves the secret (§3.6); `queued → validating`, or `validating → failed` with a `failure_code` | The transition's own `WHERE status = 'queued'` matches zero rows the second time |
| `freeze` | `INSERT INTO campaign_execution … ON CONFLICT (campaign_id, snapshot_id) DO NOTHING`, then `SELECT` the row | The unique index (§3.1) is the idempotency key; the second insert conflicts and the select returns the same id (A5) |
| `partition` | One statement claims a batch: `UPDATE campaign_recipient SET status='queued', execution_id=$1, batch_no=$2, claimed_at=now() WHERE tenant_id=$3 AND campaign_id=$4 AND eligibility='sendable' AND status='pending' AND id IN (SELECT id … ORDER BY id LIMIT $5)` | `status='pending'` is the guard; an already-claimed row cannot match (A6, A16) |
| `send` | Per claimed row: render nothing (already frozen), compute `content_hash`, check rate limit (§3.5), submit via the provider adapter, then in **one transaction** write the `message_attempt` row and the new recipient status | `UNIQUE (campaign_recipient_id, attempt_no)` refuses a duplicate attempt; the status update's own `WHERE status='queued'` refuses a second transition |
| `aggregate` | Recomputes counts by `GROUP BY status`, asserts they sum to `total_snapshot`, sets the terminal campaign status per §3.3, writes the outbox row and the audit row | Terminal transitions are guarded by `WHERE status='sending'`; the outbox insert uses the existing `ON CONFLICT … DO NOTHING` on `(aggregate_type, aggregate_id, aggregate_version, event_type)` |

**What triggers the DAG.** The periodic `queued_campaign_executions()` scan
(§3.1) is the *sole* trigger, running on the same repeatable-job cadence as
M5-S2's `campaign-misfire-scan`. No BullMQ accelerator is added: M5-S2 needed
one because a schedule can be hours away, but a `queued` campaign is due
immediately, so an accelerator would buy only sub-scan-interval latency at the
cost of a second code path that could dispatch. Latency is therefore bounded by
the scan interval and stated as such, not claimed to be lower. **DEC-102.**

**The stale-claim sweep** (A15). A worker killed between the `partition` claim
and the `message_attempt` write leaves rows at `status='queued'` with
`attempt_count` unchanged and no attempt row. The `send` node's own claim
reclaims them: `WHERE status='queued' AND (next_retry_at IS NULL OR
next_retry_at <= now()) AND claimed_at < now() - interval '5 minutes'`. This is
safe precisely because the provider submission happens *outside* the transaction
that records it (the DEC-051 reserve→send→record precedent from M3-S3): a crash
after submission but before recording is the one window that can duplicate, and
it is closed by the deterministic SMTP `Message-ID` in §3.6.

### 3.5 Rate limiting (BR-SEND-007)

Three ceilings, checked in this order before each individual submission:

1. **Per sender**, `sender_config.rate_limit_per_minute`
2. **Per tenant**, `sending_policy.tenant_rate_limit_per_minute`
3. **Per sender per day**, `sender_config.daily_send_limit` (nullable = no limit)

The first two are Redis counters — the worker already holds an `ioredis`
connection (`main.ts:9`), and a counter shared across replicas is the only
correct place for a limit that must hold across them:

```ts
const key = `eow:rate:${scope}:${id}:${Math.floor(nowMs / 60_000)}`;
const used = await redis.incr(key);
if (used === 1) await redis.expire(key, 120);
if (used > limit) { /* over budget this minute */ }
```

The third is a PostgreSQL count over `message_attempt` for the current UTC day
(`idx_message_attempt_daily_rate`), because a daily figure must survive a Redis
flush and is read once per batch, not once per message.

**Over budget is not an error.** The batch stops, the remaining claimed rows keep
`status='queued'` with `next_retry_at` set to the next minute boundary, and the
scan picks them up. Nothing is lost, which is BR-SEND-007's own acceptance
clause, and it holds because PostgreSQL — not the queue — owns the work list
(§1's binding sentence). Redis being unavailable **fails the batch closed**
(no submission), never open. **DEC-103.**

### 3.6 Sending, determinism and secrets

`SmtpProviderAdapter.send()` (currently `throw new
Error('SENDING_DEFERRED_TO_M5_S3')`) is implemented against the message shape:

```ts
export type ProviderMessage = {
  from: { name: string; email: string };
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;      // deterministic -- see below
  headers: Record<string, string>;
};
export type ProviderSendResult = { providerMessageId: string };   // unchanged
```

**Determinism (BR-SEND-012).** The worker reads `campaign_recipient.
email_snapshot` and `merge_data_json` and **never** joins `recipient` for
content. `content_hash = sha256(subject + '\n' + html + '\n' + textBody)`, hex,
stored on both the recipient row and every attempt row. A17 proves the rule by
mutating the live `recipient` row between attempt 1 and attempt 2 and asserting
the hashes match — a test that passes only if no live read exists.

**The deterministic `Message-ID`** is
`<{campaignRecipientId}.{executionId}@{fromEmailDomain}>`. It does not vary by
attempt, so a re-submitted message after a crash-before-record is
provider-side-identifiable rather than a silent second email, which is what
makes A15's "no duplicate" claim testable at the Mailpit API instead of merely
argued. **DEC-104.**

**Secrets (D-91).** The worker resolves `sender_config.secret_ref` from
`process.env[secret_ref]` only. If `username` is non-empty and the variable is
absent, `validate` fails the execution with
`failure_code = 'SENDER_SECRET_UNRESOLVED'` and sends nothing — it never falls
back to an unauthenticated connection. Empty `username` (the Mailpit local case)
needs no secret and is not an error. The `secret_ref` **name** may appear in a
failure code; its **value** may never appear in a log, audit row, notification
or outbox payload, asserted by A21. **DEC-100.**

**Error classification** reuses `SmtpProviderAdapter.classifyError` and extends
it for the send path: SMTP `4xx` → `transient`; `5xx` → `permanent`; `5.1.1` /
`5.1.10` / `550` mailbox-unknown → `permanent` **and hard-bounce**, which is the
one class that triggers suppression (§3.7); a `429`-equivalent with
`Retry-After` → `transient` with `retry_after_seconds` honoured verbatim.

**Backoff (BR-SEND-006)**, pure function, unit-tested:

```ts
export function nextRetryDelayMs(attemptNo: number, opts = { baseMs: 30_000, capMs: 900_000 }, rand = Math.random): number {
  const exponential = Math.min(opts.baseMs * 2 ** (attemptNo - 1), opts.capMs);
  return Math.round(exponential * (0.5 + rand() * 0.5));   // full-band jitter, never below half
}
```

Injecting `rand` is what makes A9's "jitter inside a bounded band" assertable
without a flaky test: the unit test pins `rand` to 0 and 1 and asserts the band;
the integration test asserts only `next_retry_at > attempted_at`.

### 3.7 Suppression (BR-SEND-011)

`suppressRecipient(client, tenantId, recipientId, reason)` sets
`subscription_status='bounced'`, `suppressed_at=now()`,
`suppression_reason=$reason` and writes the audit row — **inside the same
transaction** as the `message_attempt` insert and the recipient status update.
That atomicity is the rule's own acceptance clause.

M4-S2's resolver already excludes `subscription_status='bounced'` with
`skipped_reason='status_bounced'`, so no new exclusion path is needed; A11 proves
the end-to-end effect by freezing a *second* campaign afterwards and asserting
the person is skipped for that reason.

BR-SEND-011's other source — a provider webhook carrying a bounce or complaint —
is M5-S4's. It will call this same function rather than growing a second
suppression path. This node therefore closes the rule on the synchronous SMTP
path it can actually observe and **records the webhook caller as M5-S4's
addition**, which is a genuine closure of the mechanism, not a deferral dressed
as one. **DEC-105.**

### 3.8 Web surface

Minimal by design (§1 non-goals). Three changes, all on the existing compose
screen and its already-ported `SendConfirmOverlay`:

1. The frozen banner gains `sending` / `completed` / `partial_failed` states
   rendering real counts from `getCampaignProgress`.
2. A **stop-send** action, visible only while `sending`, opening a confirmation
   whose copy states plainly that email already sent cannot be recalled
   (BR-SEND-010's acceptance, Vietnamese copy matching the handoff's register).
3. `apps/web/src/api/campaigns.ts` gains `getCampaignProgress` and
   `cancelCampaignSend`, following the `scheduleCampaign` /
   `cancelCampaignSchedule` precedent at lines 190-197.

---

## 4. HTTP surface

| Method | Path | operationId | Permission | Returns |
|--------|------|-------------|------------|---------|
| POST | `/campaigns/{campaignId}/send/cancel` | `cancelCampaignSend` | `campaign:manage` | 202 `CampaignSendCancelAccepted` |
| GET | `/campaigns/{campaignId}/progress` | `getCampaignProgress` | `campaign:read` | 200 `CampaignProgress` (**replaces the mock**) |

`POST /send/cancel` is a **separate route** from M4-S4's `POST /cancel` and
M5-S2's `POST /schedule/cancel`, for the reason DEC-091 already established for
the latter: the three have different legal source states (`sending`, `queued`,
`scheduled`) and different terminal states (`cancelled`, `draft`, `cancelled`),
and overloading one route would make the 409 messages unreadable and hide which
rule refused. It carries `CsrfGuard` and requires `Idempotency-Key`, matching
`sendCampaign`'s precedent at `campaigns.controller.ts:71-73`.

Schema changes, all additive except one disclosed narrowing:

```yaml
CampaignSendCancelAccepted:
  {campaignId, executionId, status, submittedCount, cancelledCount, cancelledAt}

CampaignProgress:                      # additive on the existing schema
  properties:
    counts:                            # NEW -- BR-SEND-002's eight states, in full
      required: [pending, queued, submitted, delivered, bounced, failed, skipped, cancelled]
    totalSnapshot: {type: integer}     # NEW -- what counts must sum to
    executionId:   {type: [string, 'null'], format: uuid}   # NEW
    eta:           {type: 'null'}      # NARROWED -- see below
```

`eta` narrows from `[string, 'null']` to `null`. `openapi-compat-check` will
flag it; the written justification is D-92 — the only value that field has ever
returned is a fabricated `now + 8 minutes` from an unimplemented mock, no client
consumes it, and BR-SEND-005 (the rule that would define it) is M6-S1's. Emitting
a smaller lie would be worse than emitting `null`. This is the same
never-implemented argument M4-S3 §3.1, M4-S4 §4 and M5-S2 §4 each made in writing
rather than silently past the check.

`contracts/asyncapi.yaml` gains `campaign.execution_state_changed`
(`campaign` channel, payload `{executionId, status, counts}`) alongside the
existing `schedule.state_changed`. No consumer exists until M6-S1; the outbox row
is the durable record, per §1's non-goals.

---

## 5. Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | The `status` CHECK in 026 turns four existing M4-S4/M2-S1 fixture writes red (§0(d)), and the cheap wrong response is to widen the CHECK to admit `'sent'`/`'sending'` so the tests pass | The CHECK is BR-SEND-002's literal vocabulary and is not negotiable. CP1 updates the four fixture literals to `'submitted'` and re-runs those suites **otherwise unmodified**. If any assertion beyond the literal needs changing, that is a behaviour change requiring its own decision row, not a test edit (AGENTS.md §5) |
| R2 | A crash between the provider accepting a message and the `message_attempt` row committing sends a duplicate on recovery. This is the one genuinely unclosable window in any send pipeline | Made *detectable and idempotent at the provider* rather than pretended away: the deterministic `Message-ID` (§3.6, DEC-104) is identical across re-submissions, so A15 can assert the Mailpit message count equals `sendable_count` after a real kill. The reserve→send→record ordering is DEC-051's, already proven in M3-S3 |
| R3 | Rate limiting via Redis re-introduces a second authority over which work remains, exactly the defect §1's binding sentence forbids | Redis holds **counters only**, never work. Every unsent recipient is a `status='queued'` row in PostgreSQL. A Redis flush loses rate accounting (a bounded over-send within one minute) and loses **no messages**; Redis being unreachable fails the batch closed. Asserted by a test that flushes Redis mid-execution and checks the final count still equals `sendable_count` |
| R4 | Time-dependent tests (backoff, `Retry-After`, per-minute windows, stale-claim sweep) are this run's established flake source (D-33) | No `setTimeout` waiting anywhere. `nextRetryDelayMs` takes an injected `rand`; the clock is an injected `now`; the minute-window key is computed from that same injected clock; due-ness is created by **writing a past `next_retry_at`/`claimed_at`**, never by waiting. Same discipline as M5-S2 R5, which held |
| R5 | The worker's send path is the first worker code to need per-tenant reads of `sender_config`, `sending_policy` and rendered content. Getting its connection wrong re-opens the RLS bypass the standardization workstream closed | Reuses the `OUTBOX_DATABASE_URL` narrow boundary for the scan and `runInTenantTransaction` for every read and write, verbatim as `campaign-dispatcher.ts` does. A20 includes the negative test proving the scan connection cannot read tenant rows outside a tenant context |
| R6 | `freezeCampaignSnapshot`'s status change (§3.2) silently breaks M4-S4's five closed rules, and M4-GATE is already closed | CP1 re-runs `campaign-snapshot-freeze.test.ts`, `campaign-snapshot-immutability.test.ts` and `campaign-snapshot-post-freeze.test.ts` before writing any send code, so a regression is attributed to the one-line change rather than found five checkpoints later. Same mitigation shape as M5-S2 R4, which caught a real bug |
| R7 | The e2e path needs a **host-run** compiled API plus a host-run Vite on 5173 — not the docker-composed 8080 stack — and Vite on this host binds `[::1]` only, so `127.0.0.1:5173` reports a false "server down" | Documented setup (c) from the M5-S3 handoff. Use `http://localhost:5173`. Seed accounts must be created through the **compiled `dist/`** output, never `tsx` (the D-20/D-22 `emitDecoratorMetadata` gap). Budget this at CP0, not at CP8 |
| R8 | `packages/architecture-tests` can appear hung for several minutes under this host's combined load while running its own `docker compose run --rm migrate` calls | Known-slow, not stuck; it completed 101/101 both standalone and in-suite last session. Check actual node process count before concluding otherwise; do not kill it prematurely |

---

## 6. Checkpoints

Commit at every checkpoint (AGENTS.md §2). The subject names the node; the body
records the workspace check's **test count and skip count**.

**CP0 — baseline.** `pnpm install`, `pnpm run infra:up`, Docker engine healthy.
Full `pnpm run check` green with test **and skip** counts recorded — this is the
number every later checkpoint is compared against. Verify the e2e setup (c) from
R7 boots end-to-end *now*, including the `dist/`-based seed, rather than
discovering it at CP8. Do not proceed on a red or uncounted baseline.

**CP1 — migration 026 + the freeze correction, RED first.** Write the failing
tests first: the status CHECK admits the eight values and rejects a ninth with
`23514`; `campaign_recipient_skipped_status_agrees` rejects a skipped row at
`status='pending'`; `campaign_execution`'s unique index rejects a second row for
one `(campaign_id, snapshot_id)`; `message_attempt`'s unique index rejects a
duplicate `attempt_no`; the new `sender_config`/`sending_policy` defaults are
present and positive; `queued_campaign_executions()` is executable by `eow_app`
and refuses `PUBLIC`. Then write `026_campaign_execution.sql`, apply it, add the
lock entry, make the §3.2 one-line freeze change, fix the four D-89 fixture
literals, and re-run **all three** M4-S4 snapshot suites plus `ARCH-MIGRATION`
standalone (R1, R6). A1, A2 (freeze half).

**CP2 — the state machines, RED first.** `send-state-machine.ts` as a pure
module with the full 12 × 12 campaign grid and the message-state graph
exhaustively unit-tested, including that no edge touches `paused` (DEC-097).
`nextRetryDelayMs` with injected `rand` (R4). A3, A9 (unit half).

**CP3 — the DAG's first three nodes.** `validate`, `freeze`, `partition` in
`apps/worker/src/campaign-send/`, replacing three of `main.ts`'s five stubs
(D-87). Idempotency proven by **running each node twice and comparing row
counts** (A5, A6), not by trusting the first result. A4's four blocking causes
asserted separately. A16's concurrency case genuinely concurrent, following
`campaign-dispatcher.integration.test.ts`'s harness. A4, A5, A6, A16, A20.

**CP4 — the send node against real SMTP.** `SmtpProviderAdapter.send()`
implemented (D-92 half), the deterministic `Message-ID`, `content_hash`,
`message_attempt` writes, error classification, retry scheduling, suppression.
Assert arrival at the **Mailpit HTTP API** (`:8025`), not at the SMTP call's
return value. A7, A8, A9 (integration half), A10, A11, A17, A21.

**CP5 — rate limiting + recovery.** The three ceilings (§3.5) against real
Redis; the stale-claim sweep; the kill-mid-batch recovery test; the Redis-flush
test from R3. This is the checkpoint that closes BR-SEND-007 and the deferred
half of BR-CFG-004/005. A12, A13, A14, A15.

**CP6 — aggregate + HTTP surface.** The `aggregate` node and its terminal
transitions; `cancelCampaignSend`; the real `getCampaignProgress` replacing the
mock (D-92). A2's full four-point assertion (after freeze, partition, send,
aggregate). A18, A19, A2.

**CP7 — contracts.** OpenAPI additions per §4 **including the `eta` narrowing
with its justification written out**, `openapi-compat-check`, `redocly bundle`,
`pnpm contracts:generate` (never hand-edit `packages/contracts/src/openapi.d.ts`).
AsyncAPI gains `campaign.execution_state_changed`. Regenerate and confirm
`apps/web` compiles against the generated types only (ADR-005).

**CP8 — web + VISUAL EVIDENCE + close.** §3.8's three web changes; e2e specs
added to `apps/web/e2e/visual-capture.spec.ts` on the existing M4-S3/M4-S4/M5-S2
helper pattern. Capture 3 viewports × the states this node adds (sending banner
with counts, completed, partial_failed, stop-send confirmation) into
`evidence/visual/M5-S3-send/production/`. **Individually inspect every image** —
a green Playwright run is not evidence (D-78; M4-S4 CP7 and M5-S2 CP7 each found
real defects this way that the passing suite did not). Then close BR-SEND-001,
-002, -006, -007, -010, -011, -012 in `traceability.csv` with real `code_paths` /
`test_files` / `migration_files` / `openapi_operation_ids` /
`log_or_metric_or_audit`; flip BR-CFG-004/005 from `partially_closed` to
`closed` with the send-path evidence that was always the missing half; record
DEC-096…105 in `EXECPLAN.md` §20, D-87…92 in §19, and migration 026 in §10;
re-run the full suite with **counts compared to CP0's baseline**, plus
`openapi-compat-check`, `redocly bundle`, `validate_plan.py` and `ARCH-MIGRATION`
standalone; only then flip `M5-S3-send` to `completed`.

> `M5-S4-webhook-reconciliation` becomes `ready` on that flip. It inherits three
> things named here: **`delivered`/`bounced` are legal but unreached** message
> states (DEC-096); **`suppressRecipient()` exists and needs a second caller**,
> the webhook one (DEC-105) — M5-S4 must not grow a parallel suppression path;
> and **`message_attempt.provider_message_id` is the join key** a callback maps
> back through, so `delivery_events` must key on it rather than re-deriving a
> mapping. `M5-GATE` additionally needs `BR-CFG-002`, which **no open slice
> currently claims** — that gap is still unowned and is not closed by this node.
