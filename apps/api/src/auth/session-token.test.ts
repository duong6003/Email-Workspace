import { describe, expect, it } from 'vitest';
import { hashSessionSecret, issueSessionToken, parseSessionToken, secretMatchesHash } from './session-token.js';

describe('session-token', () => {
  it('issues a token whose raw form round-trips through parseSessionToken', () => {
    const token = issueSessionToken('session-123');
    const parsed = parseSessionToken(token.raw);
    expect(parsed).toEqual({ sessionId: 'session-123', secret: token.secret });
  });

  it('returns null for a missing or malformed raw token', () => {
    expect(parseSessionToken(undefined)).toBeNull();
    expect(parseSessionToken('')).toBeNull();
    expect(parseSessionToken('no-separator')).toBeNull();
    expect(parseSessionToken('.no-session-id')).toBeNull();
    expect(parseSessionToken('session-id.')).toBeNull();
  });

  it('secretMatchesHash accepts the correct secret and rejects a wrong one', () => {
    const token = issueSessionToken('s1');
    const storedHash = hashSessionSecret(token.secret);
    expect(secretMatchesHash(token.secret, storedHash)).toBe(true);
    expect(secretMatchesHash('wrong-secret', storedHash)).toBe(false);
  });

  it('two issued tokens for the same session never share a secret', () => {
    const a = issueSessionToken('same-session');
    const b = issueSessionToken('same-session');
    expect(a.secret).not.toBe(b.secret);
  });
});
