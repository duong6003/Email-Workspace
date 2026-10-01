# Deployment operations

## Status, logs and smoke check

```bash
docker compose --env-file .env ps
docker compose --env-file .env logs --follow --tail=200
python scripts/smoke_deploy.py
```

Use `docker compose --env-file .env config --quiet` when validating interpolation. The same
command without `--quiet` prints resolved environment values, including secrets, so never paste
its output into a ticket, chat or log archive.

## Upgrade

Back up first, update source/images, then rerun the one-command deployment. The one-shot
`migrate` service verifies the checksum of published migrations and refuses edited history.
Add forward-only numbered migrations and extend `database/migrate.sh` when the schema grows.

## Backup and restore rehearsal

```bash
python3 scripts/backup_db.py --env-file .env --out deploy-backups/eow-$(date -u +%Y%m%dT%H%M%SZ).dump
python3 scripts/restore_db.py --env-file .env --dump deploy-backups/eow-<timestamp>.dump --project eow-restore-rehearsal
```

The restore command requires and enforces an isolated project name; it refuses the source project.
See `docs/operations/backup-restore.md` for cleanup, measured evidence and the RPO/RTO variance.

## Stop and remove

`docker compose --env-file .env down` stops containers and retains volumes. Adding `--volumes`
deletes database and Redis data and is therefore a destructive, explicit operator action.
For persistence rehearsals such as DEPLOY-009, use `down` without `-v`/`--volumes`; deleting the
volumes turns the rehearsal into a fresh installation and proves nothing about retained data.

## Failure triage

If `--wait` fails, run `docker compose --env-file .env ps` and inspect the first unhealthy
dependency's logs. Typical causes are blank secrets, occupied host ports, an old Compose v1
binary, changed credentials against an existing PostgreSQL volume, or a failed migration.
