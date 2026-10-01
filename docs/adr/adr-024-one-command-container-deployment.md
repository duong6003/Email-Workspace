# ADR-024: One-command container deployment baseline

Status: Accepted

## Decision

Package the single-host baseline as multi-stage OCI images and one `compose.yaml`. After a
documented `.env` is prepared, `docker compose --env-file .env up -d --build --wait` starts
PostgreSQL, Redis, an idempotent migration job, API, worker, scheduler and React/Nginx in
health-gated dependency order. PostgreSQL is the persistent source of truth; Redis is
persisted for queue recovery but remains reconstructable infrastructure state.

The development mail sink is part of the same file but not of that command. `mailpit` carries
`profiles: [dev]` and the Prometheus/Grafana pair `profiles: [observability]`, so services that
exist for a developer's convenience are opt-in rather than something a production bring-up has
to remember to remove. `EOW_SMTP_HOST` and `EOW_SMTP_FROM` are correspondingly required
(`${VAR:?}`), not defaulted: a `:-mailpit` fallback made a forgotten variable indistinguishable
from a working configuration, since the API and worker would connect successfully to the dev
catcher and no message would ever reach a real recipient. Failing interpolation before any
container starts converts that silent data loss into a startup error naming the variable.

All deployment variables live in `.env.deploy.example` and are explained in a dedicated
variable catalog. Published migration checksums are immutable. Production deployment itself
remains an explicit approval gate even though local packaging verification is autonomous.

## Consequences

A new host has a reproducible quick-start and agents can verify packaging consistently.
Compose is the baseline, not the final high-availability topology: production still requires
TLS, secret management, backup/restore, real SMTP/provider configuration, monitoring and an
environment-specific capacity/security review.
