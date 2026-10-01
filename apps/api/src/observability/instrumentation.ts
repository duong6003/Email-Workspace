import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !process.env.OTEL_TRACES_EXPORTER) process.env.OTEL_TRACES_EXPORTER = 'none';
const prometheus = new PrometheusExporter({ host: '0.0.0.0', port: Number(process.env.METRICS_PORT ?? 9464), endpoint: '/metrics' });
const sdk = new NodeSDK({ serviceName: process.env.RUNTIME_PROFILE ?? 'api', instrumentations: [getNodeAutoInstrumentations()], metricReaders: [prometheus] });
sdk.start();
export { sdk as telemetrySdk };
