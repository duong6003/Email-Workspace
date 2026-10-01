# ADR-020: Notification service boundary

Status: Accepted

## Decision

Implement notification as a Nest domain module first; do not add Novu in MVP.

## Rationale

Current need is in-app durable notifications; an external platform adds operations and synchronization cost.

## Alternatives

Novu now; no notification center
