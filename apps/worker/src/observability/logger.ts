import pino, { type DestinationStream, type Logger } from 'pino';
import { getJobContext } from './job-context.js';

export function createWorkerLogger(destination?: DestinationStream): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: process.env.RUNTIME_PROFILE ?? 'worker' },
    redact: {
      paths: ['*.password', '*.secret', '*.token', '*.cookie', '*.authorization', '*.html', '*.text', '*.subject'],
      censor: '[REDACTED]',
    },
    mixin() {
      const context = getJobContext();
      return {
        trace_id: context?.traceId ?? null,
        tenant_id: context?.tenantId ?? null,
        job_name: context?.jobName ?? null,
        job_id: context?.jobId ?? null,
        campaign_id: context?.campaignId ?? null,
      };
    },
  }, destination);
}

export const workerLogger = createWorkerLogger();
