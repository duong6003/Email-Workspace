import type { ReactElement } from 'react';
import { useSession } from './use-session.js';
import { hasPermission } from './permissions.js';
import { PermissionDeniedScreen } from '../screens/errors/PermissionDeniedScreen.js';

/**
 * Route-level RBAC gate (BR-AUTH-003/004). Rendered inside RequireAuth, so
 * the caller is always already authenticated here — this only decides
 * whether their role's permission set covers the route, rendering the
 * permission_denied state in place (not a redirect) when it does not.
 * Mirrors the server: the underlying API call the screen would make is
 * independently enforced by PermissionGuard, so this is a UX convenience,
 * never the actual authorization boundary (BR-AUTH-004: "API kiem quyen
 * phia server, khong dua vao viec an nut tren UI").
 */
export function RequirePermission({ permission, children }: { permission: string | string[]; children: ReactElement }): ReactElement {
  const session = useSession();

  if (session.isLoading) {
    return (
      <div className="auth-loading" role="status" aria-live="polite">
        <span className="login-spinner" /> Đang tải phiên đăng nhập...
      </div>
    );
  }

  if (!hasPermission(session.data?.permissions, permission)) {
    return <PermissionDeniedScreen />;
  }

  return children;
}
