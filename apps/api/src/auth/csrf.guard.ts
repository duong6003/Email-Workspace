import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { csrfTokensMatch } from './cookies.js';

/**
 * Double-submit CSRF check for state-changing, session-cookie-authenticated
 * routes (M1-S1 security plan). Only meaningful once a session exists, so it
 * runs after AuthGuard, never on /auth/login or /auth/forgot-password.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!csrfTokensMatch(request)) {
      throw new ForbiddenException('Missing or invalid CSRF token.');
    }
    return true;
  }
}
