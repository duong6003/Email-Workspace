import { HttpException, Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { Observable } from 'rxjs';
import { catchError, concatMap, from, of, throwError } from 'rxjs';
import { AUDIT_LOG_KEY, type AuditLogMetadata } from '../decorators/audit-log.decorator.js';
import { appendAuditLog } from '../audit-writer.js';
import { getOrCreateTraceId } from '../trace-id.js';
import type { AuthenticatedRequest } from '../../auth/authenticated-request.js';
import { runInTenantContext } from '../../database/tenant-transaction.js';

/**
 * Global, convention-based audit logging (EXECPLAN §14 / M1-S3). A no-op for
 * any handler that does not carry @AuditLog(...) — safe to register once as
 * APP_INTERCEPTOR rather than wiring per-module. See audit-log.decorator.ts
 * for why the pre-existing branchy auth.service.ts writes are left as direct
 * appendAuditLog() calls instead of being migrated here.
 *
 * The audit write is awaited (concatMap, not a fire-and-forget tap) so it is
 * guaranteed to have committed before the HTTP response is sent — a test
 * that queries audit_log immediately after receiving the response must never
 * race the write.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.getAllAndOverride<AuditLogMetadata | undefined>(AUDIT_LOG_KEY, [context.getHandler(), context.getClass()]);
    if (!metadata) return next.handle();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const traceId = getOrCreateTraceId(request);
    const auth = request.auth;

    return next.handle().pipe(
      concatMap((result) => {
        if (!auth) return of(result);
        return from(this.write(metadata, request, auth, traceId, metadata.action, undefined, result)).pipe(concatMap(() => of(result)));
      }),
      catchError((error: unknown) => {
        if (!auth) return throwError(() => error);
        return from(this.write(metadata, request, auth, traceId, `${metadata.action}.failed`, error)).pipe(concatMap(() => throwError(() => error)));
      }),
    );
  }

  private async write(
    metadata: AuditLogMetadata,
    request: AuthenticatedRequest,
    auth: NonNullable<AuthenticatedRequest['auth']>,
    traceId: string,
    action: string,
    error?: unknown,
    result?: unknown,
  ): Promise<void> {
    const entityId = metadata.resolveEntityId ? metadata.resolveEntityId({ request, result }) : null;

    await runInTenantContext(this.dataSource, auth.tenantId, (manager) => appendAuditLog(manager, {
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action,
      entityType: metadata.entityType,
      entityId,
      traceId,
      // Never the raw error message/stack (may contain internals, see
      // problem.ts's own comment on the same concern) — only the HTTP
      // status a client actually saw, if it was an HttpException.
      metadata: error !== undefined ? { status: error instanceof HttpException ? error.getStatus() : undefined } : {},
    }));
  }
}
