# ADR-054: Send throughput — configurable sender limits, pooled SMTP and continuous drain

Status: Proposed

Refines ADR-008 (background processing) and ADR-014 (provider integration). Keeps
ADR-013, ADR-016 and the reserve → send → record contract of BR-SEND-006/012 intact.
Evidence: `docs/audit/2026-10-01-campaign-send-performance-audit.md`
(benchmark `apps/worker/bench/send-throughput.ts`).

## Context

Measured on real PostgreSQL/Redis with the production worker code:

- Stock configuration sends **60 emails/minute per campaign**: `sender_config.
  rate_limit_per_minute` defaults to 60 and is not exposed by the API, OpenAPI or UI
  (BR-CFG-006 requires it to be configurable). Raising the visible tenant limit to 6,000
  and batch size to 1,000 still sends 60 per tick.
- One partition + one batch per 60 s scheduler tick caps a campaign at `batch_size` per
  minute regardless of limits.
- The send loop is sequential, opens a new SMTP connection per message, and nodemailer
  does not set `TCP_NODELAY`, adding ~40 ms per message (Nagle × delayed ACK). Measured:
  17 msg/s at 0 ms RTT and 4.3 msg/s at 30 ms RTT; DB+Redis overhead is only ~4 ms/msg.
- The freeze inserts every campaign_recipient row in one statement and fails above
  ~5,040 recipients (`bind message has 12464 parameter formats but 0 parameters`); 4,000
  recipients take 10.6 s inside the HTTP request.
- `STALE_CLAIM_MINUTES = 5` lets another scan re-claim in-flight rows of any batch that
  runs longer than five minutes, which larger batches would make routine.

## Decision

1. **Expose sender limits.** `rateLimitPerMinute`, `dailySendLimit` and a new
   `maxConnections` (default 4, max 32) become part of the sender-config API, OpenAPI and
   settings UI. Review shows the effective rate `min(sender, tenant)` and an ETA.
2. **Pooled SMTP per sender** inside the worker process (`pool: true`, `maxConnections`,
   `maxMessages`), with `setNoDelay(true)` on every socket, closed on idle and on
   credential change (keyed by sender id + config version).
3. **Bounded parallel send** up to the sender's `maxConnections`, with rate tokens
   acquired in blocks from Redis (atomic Lua `INCRBY` against the fixed minute bucket,
   DEC-103 fail-closed preserved). Recording stays per message (or small chunks) after
   provider acceptance; the deterministic Message-ID (DEC-104) is unchanged.
4. **Continuous drain.** A per-campaign BullMQ job (`campaign-send:<campaignId>`, jobId
   deduplicated) is enqueued from the outbox when a campaign reaches `queued`, and by the
   existing scan as a safety net. The job loops partition → send → aggregate until the
   campaign is drained, paused, or the rate budget for the current minute is exhausted,
   then re-enqueues itself delayed to the next bucket. The 60 s scan remains only for
   recovery. Pause stays bounded by `PAUSE_CHECK_INTERVAL_MS`.
5. **Lease claims instead of a fixed 5-minute staleness.** A claimed row carries
   `claim_token` + `claim_expires_at`; the running job extends the lease while working.
   Only expired leases can be re-claimed.
6. **Chunked, asynchronous freeze.** Confirmation validates and moves the campaign to a
   new `preparing` status; a worker job resolves the audience once, renders and inserts
   in chunks of ≤ 1,000 rows (`= ANY($1::uuid[])` for id lists), then transitions to
   `queued`/`scheduled`. Failure transitions to `failed` with a notification. This adds a
   state to BR-SEND-001 and is the main reason this needs an ADR.
7. **Accounting fixes.** Rows deferred for rate budget are not counted as `retrying`
   in metrics; progress snapshots move out of the per-message loop to a timer.

## Consequences

- Throughput becomes bounded by configured limits and the provider, as BR-SEND-007
  intends, instead of by the tick. Expected ~3,000 msg/min per worker at 30 ms RTT with
  8 connections (to be re-measured with the benchmark).
- Providers see concurrent connections; `maxConnections` must respect provider policy,
  so it is per sender and conservative by default.
- New status `preparing` must be added to OpenAPI, AsyncAPI, web status chips and
  `send-state-machine.ts` in both api and worker.
- The scheduler tick no longer determines latency to first send.

## Recovery

Each step is independently revertible behind configuration: `maxConnections = 1` and
disabling the per-campaign job restore today's sequential, scan-driven behaviour.
Lease columns and `preparing` are additive migrations; existing rows without a lease are
treated as unclaimed.

## Alternatives

- **Raise defaults only** (sender 600/min, batch 1,000) — rejected alone: the code still
  caps at ~258 msg/min at 30 ms RTT and large batches trigger duplicate re-claims.
- **Shorter scheduler tick** — rejected: it multiplies cross-tenant scans and pool
  churn without removing sequential SMTP.
- **One BullMQ job per recipient** — rejected: Redis becomes the work store, which
  DEC-103 explicitly avoids; PostgreSQL stays authoritative.
