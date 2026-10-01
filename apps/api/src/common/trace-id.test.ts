import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { getOrCreateTraceId, TRACE_HEADER } from './trace-id.js';

function fakeRequest(headerValue?: string): Request {
  return { headers: headerValue ? { [TRACE_HEADER]: headerValue } : {} } as unknown as Request;
}

describe('getOrCreateTraceId', () => {
  it('returns the incoming header value when present', () => {
    const request = fakeRequest('client-supplied-trace-id');
    expect(getOrCreateTraceId(request)).toBe('client-supplied-trace-id');
  });

  it('generates a trace id when no header is present', () => {
    const request = fakeRequest();
    expect(getOrCreateTraceId(request)).toEqual(expect.stringMatching(/.+/));
  });

  it('returns the SAME generated id on repeated calls for the same request (no header)', () => {
    // The exception filter and any audited action both call getOrCreateTraceId
    // on the same request object. If no x-trace-id header was sent, each call
    // must resolve to the same id, or a Problem response's traceId will never
    // match the traceId stamped on the corresponding audit_log row.
    const request = fakeRequest();
    const first = getOrCreateTraceId(request);
    const second = getOrCreateTraceId(request);
    expect(second).toBe(first);
  });
});
