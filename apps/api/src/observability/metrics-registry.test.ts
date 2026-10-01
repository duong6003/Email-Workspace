import { describe, expect, it } from 'vitest';
import { metrics } from './metrics-registry.js';

describe('metrics registry', () => {
  it('BR-SEND-013: exposes bounded-label helpers without raw identifier parameters', () => {
    expect(Object.keys(metrics).sort()).toEqual(['deadLetterDepth','idempotentReplay','notificationCreated','notificationDelivered','notificationRead','webhookLagSeconds'].sort());
    expect(metrics.notificationCreated.length).toBe(0);
    expect(metrics.notificationDelivered.length).toBe(1);
  });
});
