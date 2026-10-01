# Deployment environment variables

Copy `.env.deploy.example` to `.env`. Never commit `.env`. Values containing `#`, spaces,
`:` or URL-reserved characters should be quoted where Compose permits it; database and Redis
passwords used inside URLs should be URL-safe ASCII or percent-encoded.

Development-only services (`mailpit`) and the observability stack (`prometheus`, `grafana`)
sit behind Compose profiles, so the documented production bring-up starts neither. The
`EOW_MAILPIT_*` and `EOW_GRAFANA_*` rows below apply only when the matching
`--profile dev` / `--profile observability` is passed.

| Variable | Required | Default/example | Purpose and validation |
| --- | --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | No | `email-operations-workspace` | Stable container/network/volume prefix. |
| `EOW_HTTP_BIND` | No | `0.0.0.0` | Public app bind address; use `127.0.0.1` behind a host reverse proxy. |
| `EOW_HTTP_PORT` | No | `8080` | Public app port. Must be free. |
| `EOW_MAILPIT_BIND` | `dev` profile only | `127.0.0.1` | Keeps development mail UI local by default. |
| `EOW_MAILPIT_PORT` | `dev` profile only | `8025` | Mailpit web UI port. |
| `EOW_MAILPIT_SMTP_PORT` | `dev` profile only | `1025` | Loopback-only Mailpit SMTP port for host-run integration tests; API and worker reach the same container at the internal `mailpit:1025` address. |
| `EOW_POSTGRES_DB` | No | `eow` | PostgreSQL database name. |
| `EOW_POSTGRES_USER` | No | `eow` | PostgreSQL application owner. |
| `EOW_POSTGRES_PASSWORD` | Yes | blank | Use 24+ random URL-safe characters; changing it does not rewrite an existing volume credential. |
| `EOW_POSTGRES_APP_PASSWORD` | Yes | blank | Password for the non-superuser, non-BYPASSRLS `eow_app` runtime role. Use a distinct 24+ character URL-safe value; migrations create/update this role while API, worker and scheduler use it. |
| `OUTBOX_DATABASE_URL` | Compose-managed | `eow_app` URL | Narrow worker relay connection. Migration 013 exposes only SECURITY DEFINER list/ack/attempt functions; the worker has no owner/BYPASSRLS credential and cannot query cross-tenant outbox rows directly. Ordinary processors use `DATABASE_URL` with transaction-local tenant context. |
| `EOW_POSTGRES_BIND` | No | `127.0.0.1` | Loopback-only PostgreSQL bind for local development/integration tests (mirrors the Mailpit pattern). Set empty or firewall the port to disable host access entirely on a shared host. |
| `EOW_POSTGRES_PORT` | No | `55432` | Host port for the loopback PostgreSQL bind. Deliberately non-default so it does not collide with an unrelated local PostgreSQL instance. Must be free. |
| `EOW_REDIS_PASSWORD` | Yes | blank | Use 24+ random URL-safe characters. |
| `EOW_MINIO_ROOT_PASSWORD` | Yes | blank | Root credential for the ADR-043 asset object store. No default, for the same reason as the SMTP pair: a fallback password on the store holding every tenant's uploaded images would let a deployment come up with a well-known credential and surface nothing. Use 24+ random URL-safe characters. |
| `EOW_REDIS_BIND` | No | `127.0.0.1` | Loopback-only Redis bind for local development/integration tests. |
| `EOW_REDIS_PORT` | No | `56379` | Host port for the loopback Redis bind. Deliberately non-default so it does not collide with an unrelated local Redis instance. Must be free. |
| `EOW_SESSION_SECRET` | Yes | blank | Use at least 32 random bytes/64 hex characters; rotate through an explicit session invalidation plan. |
| `EOW_SENDER_CREDENTIAL_KEY` | Yes | blank | Exactly 64 hexadecimal characters used for AES-256-GCM encryption of saved SMTP credentials. API and worker must use the same value; rotation requires an explicit credential re-encryption plan. |
| `EOW_WEB_ORIGIN` | No | `http://localhost:8080` | Exact browser origin allowed by API CORS; set the final HTTPS origin in production. **Also the default source of `ASSET_PUBLIC_ORIGIN`** (ADR-043): the sanitizer accepts only `https:`/`cid:` image sources, so a non-https value here silently strips every Mailcraft-uploaded image out of every email published afterward, with no error at save or publish time. Measured 2026-09-03 in `builder-block-sanitizer.test.ts`. |
| `EOW_WORKER_CONCURRENCY` | No | `10` | Parallel email jobs per worker; tune against provider quotas and DB load. |
| `EOW_SCHEDULER_TICK_MS` | No | `60000` | Maintenance scheduler heartbeat interval; do not use it as the source of campaign send time. |
| `EOW_NOTIFICATION_RETENTION_DAYS` | No | `90` | Number of days a durable notification is retained before the worker purges its notification and per-user read rows. Must be an integer from 1 through 3650; immutable audit events are never deleted. |
| `EOW_HISTORY_EVENT_RETENTION_DAYS` | No | `365` | Default retention window, in days, for detailed message events (`message_attempt`, `delivery_event`) of tenants that have not set their own policy through `PUT /retention-policy`. Must be an integer from 30 through 3650; campaign summaries and snapshots are never purged, and no event younger than 30 days can be deleted. |
| `EOW_SMTP_HOST` | Yes | blank | SMTP hostname. No default: a `mailpit` fallback would route every message of a deployment that forgot this variable into the development catcher, silently, with nothing to notice. Compose refuses to interpolate when it is unset. Local development sets `mailpit`. |
| `EOW_SMTP_PORT` | No | `1025` | SMTP port. Left defaulted because a wrong port fails loudly at connect time; set `587`/`465` for a real provider. |
| `EOW_SMTP_FROM` | Yes | blank | Default sender, required for the same reason as `EOW_SMTP_HOST`: an unset value must fail before startup rather than send real campaigns from `no-reply@example.test`. Must be provider-verified in production. |
| `EOW_SMTP_CONNECTION_TIMEOUT_MS` | No | `10000` | Maximum time to establish an SMTP connection. |
| `EOW_SMTP_GREETING_TIMEOUT_MS` | No | `10000` | Maximum time to wait for the SMTP greeting. |
| `EOW_SMTP_SOCKET_TIMEOUT_MS` | No | `30000` | Maximum idle SMTP socket time while submitting a message. |
| `EOW_LOG_LEVEL` | No | `info` | Runtime verbosity; do not enable payload/PII logging. |
| `EOW_API_METRICS_PORT` | No | `9464` | Internal API Prometheus listener; Compose does not publish it to the host. |
| `EOW_WORKER_METRICS_PORT` | No | `9465` | Internal worker Prometheus listener; Compose does not publish it to the host. |
| `EOW_GRAFANA_BIND` | No | `127.0.0.1` | Host bind for the optional observability profile. Keep loopback-only unless protected by TLS/auth at the edge. |
| `EOW_GRAFANA_PORT` | No | `3001` | Host port for optional Grafana. |
| `EOW_GRAFANA_ADMIN_PASSWORD` | Observability profile only | blank | Required when starting `--profile observability`; inject a unique secret. |
| `EOW_TIMEZONE` | No | `Etc/UTC` | Container timezone; business schedules still store UTC plus original IANA zone. |
| `EOW_CAMPAIGN_AUDIENCE_LIMIT` | No | `100000` | BR-CMP-009's configured per-tenant audience ceiling; a static limit, not a consumable quota (that ledger is M7-S1). Value matches BR-SEC-006's own MVP performance target. |
| `EOW_PROVIDER_WEBHOOK_SECRET` | No | blank | HMAC secret providers sign their delivery-status webhooks with (BR-SEND-008). Unset means `POST /api/v1/webhooks/providers/{provider}` returns 503 and accepts nothing -- never a silent fallback to accepting an unverified event. Set it once a real provider is configured to call back to this deployment, using at least 32 random characters (the same generator below). |

Webhook endpoint (BR-SEND-008): `POST https://<your-domain>/api/v1/webhooks/providers/smtp`.
Configure the provider to sign each request with header `X-EOW-Signature:
t=<unix-seconds>,v1=<hex hmac-sha256 of "<t>.<raw request body>">`, using
`EOW_PROVIDER_WEBHOOK_SECRET` as the HMAC key. The signature's timestamp must be
within 300 seconds of the API server's clock (NTP-synced hosts only) or the
request is rejected 401 as expired.

Generate a secret without installing OpenSSL:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use a different generated value for each required secret. For production, inject secrets
through the deployment platform rather than storing them in a host file.
