import { describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';

describe('OpenTelemetry bootstrap', () => {
  it('BR-SEND-013: explicit hop spans execute normally without an OTLP endpoint', async () => {
    const previous = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const value = await trace.getTracer('eow-test').startActiveSpan('outbox.append', async (span) => {
      span.setAttribute('eow.aggregate_type', 'campaign');
      span.end();
      return 'ok';
    });
    expect(value).toBe('ok');
    if (previous) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous;
  });
});
