import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

export const TRACE_HEADER = 'x-trace-id';

/**
 * A request carrying a memo slot for the trace id computed for it. Without
 * this, a request that does not send x-trace-id would get a *different*
 * generated id from every separate call site that asks for one (e.g. the
 * controller when writing an audit_log row, and the exception filter when
 * building the Problem response) — silently breaking the traceId <->
 * audit_log correlation this node exists to guarantee (M1-S3, D-26). An
 * intersection type (matching `AuthenticatedRequest`'s own pattern in
 * ../auth/authenticated-request.ts) rather than `declare module
 * 'express-serve-static-core'`, whose types are not resolvable as an
 * augmentation target in this project's module setup.
 */
type RequestWithTraceId = Request & { traceId?: string };

/**
 * Reads the incoming trace id header, or generates one — shared by the
 * exception filter and every audited action. Memoized on the request object
 * itself so repeated calls for the *same* request always agree, whether or
 * not the client supplied x-trace-id.
 */
export function getOrCreateTraceId(request: Request): string {
  const req = request as RequestWithTraceId;
  if (req.traceId) return req.traceId;

  const header = request.headers[TRACE_HEADER];
  const traceId = typeof header === 'string' && header.length > 0 ? header : randomUUID();
  req.traceId = traceId;
  return traceId;
}
