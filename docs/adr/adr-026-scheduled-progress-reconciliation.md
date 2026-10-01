# ADR-026: Scheduled progress reconciliation

Status: Accepted

## Decision

A scheduled worker job (`progress-reconcile`) may repair `campaign_recipient` delivery state and the denormalised `campaign_execution` progress counters from the append-only `delivery_event` ledger. Repair is monotonic-only and reuses the webhook path's own ordering and legal-transition guards (`decideWebhookOutcome`), never a second copy of that logic. Drift is written to `audit_log` and reported as the `eow_progress_reconcile_drift` metric before repair is applied; a repair also bumps `progress_seq` and republishes `campaign.progress`, and emits `rt.resync_required` to affected viewers.

## Rationale

`campaign_recipient.status` is a cache of `delivery_event`, and the stored progress summary is a further cache of that cache (ADR-016). Both can drift from webhook races, crash windows or a provider callback that lands after a campaign completes. BR-HIS-008 requires the drift be corrected, not merely observed, and requires the correction to be idempotent and audited. A scheduled repairer is the only actor positioned to close a gap a live request path cannot see (the campaign is already terminal by the time a late callback arrives).

## Alternatives

Detect and report drift without repairing it — rejected: leaves drift in place permanently, so BR-HIS-008's "sửa sai lệch" (correct the discrepancy) is never satisfied and the M6-S1 exit condition ("drift is 0 at completion") could only be met by there never having been drift, not by demonstrating repair.

Repair only within an execution's active (`sending`) window, report-only once terminal — rejected: a webhook landing after completion is exactly the case BR-HIS-008 exists for; excluding terminal executions would leave that class of drift permanent by design.
