import { describe, expect, it } from 'vitest';
import { ApiError, errorPresentation, isAuthError, parseErrorResponse } from './problem.js';

describe('parseErrorResponse', () => {
  it('parses a well-formed application/problem+json body into a typed ApiError', async () => {
    const response = new Response(JSON.stringify({ title: 'Unauthorized', status: 401, detail: 'Invalid session', code: 'AUTH_REQUIRED', category: 'authentication', messageKey: 'error.authRequired', retryable: false, traceId: 't-1' }), {
      status: 401,
      headers: { 'content-type': 'application/problem+json' },
    });

    await expect(parseErrorResponse(response)).rejects.toMatchObject({
      status: 401,
      problem: { title: 'Unauthorized', detail: 'Invalid session', traceId: 't-1' },
    });
  });

  it('still produces a typed ApiError when the body is missing or not JSON', async () => {
    const response = new Response('<html>502 Bad Gateway</html>', { status: 502 });

    const error = await parseErrorResponse(response).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).problem).toBeNull();
  });

  it('maps a known machine code to actionable Vietnamese copy', () => {
    const error = new ApiError(422, {
      type: 'about:blank', title: 'Unprocessable Entity', status: 422,
      detail: 'Template contains variables that do not exist.',
      code: 'TEMPLATE_UNKNOWN_VARIABLE', category: 'validation',
      messageKey: 'template.unknownVariable', retryable: false,
      nextAction: 'OPEN_CUSTOM_FIELDS', traceId: 'trace-variable',
    });

    expect(error.message).toContain('biến dữ liệu chưa tồn tại');
    expect(errorPresentation(error)).toEqual(expect.objectContaining({
      code: 'TEMPLATE_UNKNOWN_VARIABLE',
      action: 'OPEN_CUSTOM_FIELDS',
      traceId: 'trace-variable',
      retryable: false,
    }));
  });

  it('degrades an unknown code safely and retains the trace id', () => {
    const error = new ApiError(503, {
      type: 'about:blank', title: 'Service Unavailable', status: 503,
      detail: 'internal host api-1 failed', code: 'NEW_BACKEND_CODE',
      category: 'server', messageKey: 'error.unknown', retryable: true,
      traceId: 'trace-new',
    });

    expect(error.message).not.toContain('api-1');
    expect(errorPresentation(error)).toMatchObject({ retryable: true, traceId: 'trace-new' });
  });
});

describe('isAuthError', () => {
  it('is true only for a 401 ApiError', () => {
    expect(isAuthError(new ApiError(401, null))).toBe(true);
  });

  it('is false for a non-401 ApiError, so a backend outage is never mistaken for "not logged in"', () => {
    expect(isAuthError(new ApiError(500, null))).toBe(false);
    expect(isAuthError(new ApiError(403, null))).toBe(false);
  });

  it('is false for a non-ApiError (e.g. a network failure)', () => {
    expect(isAuthError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});
