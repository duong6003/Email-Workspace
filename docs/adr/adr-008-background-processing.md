# ADR-008: Background processing

Status: Accepted

## Decision

BullMQ workers on Redis for send/import/export/bulk/reconciliation jobs.

## Rationale

Retry/backoff, delayed jobs, concurrency and operational visibility are required.

## Alternatives

In-process timers; database polling only
