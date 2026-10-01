import { metrics as otelMetrics } from '@opentelemetry/api';

// Bounded labels only; identifiers stay in correlated logs and traces.
const meter = otelMetrics.getMeter('eow-worker');
const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();
const gauges = new Map<string, ReturnType<typeof meter.createGauge>>();
const counter = (name: string) => counters.get(name) ?? counters.set(name, meter.createCounter(name)).get(name)!;
const histogram = (name: string) => histograms.get(name) ?? histograms.set(name, meter.createHistogram(name)).get(name)!;
const gauge = (name: string) => gauges.get(name) ?? gauges.set(name, meter.createGauge(name)).get(name)!;

export const jobMetrics = {
  bulkRows: (result: 'succeeded' | 'failed' | 'skipped', count: number) => counter('eow_bulk_rows_total').add(count, { result }),
  scheduleMisfire: (outcome: 'missed' | 'blocked' | 'dispatched') => counter('eow_schedule_misfire_total').add(1, { outcome }),
  sendAttempt: (result: 'submitted' | 'retrying' | 'failed', count: number) => counter('eow_send_attempt_total').add(count, { result }),
  sendRetry: (count: number) => counter('eow_send_retry_total').add(count),
  providerReject: (count: number) => counter('eow_provider_reject_total').add(count),
  progressReconcileDrift: (drift: number) => gauge('eow_progress_reconcile_drift').record(drift),
  notificationCreated: () => counter('eow_notification_created_total').add(1),
  notificationDelivered: (channel: 'socket' | 'stored') => counter('eow_notification_delivered_total').add(1, { channel }),
  queueLagSeconds: (queue: string, seconds: number) => gauge('eow_queue_lag_seconds').record(seconds, { queue }),
  webhookLagSeconds: (provider: string, seconds: number) => histogram('eow_webhook_lag_seconds').record(seconds, { provider }),
};
