import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { appendAuditLog } from '../audit-writer.js';
import { getOrCreateTraceId } from '../trace-id.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { REQUIRED_PERMISSION_KEY } from '../decorators/require-permission.decorator.js';
import type { AuthenticatedRequest } from '../../auth/authenticated-request.js';
import { runInTenantContext } from '../../database/tenant-transaction.js';

/**
 * Server-side deny-by-default RBAC (BR-AUTH-003/BR-AUTH-004). Runs after the
 * global AuthGuard, which populates request.auth.permissions from
 * user_role -> role_permission. A route is allowed only if it is explicitly
 * @Public() or declares @RequirePermission(...) and the caller holds at
 * least one of the listed permissions. A route with neither decorator is
 * rejected — declaring intent is mandatory, not optional.
 *
 * Every denial writes an audit_log row (action=rbac.denied) naming the
 * actor and the endpoint, per BR-AUTH-004's acceptance text ("log ghi actor
 * và endpoint").
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const required = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_PERMISSION_KEY, [context.getHandler(), context.getClass()]);

    const endpoint = `${request.method} ${request.route?.path ?? request.path}`;

    if (!required) {
      // Deny-by-default: a route that declares neither @Public() nor
      // @RequirePermission() is a bug, not an implicit allow.
      await this.denyAndAudit(request, endpoint, []);
      throw new ForbiddenException('Access denied.');
    }

    const granted = request.auth?.permissions ?? [];
    const allowed = required.length === 0 || required.some((key) => granted.includes(key));
    if (!allowed) {
      await this.denyAndAudit(request, endpoint, required);
      throw new ForbiddenException('Access denied.');
    }

    return true;
  }

  private async denyAndAudit(request: AuthenticatedRequest, endpoint: string, required: string[]): Promise<void> {
    const auth = request.auth;
    // AuthGuard (which runs before this guard) always populates request.auth
    // for a non-public route, so this should never be undefined in
    // production. If it somehow is, there is no real tenant/actor to
    // attribute an audit row to (writing one would violate audit_log's
    // tenant_id FK) — skip the write rather than insert a garbage row; the
    // ForbiddenException is still thrown by the caller either way.
    if (!auth) return;

    await runInTenantContext(this.dataSource, auth.tenantId, (manager) => appendAuditLog(manager, {
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'rbac.denied',
      entityType: 'route',
      entityId: null,
      traceId: getOrCreateTraceId(request),
      metadata: { endpoint, requiredPermission: required, actorRole: auth.role },
    }));
  }
}
