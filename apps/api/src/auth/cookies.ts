import type { CookieOptions, Request, Response } from 'express';

export const SESSION_COOKIE = 'eow_session';
export const CSRF_COOKIE = 'eow_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * The `Secure` attribute must track whether the browser actually reached us
 * over TLS — not NODE_ENV. compose.yaml sets NODE_ENV=production for the api
 * container, but the one-command deployment's own docs (quick-deploy.md
 * "Production boundary") are explicit that this baseline serves the app over
 * plain HTTP on :8080 and defers "TLS at the edge" to a later hardening
 * step. A Secure cookie is silently dropped by the browser over HTTP, which
 * would have made login *appear* to succeed (204, Set-Cookie sent) while the
 * cookie never actually got stored — passing shallow checks and breaking
 * for a real user. WEB_ORIGIN's scheme is the real signal for whether
 * cookies need Secure.
 */
export function originRequiresSecureCookies(webOrigin: string | undefined): boolean {
  return (webOrigin ?? '').startsWith('https://');
}

function baseCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: originRequiresSecureCookies(process.env.WEB_ORIGIN),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

/** Sets the Secure HttpOnly SameSite=Lax session cookie (BR-AUTH-002 / M1-S1 security plan). */
export function setSessionCookie(res: Response, rawToken: string, maxAgeMs: number): void {
  res.cookie(SESSION_COOKIE, rawToken, baseCookieOptions(maxAgeMs));
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * CSRF double-submit cookie: readable by JS (not HttpOnly) so the SPA can
 * mirror it into the `x-csrf-token` header on state-changing requests. An
 * attacker forging a cross-site request cannot read this cookie under the
 * same-origin policy, so they cannot produce a matching header.
 */
export function setCsrfCookie(res: Response, maxAgeMs: number): string {
  const token = crypto.randomUUID();
  res.cookie(CSRF_COOKIE, token, { httpOnly: false, secure: originRequiresSecureCookies(process.env.WEB_ORIGIN), sameSite: 'lax', path: '/', maxAge: maxAgeMs });
  return token;
}

export function clearCsrfCookie(res: Response): void {
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

export function readSessionCookie(req: Request): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
}

export function csrfTokensMatch(req: Request): boolean {
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];
  if (!cookieToken || !headerToken || Array.isArray(headerToken)) return false;
  return cookieToken === headerToken;
}
