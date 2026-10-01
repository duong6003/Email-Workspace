import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * ADR-049 -- the capability an unsubscribe link carries.
 *
 * Until this module existed, `{{unsubscribe_url}}` rendered
 * `{origin}/unsubscribe/{recipientId}` with a bare UUID and nothing to redeem
 * it. `recipient-variable-context.ts` said so in as many words: "Nothing
 * redeems this URL yet (no public unsubscribe endpoint exists in this
 * catalogue's scope), so signing it would secure a capability that does not
 * exist."
 *
 * That reasoning was right, and it INVERTS the moment redemption exists. A
 * redeemable URL whose only secret is a UUID in an email is a capability
 * anyone who sees one can use on someone else's behalf -- recipient ids appear
 * in API responses, exports and logs, and a forwarded email carries one
 * verbatim. So the link is signed now, and the signature is the whole
 * capability.
 *
 * **No new secret, and no reuse of a raw one.** The key is derived from
 * `SESSION_SECRET` with a purpose label, so the unsubscribe key and the
 * session key are different keys with one source: adding a required Compose
 * variable costs four edits across the deployment files, and passing the raw
 * session secret to a second purpose is the hygiene problem that derivation
 * exists to avoid.
 *
 * **Stateless on purpose.** No row is issued, stored, or expired. A link in a
 * mail someone kept for a year must still work -- an unsubscribe that stops
 * working is a compliance failure, not a security win -- and a per-send token
 * table would have to be written for every recipient of every campaign.
 */

const KEY_PURPOSE = 'eow.unsubscribe.v1';

/** Derives the purpose-scoped key. Cheap enough to do per call; no reason to cache a 32-byte buffer. */
function tokenKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update(KEY_PURPOSE).digest();
}

function sign(recipientId: string, sessionSecret: string): string {
  return createHmac('sha256', tokenKey(sessionSecret)).update(recipientId).digest('base64url');
}

/**
 * `{recipientId}.{signature}` -- the id stays readable so the route can look
 * the row up in one query, and the signature is what authorises the action.
 *
 * Deterministic: the same recipient always gets the same token, so a template
 * rendered twice produces byte-identical HTML and the campaign snapshot hash
 * (BR-SEND-012) does not move because someone re-rendered a preview.
 */
export function issueUnsubscribeToken(recipientId: string, sessionSecret: string): string {
  return `${recipientId}.${sign(recipientId, sessionSecret)}`;
}

/**
 * Returns the recipient id a token authorises, or `null`.
 *
 * Null for every failure, with no distinction between "malformed", "unknown id"
 * and "bad signature" -- the caller must not be able to tell an attacker which
 * of those it was, and a route that answered differently would be a recipient-id
 * oracle.
 */
export function readUnsubscribeToken(token: string | undefined | null, sessionSecret: string): string | null {
  if (!token) return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0 || separator === token.length - 1) return null;
  const recipientId = token.slice(0, separator);
  const provided = token.slice(separator + 1);

  const expected = sign(recipientId, sessionSecret);
  const providedBytes = Buffer.from(provided, 'base64url');
  const expectedBytes = Buffer.from(expected, 'base64url');
  // Length is checked first because `timingSafeEqual` throws on a mismatch
  // rather than returning false. The length of a signature is not a secret.
  if (providedBytes.length !== expectedBytes.length) return null;
  return timingSafeEqual(providedBytes, expectedBytes) ? recipientId : null;
}
