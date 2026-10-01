# Source and library selection

Snapshot verified 2026-08-10. Stars are only a popularity signal; licenses, fit,
maintenance, security posture and architecture compatibility remain mandatory gates.

The approved `email-operations-workspace-ui-handoff-v2` is not a competing boilerplate. Once
copied to `design-reference/ui-handoff-v2/source/`, it is the visual and interaction source of
truth. `apps/web` is the production architecture target; the agent migrates the approved UI
into it instead of redesigning it.

## Selected foundations

- Frontend: **React + Vite with TanStack Query** as the data layer, per ADR-025. The original
  selection below (Refine CORE, ~35.5k stars, chosen as a headless CRUD/auth/access/live
  provider) was never realised — `@refinedev/core` was declared but imported nowhere, and M1
  and M2 shipped on TanStack Query plus types generated from `contracts/openapi.yaml`.
  ADR-025 supersedes ADR-002 and the dependency has been removed.
- Backend seed: controlled fork of Brocoders NestJS Boilerplate. It includes auth,
  roles, database, mail, uploads, Swagger, Docker and tests. Snapshot: ~4.4k stars.
- Realtime: Socket.IO server/client with Redis adapter. Snapshot: ~63.2k stars.
- Product runtime jobs: BullMQ on Redis; delayed jobs and flows cover email schedules and
  campaign execution at MVP scale. This is unrelated to coding-agent scheduling. Snapshot:
  ~9.3k stars.

The upstream boilerplates are not vendored into this archive. The included starter is
deliberately smaller, aligned to the accepted ADRs and safe to review. If the team forks
an upstream seed, pin an audited commit and apply `docs/operations/upstream-fork-checklist.md`.

## Version snapshot used by the starter

React 19.2.8; Vite 8.2.1; TanStack Query 5.101.4;
React Router 7.18.2; Zod 4.4.3; Socket.IO 4.8.3; NestJS 11.1.28;
BullMQ 6.0.9; TypeORM 1.1.0; TypeScript 5.9.3. TypeScript 5.9 is selected as
the compatibility baseline instead of the newer native compiler line. The starter intentionally
avoids packages published within the last 48 hours.

Sources:

- https://github.com/refinedev/refine
- https://github.com/brocoders/nestjs-boilerplate
- https://github.com/socketio/socket.io
- https://github.com/taskforcesh/bullmq
