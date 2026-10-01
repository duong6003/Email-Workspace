# ADR-010: Realtime consistency

Status: Accepted

## Decision

Realtime is a hint, not source of truth; every event carries event_id/version and causes targeted cache update/refetch.

## Rationale

Prevents stale UI after gaps, duplicate delivery or reconnect.

## Alternatives

Treat socket payload as authoritative state
