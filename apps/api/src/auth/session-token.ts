import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Session/refresh token shape: `<sessionId>.<secret>`. `sessionId` looks the
 * matching `user_session` row up in O(1); `secret` (32 random bytes,
 * base64url) is compared only as a SHA-256 hash against
 * `user_session.refresh_token_hash`, so the DB never holds a usable credential
 * — the same shape a real refresh-token table needs (BR-AUTH-002).
 */
export type SessionToken = {
  sessionId: string;
  secret: string;
  raw: string;
};

export function issueSessionToken(sessionId: string): SessionToken {
  const secret = randomBytes(32).toString('base64url');
  return { sessionId, secret, raw: `${sessionId}.${secret}` };
}

export function parseSessionToken(raw: string | undefined | null): { sessionId: string; secret: string } | null {
  if (!raw) return null;
  const separatorIndex = raw.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) return null;
  return { sessionId: raw.slice(0, separatorIndex), secret: raw.slice(separatorIndex + 1) };
}

export function hashSessionSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison against a stored hash, to avoid a timing oracle. */
export function secretMatchesHash(secret: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashSessionSecret(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
