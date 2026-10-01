# ADR-017: Observability

Status: Accepted

## Decision

Pino structured logs + OpenTelemetry traces/metrics; correlation IDs propagate through outbox and jobs.

## Rationale

Required to explain duplicate, delay, retry and provider failures.

## Alternatives

Log-only diagnostics
