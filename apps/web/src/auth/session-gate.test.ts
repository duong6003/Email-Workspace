import { describe, expect, it } from 'vitest';
import { sessionGate } from './session-gate.js';

describe('session gate', () => {
  it('waits on the very first resolution, before anything is known', () => {
    expect(sessionGate({ hasData: false, isError: false, isAuthError: false, isFetching: true })).toBe('loading');
  });

  it('admits a resolved session', () => {
    expect(sessionGate({ hasData: true, isError: false, isAuthError: false, isFetching: false })).toBe('authenticated');
  });

  it('sends a settled 401 to the login screen', () => {
    expect(sessionGate({ hasData: false, isError: true, isAuthError: true, isFetching: false })).toBe('unauthenticated');
  });

  it('treats a settled non-auth failure as a system error, not a logout', () => {
    expect(sessionGate({ hasData: false, isError: true, isAuthError: false, isFetching: false })).toBe('systemError');
  });

  // The two-logins bug: after a 401 the query stays in its error state while the
  // post-login refetch is still in flight, so a guard that reads isError alone
  // bounces the user straight back to /login and makes them sign in twice.
  it('waits instead of redirecting while a refetch follows an earlier 401', () => {
    expect(sessionGate({ hasData: false, isError: true, isAuthError: true, isFetching: true })).toBe('loading');
  });

  it('waits through a refetch that follows an earlier system error too', () => {
    expect(sessionGate({ hasData: false, isError: true, isAuthError: false, isFetching: true })).toBe('loading');
  });

  // A background revalidation must not blank the app the user is already using.
  it('keeps an authenticated session on screen during a background refetch', () => {
    expect(sessionGate({ hasData: true, isError: false, isAuthError: false, isFetching: true })).toBe('authenticated');
  });

  it('treats an empty settled result as unauthenticated', () => {
    expect(sessionGate({ hasData: false, isError: false, isAuthError: false, isFetching: false })).toBe('unauthenticated');
  });
});
