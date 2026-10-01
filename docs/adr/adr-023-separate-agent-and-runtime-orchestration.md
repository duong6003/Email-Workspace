# ADR-023: Separate agent automation from product runtime orchestration

Status: Accepted

## Decision

Files under `.agents/` govern the coding agent only. Email scheduling, campaign execution,
imports, bulk updates, notifications and realtime progress are product runtime workflows and
use NestJS, BullMQ, Redis and PostgreSQL as documented under `docs/architecture/`.

## Consequences

Agent schedule never means campaign schedule. The `packages/runtime-orchestration` package
contains product runtime mode selection and must not be used to control coding agents.
