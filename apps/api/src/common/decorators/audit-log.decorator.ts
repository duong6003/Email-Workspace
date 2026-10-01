import { SetMetadata } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../auth/authenticated-request.js';

export const AUDIT_LOG_KEY = 'eow:auditLog';

export type AuditLogMetadata = {
  /** Base action name, e.g. 'auth.logout'. A failed handler is audited as `${action}.failed`. */
  action: string;
  entityType: string;
  /**
   * Resolves the audited entity's id from the request/response of a single
   * invocation. Optional — omit when there is no natural single entity
   * (defaults to null, which is still a valid audit_log row per BR-SEC-002).
   */
  resolveEntityId?: (ctx: { request: AuthenticatedRequest; result: unknown }) => string | null;
};

/**
 * Declarative, convention-based audit logging (EXECPLAN §14 / M1-S3): a
 * handler opts in with @AuditLog({ action, entityType }) instead of every
 * module hand-wiring its own appendAuditLog() call. AuditInterceptor reads
 * this metadata and writes the row after the handler resolves (success) or
 * throws (failure), always keyed by the same traceId the RFC 9457 exception
 * filter uses for the Problem response.
 *
 * Left untouched: branchy, multi-outcome actions that need to write
 * different audit rows depending on which internal branch fired (e.g.
 * auth.service.ts's login/login_failed/locked, which also need atomicity
 * with the login-attempt/session writes inside the same DB transaction) —
 * those keep calling appendAuditLog() directly. This decorator is for the
 * common case: one handler, one outcome.
 */
export const AuditLog = (metadata: AuditLogMetadata) => SetMetadata(AUDIT_LOG_KEY, metadata);
