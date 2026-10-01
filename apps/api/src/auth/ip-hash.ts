import { createHmac } from 'node:crypto';

/**
 * HMACs a client IP/user-agent with SESSION_SECRET before it is ever
 * persisted (login_attempt.ip_hash, user_session.ip_hash/user_agent_hash) —
 * raw IPs are PII and must not be stored verbatim (observability/audit plan).
 */
export function hashIdentifier(secret: string, value: string | null | undefined): string | null {
  if (!value) return null;
  return createHmac('sha256', secret).update(value).digest('hex');
}
