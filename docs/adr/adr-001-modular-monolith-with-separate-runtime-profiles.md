# ADR-001: Modular monolith with separate runtime profiles

Status: Accepted

## Decision

Use one domain codebase deployed as API, worker and scheduler profiles.

## Rationale

Faster domain consistency than microservices while isolating workloads; define module boundaries and outbox events so future extraction remains possible.

## Alternatives

A single process; microservices now
