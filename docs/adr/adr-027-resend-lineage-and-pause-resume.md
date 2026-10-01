# ADR-027: Resend lineage and pause/resume

Status: Accepted

## Decision

A campaign resend (BR-HIS-005) creates a **new** `campaign_snapshot` that supersedes the parent snapshot and carries only the parent execution's previously-failed sendable recipients, and a **new** `campaign_execution` linked to the parent via `parent_execution_id`; `campaign_snapshot` gains a matching `parent_snapshot_id`. It does not reuse the parent snapshot or the parent execution.

Pause/resume (BR-SEND-009) adds exactly two edges — `sending->paused` and `paused->sending` — to both copies of the campaign-execution state machine (`apps/api/src/campaigns/send-state-machine.ts`, `apps/worker/src/campaign-send/send-state-machine.ts`), and enforces the pause within the worker's send loop itself (`sendClaimedBatch`'s per-row loop), re-checking campaign status at a bounded interval (`PAUSE_CHECK_INTERVAL_MS = 2000`) rather than relying on the scheduler's own scan cadence.

Both changes cross the AGENTS.md §2 threshold for requiring an ADR before implementation: resend changes campaign snapshot semantics (a campaign may now accrue more than one snapshot generation over its lifetime, where previously exactly one live snapshot ever existed), and pause/resume changes delivery state (a new actor — an in-loop status check — halts message submission mid-batch, distinct from every existing writer of `campaign_recipient`/`campaign_execution` state).

## Rationale

**Resend cannot reuse the parent snapshot.** Four already-published constraints forbid it:

1. `campaign_execution`'s `UNIQUE (campaign_id, snapshot_id)` (migration 026) is documented as "the DAG's idempotency key" — a second execution against the same snapshot cannot be inserted at all.
2. `readProgressFacts` (`apps/api/src/campaigns/progress-snapshot.ts`) counts `campaign_recipient` by `snapshot_id`. Two executions sharing one snapshot would report one merged count, breaking BR-HIS-005's own requirement that a summary name counts and reasons per attempt.
3. `uq_campaign_recipient_snapshot` is `(snapshot_id, recipient_id)` (migration 022), whose own comment says a refreshed snapshot legally "re-freezes the same people" — the mechanism a resend needs already exists at the snapshot level, not the execution level.
4. `apps/worker/src/campaign-send/run.ts`'s `currentExecutionId` already joins `campaign_snapshot cs ON cs.superseded_at IS NULL`. Once a resend supersedes the parent snapshot and inserts a new live one, the existing worker scan resolves to the resend execution with **no change to the worker's own orchestration code**.

Given those four constraints, "new snapshot per resend, linked to its parent" is not a design choice among several — it is the only model the published schema admits without relaxing a constraint that another closed rule (BR-SEND-002's idempotent DAG) depends on.

**Pause cannot be satisfied by the scheduler's scan cadence.** `apps/scheduler/src/main.ts` defaults `SCHEDULER_TICK_MS` to 60,000ms. BR-SEND-009 requires pause to take effect within 10 seconds. Setting `campaign.status = 'paused'` correctly removes the campaign from `queued_campaign_executions()`'s selection and from `partition.ts`'s claim precondition, but a batch already claimed and mid-flight inside `sendClaimedBatch` would otherwise continue submitting for up to a full `batchSize` (default 100) messages after the operator's click — far outside the 10-second bound. The check must live inside the send loop's own per-row iteration.

## Alternatives

**Resend reuses the parent snapshot, scoped by a new "resend batch" column on `campaign_recipient`.** Rejected: this requires dropping or relaxing `UNIQUE (campaign_id, snapshot_id)`, which is the mechanism M5-S3 relies on to avoid a distributed lock during execution creation (migration 026's own comment: "no distributed lock is needed"). It also requires `readProgressFacts` to gain a resend-batch filter, duplicating count logic a third time (`apps/api` and `apps/worker` already carry one deliberate transliterated pair under DEC-107/DEC-123; a third variant inside one of those two files is not that pattern).

**Pause takes effect only at the next scheduler tick, accepting up to 60 seconds of latency.** Rejected: this directly contradicts BR-SEND-009's acceptance text ("Pause đạt hiệu lực trong 10 giây"), which is P1 and not waivable without a documented exception.

**Automatic resend on `partial_failed`, triggered by the aggregate step itself.** Rejected: BR-HIS-005's text describes an operator-initiated retry ("retry tạo execution mới"), not an automatic one. An automatic retry loop over a campaign whose sender is permanently failing is a new failure mode this ADR does not attempt to bound, and the user explicitly scoped resend to an operator-initiated API route during design.
