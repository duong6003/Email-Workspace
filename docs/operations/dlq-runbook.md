# Dead-letter queue runbook

Use the dead-letter API only with an admin session carrying `dlq:manage`. The API is tenant-scoped and every replay attempt is audited as `dead_letter.replayed` with the actor and event id.

## Inspect

1. List current entries with `GET /api/v1/dead-letter-events?limit=50`. Follow `nextCursor` for older entries.
2. Read one entry with `GET /api/v1/dead-letter-events/{deadLetterEventId}`.
3. Treat `payload` as sensitive operational data. Do not copy it into tickets, chat, or logs.
4. Read `lastError`, `attempts`, `eventType`, `aggregateType`, and `aggregateId` together. Confirm that the underlying dependency or malformed-data cause is resolved before replay.

## Decide

- Replay when the failure was transient or the underlying defect has been corrected and the original side effect is still valid.
- Do not replay when the payload is invalid, the business action was cancelled, the destination is unsafe, or ownership is unclear. Preserve the row for investigation; this API intentionally has no discard/delete endpoint.
- Escalate when replay could resend email, overwrite recipient data, cross a compliance boundary, or repeat an externally visible action whose downstream idempotency is unknown.

## Replay

1. Generate a unique `Idempotency-Key` for the operator action and retain it in the incident record.
2. Send `POST /api/v1/dead-letter-events/{deadLetterEventId}/replay` with the authenticated cookie, matching CSRF token, and `Idempotency-Key` header.
3. A `202` response means the authoritative outbox event is eligible for the normal relay again. It does not guarantee immediate downstream completion.
4. Reusing the same key returns the stored result without repeating the transition. A fresh key also cannot create a second pending outbox effect after the source event has already been restored.
5. Verify `replayCount`, `replayedAt`, downstream job state, and the `dead_letter.replayed` audit row. The stored dead-letter `payload` is immutable.

## Monitor

The worker emits structured metric `eow_dead_letter_depth` when an event crosses the retry ceiling. A suggested alert is warning on any positive transition and paging when depth remains above zero for 15 minutes. The shared alert catalogue is maintained by the observability owner.
