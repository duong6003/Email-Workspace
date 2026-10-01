# System architecture

The system is a modular monolith in one repository with separate API and worker runtime
profiles. PostgreSQL is the system of record. Redis supports queues, distributed rate
limits and Socket.IO scale-out, but does not own business truth.

Modules: identity/tenant, recipients, lists/tags, custom data, templates, campaigns,
scheduling, delivery, provider webhooks, notifications, realtime, audit and reporting.

Product runtime campaign execution is a persisted workflow DAG:

`validate → freeze snapshot → enqueue/delay → partition → send → aggregate → reconcile → notify`

Each node is idempotent. The transactional outbox connects committed domain changes to
queue and realtime publication. Workers update canonical facts and aggregate progress;
events contain IDs/versions and clients refetch when versions skip.

Deployment begins as web + API + worker + scheduler + PostgreSQL + Redis, with a one-shot migration
container and Mailpit only as the safe default mail sink. Compose health gates enforce
PostgreSQL → migration → API/worker → web order. Scale workers separately by queue and
provider limits. Split services only when measured load/team ownership requires it.

Logging, trace propagation, metrics, label-cardinality and redaction contracts are defined in `docs/architecture/observability.md`.
