export type SessionGate = 'loading' | 'authenticated' | 'unauthenticated' | 'systemError';

/**
 * What a route guard should do with the session query's current state.
 *
 * The ordering here is the whole point. React Query keeps a query in its
 * `error` state across a subsequent refetch, and `isLoading` is false once a
 * query has failed at least once. So immediately after a successful login --
 * cookies set, refetch in flight, previous 401 still recorded -- a guard that
 * checks `isError` before `isFetching` redirects to /login, and the user has to
 * sign in a second time for the cache to hold a resolved session.
 *
 * An in-flight fetch with nothing to show therefore outranks a stale error.
 * Data outranks fetching, so a background revalidation never blanks a screen
 * the user is already working in.
 *
 * Kept free of React and of the query library so the ordering can be pinned by
 * tests without a DOM, a router or a fake server.
 */
export function sessionGate(input: {
  hasData: boolean;
  isError: boolean;
  isAuthError: boolean;
  isFetching: boolean;
}): SessionGate {
  if (input.hasData) return 'authenticated';
  if (input.isFetching) return 'loading';
  if (input.isError) return input.isAuthError ? 'unauthenticated' : 'systemError';
  return 'unauthenticated';
}
