# Deployment acceptance tests

Use `.env.deploy.local` for local release evidence; it must contain locally generated secrets and
must never be committed. Evidence belongs under
`.agents/runs/2026-08-10-eow-master-execplan/evidence/deploy/`.

The Compose application has six long-running containers (`postgres`, `redis`, `api`, `worker`,
`scheduler`, `web`) plus the one-shot `migrate` service. `mailpit` is a seventh, started only under
`--profile dev`; `prometheus` and `grafana` only under `--profile observability`. Mailpit has no
Compose-defined healthcheck, so the deployment command does not gate on it unless its image
supplies one, and `smoke_deploy.py` requires it to be running only when the dev profile put it
there -- a production bring-up with no mailpit container still passes DEPLOY-002.

| ID | Priority | Procedure | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| DEPLOY-001 | P0 | Leave a `${VAR:?}` secret blank and run `docker compose --env-file <file> config --quiet`. | Interpolation exits non-zero before startup and names the variable. | `DEPLOY-001-blank-required-secret.txt` |
| DEPLOY-002 | P0 | Run the documented build/up command, then `python3 scripts/smoke_deploy.py --case DEPLOY-002 --json`. | Long-running services report running/healthy and `migrate` exited 0. | `DEPLOY-002-*` |
| DEPLOY-003 | P0 | Run `python3 scripts/smoke_deploy.py --case DEPLOY-003 --json`. | Edge liveness, API liveness and API readiness return 2xx; readiness body says `ready`. | `DEPLOY-003-*` |
| DEPLOY-004 | P0 | Seed a marker row, rerun the same deployment command, query the marker and migration log. | Marker remains and every migration is already applied without drift. | `DEPLOY-004-*` |
| DEPLOY-005 | P0 | Rehearse a changed published migration in an isolated project and run the migration behavior test. | Migration refuses changed history and instructs a forward migration. | `DEPLOY-005-*` |
| DEPLOY-006 | P0 | Stop PostgreSQL, query `/api/v1/health/ready`, and inspect API health. | Readiness returns 503 and the API becomes unhealthy; dependent stack is not ready. | `DEPLOY-006-*` |
| DEPLOY-007 | P1 | Restart Redis during queued work and reconcile PostgreSQL recipient/attempt/progress facts. | Runtime recovers or becomes visibly unhealthy; no canonical truth is lost or duplicated. | `DEPLOY-007-*` |
| DEPLOY-008 | P1 | Hold host port 8080, then start `web`. | Compose fails with an actionable bind error; override `EOW_HTTP_PORT` to select a free port. | `DEPLOY-008-*` |
| DEPLOY-009 | P1 | Run `down` without `-v`, redeploy, smoke, and query the CP3 marker. | Named volumes retain data and smoke passes. | `DEPLOY-009-*` |
| DEPLOY-010 | P1 | Run `config --quiet`; inspect captured logs for each generated secret value. | Config is valid and no application log contains a secret. Never commit the raw log. | `DEPLOY-010-*` |

DEPLOY-002, 004, 006, 007 and 009 require a real Docker runtime and are release evidence; YAML
parsing alone cannot replace them. On a Compose v1-only host, replace unavailable `--wait`/JSON
flags with explicit `docker inspect` health polling and record that substitution in the evidence.
