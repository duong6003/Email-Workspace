import { afterAll, describe, expect, it } from 'vitest';

const port = 19464;
process.env.METRICS_PORT = String(port);
const { telemetrySdk } = await import('../../src/observability/instrumentation.js');
const { metrics } = await import('../../src/observability/metrics-registry.js');

afterAll(async () => { await telemetrySdk.shutdown(); });

describe('Prometheus exposition', () => {
  it('BR-SEND-013: serves a real internal /metrics exposition without identifiers', async () => {
    metrics.notificationCreated();
    let response: Response | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { response = await fetch(`http://127.0.0.1:${port}/metrics`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    expect(response?.status).toBe(200);
    const body = await response!.text();
    expect(body).toContain('# HELP');
    expect(body).toContain('eow_notification_created_total');
    expect(body).not.toMatch(/tenant_id|campaign_id|recipient_id|alice@example/i);
  });
});
