import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { AppUserEntity } from '../database/entities/app-user.entity.js';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';
import { readSessionCookie } from './cookies.js';
import { parseSessionToken } from './session-token.js';
import { PermissionsService } from './permissions.service.js';
import { SessionService } from './session.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { setTenantContext } from '../database/tenant-transaction.js';
import { updateRequestContext } from '../observability/request-context.js';

/**
 * Validates the `eow_session` cookie against `user_session` and attaches
 * `request.auth`, including the caller's resolved permission set
 * (BR-AUTH-003/004, via PermissionsService). Any failure — missing cookie,
 * malformed token, unknown, revoked or expired session, or a user that is
 * no longer active — is a generic 401 (never distinguishes reasons to a
 * client). Global (APP_GUARD): a route must opt out with @Public() to skip
 * this check entirely (e.g. /health, /auth/login).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: SessionService,
    private readonly permissions: PermissionsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const parsed = parseSessionToken(readSessionCookie(request));
    if (!parsed) throw new UnauthorizedException('Not authenticated.');

    const resolved = await this.dataSource.transaction(async (manager) => {
      const validation = await this.sessions.validate(manager, parsed.sessionId, parsed.secret);
      if (!validation) return null;
      const user = await manager.getRepository(AppUserEntity).findOne({ where: { id: validation.session.userId } });
      if (!user || user.status !== 'active') return null;
      await setTenantContext(manager, user.tenantId);
      const grantedPermissions = await this.permissions.getPermissionsForUser(manager, user.id);
      return { validation, user, grantedPermissions };
    });
    if (!resolved) throw new UnauthorizedException('Not authenticated.');
    const { validation, user, grantedPermissions } = resolved;

    request.auth = {
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      sessionId: validation.session.id,
      permissions: grantedPermissions,
    };
    updateRequestContext({ tenantId: user.tenantId, actorId: user.id });
    return true;
  }
}
