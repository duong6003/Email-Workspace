import { parseErrorResponse } from './problem.js';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

export type UnsubscribeTarget = { email: string; alreadyUnsubscribed: boolean };

/**
 * ADR-049. The only two calls in this app made by someone who is not a user of
 * it, so they are the only two that send no credentials: no cookies, no CSRF
 * header. The capability is the signed token in the URL and nothing else.
 *
 * `credentials: 'omit'` is explicit rather than left to the default. A
 * recipient who happens to also be a logged-in operator must get the same
 * answer as one who is not -- an unsubscribe that behaved differently when a
 * session cookie rode along would be a different route depending on who
 * clicked.
 */
async function call(path: string, method: 'GET' | 'POST'): Promise<UnsubscribeTarget> {
  const response = await fetch(`${base}/unsubscribe/${encodeURIComponent(path)}`, { method, credentials: 'omit' });
  if (!response.ok) throw await parseErrorResponse(response);
  return (await response.json()) as UnsubscribeTarget;
}

/** Read-only: what the confirmation page shows. Never changes anything -- see the screen's comment on mail scanners. */
export const describeUnsubscribe = (token: string): Promise<UnsubscribeTarget> => call(token, 'GET');

/** The act, behind the recipient's own click. */
export const redeemUnsubscribe = (token: string): Promise<UnsubscribeTarget> => call(token, 'POST');
