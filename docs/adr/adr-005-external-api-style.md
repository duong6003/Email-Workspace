# ADR-005: External API style

Status: Accepted

## Decision

REST JSON under /api/v1 with OpenAPI as source of truth and generated FE types.

## Rationale

Most workflows are resource-oriented; easier operationally than GraphQL and compatible with selected foundations.

## Alternatives

GraphQL; shared handwritten DTOs
