# Definition of done

Code, migrations, contracts, tests, observability, accessibility, security, documentation,
traceability and recovery are complete. Feature flags and rollback are defined where needed.
Runtime-affecting changes preserve `docker compose --env-file .env up -d --build --wait`,
document every added/changed env variable, pass Compose configuration validation and pass the
web/API smoke test when a Docker runtime is available.
Frontend scope also requires visual equivalence against the approved UI handoff at desktop,
tablet and mobile viewports, with screen → rule → API/event → test traceability.
