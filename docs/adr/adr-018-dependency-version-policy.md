# ADR-018: Dependency/version policy

Status: Accepted

## Decision

Pin exact versions in lockfile; use current stable majors after a two-day compatibility spike; automate patch/minor PRs.

## Rationale

The reviewed ecosystem is fast-moving and new major versions must not enter implicitly.

## Alternatives

Caret ranges without lock governance
