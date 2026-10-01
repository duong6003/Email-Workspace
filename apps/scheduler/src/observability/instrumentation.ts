import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !process.env.OTEL_TRACES_EXPORTER) process.env.OTEL_TRACES_EXPORTER = 'none';
const sdk = new NodeSDK({ serviceName: process.env.RUNTIME_PROFILE ?? 'scheduler', instrumentations: [getNodeAutoInstrumentations()] });
sdk.start();
export { sdk as telemetrySdk };
