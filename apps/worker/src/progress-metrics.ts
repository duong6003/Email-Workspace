/**
 * BR-HIS-008's reconciliation metric, following apps/api's
 * notification-metrics.ts precedent (BR-NOT-016): a structured log payload
 * of identifiers and magnitudes only. No stack in this repo runs a
 * Prometheus/OTel exporter (ADR-017 names Pino + OTel as the eventual
 * destination); the log line itself is the metric until one exists.
 */
export type ProgressReconcileMetric = {
  tenantId: string;
  campaignId: string;
  executionId: string;
  drift: number;
  repairedRecipients: number;
};

/** Emits identifiers and magnitudes only; recipient addresses and subjects are intentionally excluded. */
export function progressReconcileDriftMetric(metric: ProgressReconcileMetric): Record<string, string | number> {
  return {
    metric: 'eow_progress_reconcile_drift',
    tenant_id: metric.tenantId,
    campaign_id: metric.campaignId,
    execution_id: metric.executionId,
    value: metric.drift,
    repaired_recipients: metric.repairedRecipients,
  };
}
