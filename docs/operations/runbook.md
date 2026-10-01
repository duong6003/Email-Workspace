# Operations runbook

Health checks: API readiness requires PostgreSQL; worker readiness requires queue backend; realtime reports adapter state separately.

## Observability alert set (BR-SEND-013; BR-SEC-005 SLO evidence)

| Alert | Expression | Threshold / for | Severity | Action |
| --- | --- | --- | --- | --- |
| Queue age | `max(eow_queue_lag_seconds)` | `> 300` for `10m` | warning | Check Redis health, worker concurrency and the oldest waiting job. |
| Failed-job rate | `sum(rate(eow_send_attempt_total{result="failed"}[5m])) / clamp_min(sum(rate(eow_send_attempt_total[5m])), 0.001)` | `> 0.05` for `10m` | critical | Pause new sends, inspect provider/error-class logs by trace and campaign. |
| Provider rejection | `sum(rate(eow_provider_reject_total[5m]))` | `> 1` for `5m` | warning | Validate sender/provider policy and inspect permanent SMTP classifications. |
| Webhook lag | `histogram_quantile(0.95, sum by (le) (rate(eow_webhook_lag_seconds_bucket[5m])))` | `> 300` for `10m` | warning | Check provider callback delivery, clocks and API saturation. |
| Reconciliation drift | `max(eow_progress_reconcile_drift)` | `> 0` for `15m` | critical | Preserve trace evidence, reconcile canonical recipient facts, verify counters no longer decrease. |
| Notification delivery | `sum(rate(eow_notification_created_total[10m])) - sum(rate(eow_notification_delivered_total{channel="stored"}[10m]))` | `> 0` for `15m` | warning | Inspect notification writer failures; committed domain work remains authoritative. |
| Dead-letter depth | `sum(eow_dead_letter_depth)` | `> 0` for `15m` | critical | Follow the DLQ runbook, inspect tenant-scoped payload safely, then replay only after fixing the cause. |

Incident order: protect tenant boundaries → pause new sends → preserve evidence/correlation IDs → assess provider/queue/database → reconcile canonical state → resume with idempotency.

Scheduled-send misfire policy defaults to `send_if_late_within_15_minutes`; otherwise mark `missed` and notify the owner. Cancellation is allowed until the first provider submission; after that it becomes best-effort stop for unsent recipients.
