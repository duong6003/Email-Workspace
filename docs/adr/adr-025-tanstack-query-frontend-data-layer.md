# ADR-025: TanStack Query frontend data layer

Status: Accepted

Supersedes: ADR-002 (Frontend foundation)

## Decision

Use React/Vite with TanStack Query as the production frontend data layer. API shapes are generated from `contracts/openapi.yaml` by `@eow/contracts`; feature-specific clients in `apps/web/src/api/` call the accepted REST contract. React Router continues to own routing, and Socket.IO events remain hints that trigger targeted cache reconciliation or refetch rather than becoming the authoritative business state.

`@refinedev/core` is not part of the production architecture and is removed from `apps/web`.

## Context

ADR-002 selected Refine CORE as the frontend foundation, but the shipped M1 and M2 screens use TanStack Query and generated OpenAPI types exclusively. Repository inspection finds no `@refinedev/core` import under `apps/web/src`; retaining its declaration would make the accepted architecture contradict the running implementation and mislead later feature work.

## Consequences

- New web data access must extend the typed API-client and TanStack Query pattern already used by `apps/web`.
- The dependency graph and browser bundle no longer include an unused data framework.
- This is an architectural correction, not a migration: production screens were already on this pattern.

## Alternatives

- Adopt Refine now: rejected because it would add a second data-layer abstraction to two working milestones without an unmet business requirement.
- Keep the unused dependency while treating ADR-002 as informal history: rejected because accepted ADRs are normative until explicitly superseded.
