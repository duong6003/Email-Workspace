# Observability architecture

ADR-017 is implemented with Pino structured logs and OpenTelemetry traces/metrics.

## Correlation

HTTP requests enter one AsyncLocalStorage context with `trace_id`; authentication enriches the same context with `tenant_id` and `actor_id`. Campaign paths add `campaign_id`. The transactional outbox persists `trace_id`; after the M7-S2 relay merge follow-up copies it into the BullMQ payload, handlers seed a worker job context from that value (UUID fallback for older producers).

Search a campaign by filtering logs on `campaign_id`; use `trace_id` to follow one request/job attempt. Stable identifiers belong in logs and spans, never metric labels.

## Redaction

All API Pino arguments pass through fail-closed redaction. Tokens, cookies, credentials and secret values become `[REDACTED]`; bodies/subjects become byte counts plus SHA-256; custom-data keys remain but their values do not. Email-address-shaped values under unknown keys are redacted. The same rule applies when adding new call sites: never log raw recipient data or rendered email content.

## Traces

Auto-instrumentation covers HTTP and PostgreSQL. Explicit spans cover `outbox.append`, worker jobs, `provider.send_batch` and `webhook.receive`. Without an explicitly configured OTLP endpoint the trace exporter is `none`, so the default stack stays operational.

## Metrics

The API exposes `api:9464/metrics`; the worker exposes `worker:9465/metrics` inside the Compose backend network. No host port is published. Metrics include idempotent replays, bulk rows, schedule outcomes, send attempts/retries/rejections, reconciliation drift, notification lifecycle, queue lag, webhook lag and dead-letter depth. Labels are bounded enums such as `result`, `queue`, `channel`, `provider`, and `resource`.

`eow_quota_usage_ratio` is intentionally supplied by M7-S1 after its quota ledger exists.
