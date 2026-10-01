import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCurrentUser } from '../api/auth.js';

export const SESSION_QUERY_KEY = ['auth', 'me'] as const;

/**
 * Session state is derived from the real GET /auth/me call, backed by the
 * HttpOnly session cookie — never from localStorage. A 401 simply means
 * "not authenticated" (isError, no data), which RequireAuth turns into a
 * redirect to /login.
 */
export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: getCurrentUser,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * Re-resolves the session and waits for the answer.
 *
 * `invalidateQueries` only refetches queries that currently have a mounted
 * observer. On the login screen there is none -- the guard that reads the
 * session is not rendered there -- so invalidating merely marked the query
 * stale and resolved immediately, leaving the caller to navigate while the
 * previous 401 was still the newest known state. `refetchType: 'all'` reaches
 * the inactive query too, so awaiting this actually means "the session is
 * settled" rather than "the session was flagged".
 */
export function useInvalidateSession() {
  const client = useQueryClient();
  return () => client.refetchQueries({ queryKey: SESSION_QUERY_KEY, type: 'all' });
}
