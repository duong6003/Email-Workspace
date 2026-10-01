import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../permissions.js';

export const REQUIRED_PERMISSION_KEY = 'eow:requiredPermission';

/**
 * Declares the permission(s) a route requires (BR-AUTH-004: server-side
 * enforcement, not UI hiding). PermissionGuard is deny-by-default: any
 * authenticated route that does not carry this decorator (or @Public()) is
 * rejected with 403. Multiple keys are OR'd — the caller needs at least one.
 */
export const RequirePermission = (...permissions: PermissionKey[]) => SetMetadata(REQUIRED_PERMISSION_KEY, permissions);
