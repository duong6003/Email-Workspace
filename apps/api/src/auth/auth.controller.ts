import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException, UseGuards, UsePipes } from '@nestjs/common';
import type { Request, Response } from 'express';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { TooManyRequestsException } from '../common/too-many-requests.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { clearCsrfCookie, clearSessionCookie, readSessionCookie, setCsrfCookie, setSessionCookie } from './cookies.js';
import { forgotPasswordRequestSchema, resetPasswordRequestSchema } from './dto/forgot-password.dto.js';
import { loginRequestSchema } from './dto/login.dto.js';
import { parseSessionToken } from './session-token.js';
import type { AuthenticatedRequest } from './authenticated-request.js';

const SESSION_COOKIE_MAX_AGE_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_MAX_AGE_DEFAULT_MS = 12 * 60 * 60 * 1000;

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @UsePipes(new ZodValidationPipe(loginRequestSchema))
  @HttpCode(204)
  async login(@Body() body: { email: string; password: string; remember: boolean }, @Req() req: Request, @Res() res: Response): Promise<void> {
    const traceId = getOrCreateTraceId(req);
    const outcome = await this.auth.login(body.email, body.password, body.remember, {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      traceId,
    });

    if (!outcome.ok) {
      if (outcome.reason === 'locked') {
        throw new TooManyRequestsException('Too many failed attempts. Try again later.', outcome.retryAfterSeconds);
      }
      // BR-AUTH-001: invalid credentials always return the same generic message.
      throw new UnauthorizedException('Invalid email or password.');
    }

    const maxAge = body.remember ? SESSION_COOKIE_MAX_AGE_REMEMBER_MS : SESSION_COOKIE_MAX_AGE_DEFAULT_MS;
    setSessionCookie(res, outcome.issued.token.raw, maxAge);
    setCsrfCookie(res, maxAge);
    res.status(204).end();
  }

  @Post('refresh')
  @RequirePermission(PERMISSIONS.SESSION_MANAGE)
  @UseGuards(CsrfGuard)
  @HttpCode(204)
  // BR-SEC-002/M1-S3: single-outcome action (reached only once AuthGuard has
  // already validated the caller), so it is audited declaratively by
  // AuditInterceptor instead of a hand-written appendAuditLog() call.
  // entityId is the *old* session being rotated (request.auth is populated
  // once, by AuthGuard, before this handler runs, from the still-current cookie).
  @AuditLog({ action: 'auth.session_refreshed', entityType: 'user_session', resolveEntityId: ({ request }) => request.auth?.sessionId ?? null })
  async refresh(@Req() req: AuthenticatedRequest, @Res() res: Response): Promise<void> {
    const parsed = parseSessionToken(readSessionCookie(req));
    if (!parsed) throw new UnauthorizedException('Not authenticated.');

    const issued = await this.auth.refresh(parsed.sessionId, parsed.secret, true);
    if (!issued) throw new UnauthorizedException('Not authenticated.');

    setSessionCookie(res, issued.token.raw, SESSION_COOKIE_MAX_AGE_REMEMBER_MS);
    setCsrfCookie(res, SESSION_COOKIE_MAX_AGE_REMEMBER_MS);
    res.status(204).end();
  }

  @Post('logout')
  @RequirePermission(PERMISSIONS.SESSION_MANAGE)
  @UseGuards(CsrfGuard)
  @HttpCode(204)
  // BR-SEC-002/M1-S3: same rationale as refresh() above — a single-outcome
  // action, audited declaratively rather than by hand.
  @AuditLog({ action: 'auth.logout', entityType: 'user_session', resolveEntityId: ({ request }) => request.auth?.sessionId ?? null })
  async logout(@Req() req: AuthenticatedRequest, @Res() res: Response): Promise<void> {
    const auth = req.auth!;
    await this.auth.logout(auth.sessionId);
    clearSessionCookie(res);
    clearCsrfCookie(res);
    res.status(204).end();
  }

  @Get('me')
  @RequirePermission(PERMISSIONS.SESSION_MANAGE)
  async me(@Req() req: AuthenticatedRequest) {
    const auth = req.auth!;
    const user = await this.auth.me(auth.userId);
    if (!user) throw new UnauthorizedException('Not authenticated.');
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      // AuthGuard already resolved this request's permission set onto
      // req.auth; reuse it rather than re-querying so /auth/me can never
      // disagree with what the just-ran PermissionGuard checked against.
      permissions: auth.permissions,
    };
  }

  @Post('forgot-password')
  @Public()
  @UsePipes(new ZodValidationPipe(forgotPasswordRequestSchema))
  @HttpCode(202)
  async forgotPassword(@Body() body: { email: string }, @Req() req: Request): Promise<void> {
    await this.auth.forgotPassword(body.email, getOrCreateTraceId(req));
  }

  @Post('reset-password')
  @Public()
  @UsePipes(new ZodValidationPipe(resetPasswordRequestSchema))
  @HttpCode(204)
  async resetPassword(@Body() body: { token: string; password: string }, @Req() req: Request): Promise<void> {
    const result = await this.auth.resetPassword(body.token, body.password, getOrCreateTraceId(req));
    if (!result.ok) throw new UnauthorizedException('Reset token is invalid, used or expired.');
  }
}
