# ADR-015: Template rendering

Status: Accepted

## Decision

Handlebars strict/whitelisted merge, sanitized HTML, CSS inlining and deterministic text fallback.

## Rationale

Matches variable syntax while limiting injection and non-determinism.

## Alternatives

Execute arbitrary template helpers
