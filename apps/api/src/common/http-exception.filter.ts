import { ArgumentsHost, Catch, ExceptionFilter, PayloadTooLargeException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { mapErrorToProblem } from './problem.js';
import { getOrCreateTraceId } from './trace-id.js';
import { TooManyRequestsException } from './too-many-requests.exception.js';
import { appLogger } from '../observability/logger.js';

function isBodyParserPayloadTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  return candidate.type === 'entity.too.large' && (candidate.status === 413 || candidate.statusCode === 413);
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const traceId = getOrCreateTraceId(request);
    const mappedError = isBodyParserPayloadTooLargeError(error)
      ? new PayloadTooLargeException('Request body exceeds the maximum allowed size.')
      : error;
    const problem = mapErrorToProblem(mappedError, traceId);

    if (problem.status >= 500) {
      appLogger.error({ err: error }, 'unhandled-error');
    }

    if (error instanceof TooManyRequestsException) {
      response.header('Retry-After', String(error.retryAfterSeconds));
    }

    response.status(problem.status).header('content-type', 'application/problem+json').json(problem);
  }
}
