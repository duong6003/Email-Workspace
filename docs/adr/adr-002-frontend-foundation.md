# ADR-002: Frontend foundation

Status: Superseded by ADR-025 (TanStack Query frontend data layer)

The decision below is retained as the historical record of what was chosen at
`arch_contracts`. It is no longer normative: `@refinedev/core` was never imported by
`apps/web`, which shipped M1 and M2 on TanStack Query and OpenAPI-generated types instead.
Read ADR-025 for the architecture actually in force.

## Decision

Use Refine CORE headless on React/Vite and retain the existing design tokens/components.

## Rationale

Fits a data-heavy internal workspace and provides auth/access/live/notification extension points without forcing AntD/MUI.

## Alternatives

Extensive React Boilerplate; raw Vite only
