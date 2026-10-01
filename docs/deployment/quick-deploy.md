# Quick deployment — complete stack in one command

## Prerequisites

Install Docker Engine/Desktop with Docker Compose v2. The host needs at least 4 GB RAM,
2 CPU cores, 10 GB free disk and open TCP ports 8080 and 8025 by default.

## First deployment

1. Copy `.env.deploy.example` to `.env`.
2. Fill every blank required secret. Use `docs/deployment/environment-variables.md`.
3. From the repository root run exactly:

   ```bash
   docker compose --env-file .env up -d --build --wait
   ```

4. Verify with `python scripts/smoke_deploy.py` or open the URLs below.

Default URLs: app `http://localhost:8080`, API health
`http://localhost:8080/api/v1/health`.

Compose starts PostgreSQL and Redis, waits for health, applies migrations exactly once,
then starts API, worker, scheduler and the Nginx-served React app. Re-running the same
command is safe; volumes keep PostgreSQL and Redis data.

`EOW_SMTP_HOST` and `EOW_SMTP_FROM` have no defaults. Leaving either blank stops the
command at interpolation, before a container starts, and names the missing variable --
the point being that a deployment cannot quietly inherit the development mail catcher.

## Development profiles

Mailpit sits behind the `dev` profile and the Prometheus/Grafana pair behind
`observability`, so neither starts under the command above. Add the profile to start
them:

```bash
docker compose --env-file .env --profile dev up -d --build --wait
```

That is what `pnpm deploy:up` runs, which is why local development still gets Mailpit at
`http://localhost:8025`. Never pass `--profile dev` on a host that sends real mail.

## Windows PowerShell

```powershell
Copy-Item .env.deploy.example .env
docker compose --env-file .env up -d --build --wait
py scripts/smoke_deploy.py
```

`docker-compose` with a hyphen is the legacy CLI. This package targets Compose v2 via
`docker compose` because it supports dependency health conditions and `--wait`.

## Production boundary

This is a fast single-host baseline. Before admitting production data, place TLS at the
edge, point `EOW_SMTP_HOST`/`EOW_SMTP_PORT`/`EOW_SMTP_FROM` at a real provider and leave
the `dev` profile off so no mail catcher runs, use managed or backed-up
PostgreSQL/Redis, configure secrets outside source control, restrict inbound ports, and
complete the security/vertical-slice work listed in `project.manifest.yaml`. The verified local
backup/isolated-restore procedure and the remaining PITR variance are documented in
`docs/operations/backup-restore.md`.
