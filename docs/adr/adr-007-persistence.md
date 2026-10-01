# ADR-007: Persistence

Status: Accepted

## Decision

PostgreSQL + TypeORM migrations; tenant_id on tenant data and invariant unique constraints.

## Rationale

Relational integrity matters for dedupe, snapshots, progress reconciliation and audit.

## Alternatives

MongoDB; Prisma migration
