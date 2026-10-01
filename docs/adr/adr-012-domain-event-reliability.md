# ADR-012: Domain event reliability

Status: Accepted

## Decision

Transactional outbox in PostgreSQL; dispatcher publishes queue/realtime work idempotently.

## Rationale

DB mutation and event publication must not diverge.

## Alternatives

Direct publish inside request transaction
