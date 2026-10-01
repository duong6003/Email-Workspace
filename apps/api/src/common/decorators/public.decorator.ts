import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'eow:isPublic';

/**
 * Marks a route as not requiring authentication at all (e.g. /health,
 * /auth/login). AuthGuard and PermissionGuard are both global (deny-by-
 * default per BR-AUTH-004), so any route that should be reachable without a
 * session must opt out explicitly with this decorator rather than being
 * silently skipped.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
