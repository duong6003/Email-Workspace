# ADR-016: Progress aggregation

Status: Accepted

## Decision

Persist counters in PostgreSQL; workers emit throttled aggregate updates no faster than 1/s or 250 recipients.

## Rationale

Avoid event storms and reconcile final counts from durable data.

## Alternatives

Per-recipient success event to every viewer
