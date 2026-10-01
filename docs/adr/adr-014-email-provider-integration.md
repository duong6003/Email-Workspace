# ADR-014: Email provider integration

Status: Accepted

## Decision

Provider adapter plus canonical internal message/delivery states; verify signed webhooks and deduplicate events.

## Rationale

Avoid provider lock-in and handle differing provider semantics.

## Alternatives

Provider-specific state in domain
