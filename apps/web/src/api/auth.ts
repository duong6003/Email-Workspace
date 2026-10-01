import type { components } from '@eow/contracts';
import { parseErrorResponse } from './problem.js';

export { ApiError, isAuthError, type Problem } from './problem.js';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

export type LoginRequest = components['schemas']['LoginRequest'];
export type Me = components['schemas']['Me'];

function readCsrfCookie(): string | undefined {
  return document.cookie
    .split('; ')
    .find((row) => row.startsWith('eow_csrf='))
    ?.split('=')[1];
}

/** POST /auth/login — on success the server sets the session + CSRF cookies; no body is returned. */
export async function login(request: LoginRequest): Promise<void> {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) await parseErrorResponse(response);
}

/** GET /auth/me — resolves the current session's profile, or throws ApiError(401) if not authenticated. */
export async function getCurrentUser(): Promise<Me> {
  const response = await fetch(`${base}/auth/me`, { credentials: 'include' });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

/** POST /auth/logout — requires the CSRF double-submit header on top of the session cookie. */
export async function logout(): Promise<void> {
  const csrfToken = readCsrfCookie();
  const response = await fetch(`${base}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
    headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
  });
  if (!response.ok && response.status !== 401) await parseErrorResponse(response);
}

export async function forgotPassword(email: string): Promise<void> {
  const response = await fetch(`${base}/auth/forgot-password`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) await parseErrorResponse(response);
}
