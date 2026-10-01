import pino from 'pino';

export const schedulerLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  messageKey: 'msg',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: process.env.RUNTIME_PROFILE ?? 'scheduler' },
  redact: { paths: ['*.password', '*.secret', '*.token', '*.cookie', '*.authorization'], censor: '[REDACTED]' },
});
