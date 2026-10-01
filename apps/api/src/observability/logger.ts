import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import { sanitizeLogValue } from './log-redaction.js';
import { getRequestContext } from './request-context.js';

export type CreateLoggerOptions = {
  level?: string;
  destination?: DestinationStream;
  service?: string;
};

function logNestMessageWith(logger: Logger, level: 'info' | 'error' | 'warn' | 'debug', message: unknown, optional: unknown[]): void {
  const context = typeof optional.at(-1) === 'string' ? optional.at(-1) as string : undefined;
  const details = context ? optional.slice(0, -1) : optional;
  const fields = {
    ...(context ? { nest_context: context } : {}),
    ...(details.length > 0 ? { details } : {}),
  };

  if (message instanceof Error) {
    logger[level]({ ...fields, err: message }, 'nest-error');
  } else if (typeof message === 'string') {
    logger[level](fields, message);
  } else {
    logger[level]({ ...fields, value: message }, 'nest-log');
  }
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return pino({
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: options.service ?? process.env.RUNTIME_PROFILE ?? 'api' },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((argument) => sanitizeLogValue(argument)) as Parameters<typeof method>);
      },
    },
    mixin() {
      const context = getRequestContext();
      return {
        trace_id: context?.traceId ?? null,
        tenant_id: context?.tenantId ?? null,
        actor_id: context?.actorId ?? null,
        module: context?.module ?? null,
        campaign_id: context?.campaignId ?? null,
      };
    },
  }, options.destination);
}

export const appLogger = createLogger();

function logNestMessage(level: 'info' | 'error' | 'warn' | 'debug', message: unknown, optional: unknown[]): void {
  logNestMessageWith(appLogger, level, message, optional);
}

export function createNestLogger(logger: Logger): LoggerService {
  return {
    log(message: unknown, ...optional: unknown[]) { logNestMessageWith(logger, 'info', message, optional); },
    error(message: unknown, ...optional: unknown[]) { logNestMessageWith(logger, 'error', message, optional); },
    warn(message: unknown, ...optional: unknown[]) { logNestMessageWith(logger, 'warn', message, optional); },
    debug(message: unknown, ...optional: unknown[]) { logNestMessageWith(logger, 'debug', message, optional); },
    verbose(message: unknown, ...optional: unknown[]) { logNestMessageWith(logger, 'debug', message, optional); },
    fatal(message: unknown, ...optional: unknown[]) { logNestMessageWith(logger, 'error', message, optional); },
  };
}

export const nestLogger: LoggerService = createNestLogger(appLogger);
