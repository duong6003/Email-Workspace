import type { ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { isAuthError } from '../api/problem.js';
import { SystemErrorScreen } from '../screens/errors/SystemErrorScreen.js';
import { sessionGate } from './session-gate.js';
import { useSession } from './use-session.js';

/**
 * Route guard: unauthenticated (401) → redirect to /login, preserving the
 * attempted path for a post-login return. Any other failure (backend
 * outage, network error) is a system error, not "please log in" -- it
 * renders SystemErrorScreen with a retry instead of silently discarding the
 * user's location on a redirect they did not cause (M1-S3 fix).
 *
 * The decision itself lives in `sessionGate`, where the ordering that makes a
 * post-login refetch outrank the 401 it replaces is pinned by tests.
 */
export function RequireAuth({ children }: { children: ReactElement }): ReactElement {
  const location = useLocation();
  const session = useSession();

  const gate = sessionGate({
    hasData: Boolean(session.data),
    isError: session.isError,
    isAuthError: isAuthError(session.error),
    isFetching: session.isFetching,
  });

  if (gate === 'loading') {
    return (
      <div className="auth-loading" role="status" aria-live="polite">
        <span className="login-spinner" /> Đang tải phiên đăng nhập...
      </div>
    );
  }

  if (gate === 'systemError') return <SystemErrorScreen onRetry={() => session.refetch()} />;
  if (gate === 'unauthenticated') return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return children;
}
