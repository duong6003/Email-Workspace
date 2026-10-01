import { HttpException, HttpStatus } from '@nestjs/common';

export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  category: ProblemCategory;
  messageKey: string;
  retryable: boolean;
  fieldErrors?: ProblemFieldError[];
  nextAction?: string;
  traceId: string;
} & Record<string, unknown>;

export type ProblemCategory = 'validation' | 'authentication' | 'permission' | 'not_found' | 'conflict' | 'rate_limit' | 'server';
export type ProblemFieldError = { field: string; code: string; message?: string; value?: unknown };

const STATUS_TITLES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
};

function detailFrom(response: unknown, fallback: string): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'message' in response) {
    const message = (response as { message: unknown }).message;
    if (Array.isArray(message)) return message.join('; ');
    if (typeof message === 'string') return message;
  }
  return fallback;
}

const DEFAULT_PROBLEMS: Record<number, { code: string; category: ProblemCategory; messageKey: string; retryable: boolean }> = {
  [HttpStatus.BAD_REQUEST]: { code: 'VALIDATION_FAILED', category: 'validation', messageKey: 'error.validationFailed', retryable: false },
  [HttpStatus.UNAUTHORIZED]: { code: 'AUTH_REQUIRED', category: 'authentication', messageKey: 'error.authRequired', retryable: false },
  [HttpStatus.FORBIDDEN]: { code: 'ACCESS_DENIED', category: 'permission', messageKey: 'error.accessDenied', retryable: false },
  [HttpStatus.NOT_FOUND]: { code: 'RESOURCE_NOT_FOUND', category: 'not_found', messageKey: 'error.resourceNotFound', retryable: false },
  [HttpStatus.CONFLICT]: { code: 'RESOURCE_CONFLICT', category: 'conflict', messageKey: 'error.resourceConflict', retryable: false },
  [HttpStatus.PRECONDITION_FAILED]: { code: 'VERSION_CONFLICT', category: 'conflict', messageKey: 'error.versionConflict', retryable: false },
  [HttpStatus.PRECONDITION_REQUIRED]: { code: 'PRECONDITION_REQUIRED', category: 'conflict', messageKey: 'error.preconditionRequired', retryable: false },
  [HttpStatus.PAYLOAD_TOO_LARGE]: { code: 'PAYLOAD_TOO_LARGE', category: 'validation', messageKey: 'error.payloadTooLarge', retryable: false },
  [HttpStatus.UNPROCESSABLE_ENTITY]: { code: 'UNPROCESSABLE_ENTITY', category: 'validation', messageKey: 'error.unprocessableEntity', retryable: false },
  [HttpStatus.TOO_MANY_REQUESTS]: { code: 'RATE_LIMITED', category: 'rate_limit', messageKey: 'error.rateLimited', retryable: true },
  [HttpStatus.INTERNAL_SERVER_ERROR]: { code: 'INTERNAL_ERROR', category: 'server', messageKey: 'error.internal', retryable: true },
  [HttpStatus.BAD_GATEWAY]: { code: 'UPSTREAM_FAILURE', category: 'server', messageKey: 'error.upstreamFailure', retryable: true },
  [HttpStatus.SERVICE_UNAVAILABLE]: { code: 'SERVICE_UNAVAILABLE', category: 'server', messageKey: 'error.serviceUnavailable', retryable: true },
  [HttpStatus.GATEWAY_TIMEOUT]: { code: 'UPSTREAM_TIMEOUT', category: 'server', messageKey: 'error.upstreamTimeout', retryable: true },
};

function explicitString(response: unknown, key: string): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const value = (response as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function explicitBoolean(response: unknown, key: string): boolean | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const value = (response as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

function camelMessageKey(code: string): string {
  const [first, ...rest] = code.toLowerCase().split('_');
  return `error.${first}${rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`;
}

function normalizeFieldErrors(response: unknown): ProblemFieldError[] | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const supplied = (response as Record<string, unknown>).fieldErrors;
  if (Array.isArray(supplied)) {
    const normalized = supplied.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as Record<string, unknown>;
      if (typeof value.field !== 'string' || typeof value.code !== 'string') return [];
      return [{ field: value.field, code: value.code, ...(typeof value.message === 'string' ? { message: value.message } : {}), ...('value' in value ? { value: value.value } : {}) }];
    });
    return normalized.length > 0 ? normalized : undefined;
  }
  const message = (response as Record<string, unknown>).message;
  if (!Array.isArray(message)) return undefined;
  const parsed = message.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    const separator = entry.indexOf(' ');
    if (separator <= 0) return [];
    const field = entry.slice(0, separator).replace(/:$/, '');
    if (!field || field === '(body)') return [];
    return [{ field, code: 'INVALID_VALUE', message: entry.slice(separator + 1) }];
  });
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Structured HttpException bodies beyond the standard `message` carry
 * caller-relevant data (e.g. BR-CF-003's `reservedKeys`, BR-REC-001's
 * `recipientId` on a 409) that the RFC 9457 Problem response must not
 * silently drop. `message`/`statusCode`/`error` are Nest's own default
 * exception-body fields, already represented by `detail`/`status`/`title`,
 * so they are excluded to avoid duplicating them under a second name.
 */
function extensionsFrom(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== 'object') return {};
  const {
    message: _message,
    statusCode: _statusCode,
    error: _error,
    code: _code,
    category: _category,
    messageKey: _messageKey,
    retryable: _retryable,
    fieldErrors: _fieldErrors,
    nextAction: _nextAction,
    ...rest
  } = response as Record<string, unknown>;
  return rest;
}

/**
 * Maps any thrown value to an RFC 9457 problem body. Unknown (non-HttpException)
 * errors always collapse to a generic 500 detail — the real message may contain
 * internals (stack context, connection strings) that must never reach a client
 * or a log field a security review expects to be safe (BR-SEC-003).
 */
export function mapErrorToProblem(error: unknown, traceId: string): Problem {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const response = error.getResponse();
    const fallback = DEFAULT_PROBLEMS[status] ?? {
      code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED',
      category: status >= 500 ? 'server' as const : 'validation' as const,
      messageKey: status >= 500 ? 'error.internal' : 'error.requestFailed',
      retryable: status >= 500,
    };
    const code = explicitString(response, 'code') ?? fallback.code;
    const fieldErrors = normalizeFieldErrors(response);
    return {
      type: 'about:blank',
      title: STATUS_TITLES[status] ?? error.name,
      status,
      detail: detailFrom(response, error.message),
      code,
      category: fallback.category,
      messageKey: explicitString(response, 'messageKey') ?? (code === fallback.code ? fallback.messageKey : camelMessageKey(code)),
      retryable: explicitBoolean(response, 'retryable') ?? fallback.retryable,
      ...(fieldErrors ? { fieldErrors } : {}),
      ...(explicitString(response, 'nextAction') ? { nextAction: explicitString(response, 'nextAction') } : {}),
      traceId,
      ...extensionsFrom(response),
    };
  }

  return {
    type: 'about:blank',
    title: 'Internal Server Error',
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    detail: 'An unexpected error occurred.',
    code: 'INTERNAL_ERROR',
    category: 'server',
    messageKey: 'error.internal',
    retryable: true,
    traceId,
  };
}
