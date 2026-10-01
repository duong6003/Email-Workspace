# PostgreSQL backup and isolated restore rehearsal

## Backup

Create a custom-format dump and verified sidecar from the running deployment:

```bash
python3 scripts/backup_db.py --env-file .env --out deploy-backups/eow-$(date -u +%Y%m%dT%H%M%SZ).dump
```

The command streams `pg_dump -Fc` from the PostgreSQL container, deletes partial output after any
failure, verifies readability with `pg_restore --list`, and writes `<dump>.json` containing the UTC
timestamp, database, byte size, SHA-256, duration and row-count facts. A dump without a matching,
verified sidecar is not accepted backup evidence.

For a 15-minute recovery-point objective, schedule and monitor this command at least every 15
minutes. Store encrypted copies outside the Compose host and test retention/expiration separately.

## Restore rehearsal

Restores are destructive, so the tool requires an explicit isolated project and refuses the source
project name:

```bash
python3 scripts/restore_db.py --env-file .env --dump deploy-backups/eow-<timestamp>.dump \
  --project eow-restore-rehearsal
```

The restore project uses ephemeral host ports, starts fresh PostgreSQL storage, verifies the dump
SHA-256, restores without ownership/privilege replay, and compares counts for `tenant`, `campaign`,
`recipient`, `message_attempt` and `schema_migrations` against the sidecar. Remove the rehearsal
volumes afterwards:

```bash
EOW_POSTGRES_PORT=0 EOW_REDIS_PORT=0 EOW_MAILPIT_PORT=0 EOW_MAILPIT_SMTP_PORT=0 EOW_HTTP_PORT=0 \
  docker compose -p eow-restore-rehearsal --env-file .env down -v
```

Never run the restore command with the live project name. Never commit a dump or its real data.

## Rehearsal evidence — August 19, 2026

M7-S4 ran `TC-SEC-015` against an isolated `eow-m7s4-restore` project:

- Dump size: 185,436 bytes; `pg_restore --list` verified readable.
- Backup duration: 0.828 seconds.
- Restore and verification RTO: 4.289 seconds.
- Backup age at verified restore (measured point-in-time loss for this immediate rehearsal): 5.159 seconds.
- Source and restore counts matched: tenant 2, campaign 0, recipient 0, message_attempt 0,
  schema_migrations 32.

The measured RTO is inside the proposed four-hour target on this small development dataset. It is
not a production-volume forecast: production evidence must rehearse representative data size,
storage throughput, encryption/decryption and off-host download time.

## RPO/RTO variance report

`BR-SEC-004` proposes RPO 15 minutes and RTO four hours, accepting either a rehearsal meeting the
targets or a written variance report. This rehearsal proves the restore mechanism and measured
immediate backup age, but the repository does **not** yet guarantee a 15-minute production RPO:

- `pg_dump` gives an RPO equal to the successful backup interval. The measured 5.159-second age
  occurred only because restore followed backup immediately; it does not prove a scheduled backup
  runs every 15 minutes.
- The Compose PostgreSQL service has no WAL archive `command:` or `archive_command`. True PITR needs
  WAL archiving (`wal_level = replica` plus a durable archive command) or a maintained tool such as
  pgBackRest or wal-g, with off-host retention and restore testing.
- To meet the target, production ownership must choose managed PITR or deploy monitored 15-minute
  backups plus WAL archiving, alert on missed jobs, encrypt/offload artifacts, and rehearse against
  representative data. The four-hour RTO also needs a capacity model and a larger-volume drill.

This is the accepted variance: automation and an isolated restore are proven, while continuous PITR
and a production scheduling/monitoring service remain deployment-owner work before production data.
