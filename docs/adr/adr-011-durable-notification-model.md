# ADR-011: Durable notification model

Status: Accepted

## Decision

Persist notification + per-user delivery/read state; use socket only for prompt delivery.

## Rationale

Users must recover notification history after offline periods and across devices.

## Alternatives

Toast-only notifications
