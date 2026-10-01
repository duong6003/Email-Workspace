import { metrics as otelMetrics } from '@opentelemetry/api';

// Labels are bounded enums only. Tenant/campaign/recipient/execution/job ids belong in logs/traces.
const meter = otelMetrics.getMeter('eow-api');
const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();
const gauges = new Map<string, ReturnType<typeof meter.createGauge>>();
const counter = (name: string) => counters.get(name) ?? counters.set(name, meter.createCounter(name)).get(name)!;
const histogram = (name: string) => histograms.get(name) ?? histograms.set(name, meter.createHistogram(name)).get(name)!;
const gauge = (name: string) => gauges.get(name) ?? gauges.set(name, meter.createGauge(name)).get(name)!;

export const metrics = {
  idempotentReplay: (resource: string) => counter('eow_idempotent_replay_total').add(1, { resource }),
  notificationCreated: () => counter('eow_notification_created_total').add(1),
  notificationDelivered: (channel: 'socket' | 'stored') => counter('eow_notification_delivered_total').add(1, { channel }),
  notificationRead: (count = 1) => counter('eow_notification_read_total').add(count),
  webhookLagSeconds: (provider: string, seconds: number) => histogram('eow_webhook_lag_seconds').record(seconds, { provider }),
  deadLetterDepth: (source: string, depth: number) => gauge('eow_dead_letter_depth').record(depth, { source }),
};
