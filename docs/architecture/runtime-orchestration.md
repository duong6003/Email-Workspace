# Product runtime orchestration

This document governs the running Email Operations Workspace, not the coding agent.

- BullMQ delayed jobs implement email send-at scheduling and retryable background work.
- BullMQ flows plus PostgreSQL state implement campaign, import, export and bulk-update DAGs.
- The scheduler profile enqueues bounded maintenance scans; exact campaign send time remains
  a persisted delayed job and never relies on an in-process timer.
- Socket.IO publishes authorized hints and progress after canonical state commits.
- PostgreSQL and transactional outbox records remain authoritative.

The product may use loops for bounded recipient batches and graphs for campaign stages, but
those decisions live in runtime code under `packages/runtime-orchestration`. They do not alter
`.agents/agent-loop.yaml`, `.agents/agent-graph.yaml` or `.agents/agent-schedule.yaml`.
