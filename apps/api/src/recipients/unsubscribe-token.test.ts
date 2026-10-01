import { describe, expect, it } from 'vitest';
import { issueUnsubscribeToken, readUnsubscribeToken } from './unsubscribe-token.js';

const SECRET = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const ID = '3f1b8c2e-9a44-4d51-8c7e-6d4b2f0a7e13';

describe('unsubscribe token (ADR-049)', () => {
  it('round-trips the recipient id', () => {
    expect(readUnsubscribeToken(issueUnsubscribeToken(ID, SECRET), SECRET)).toBe(ID);
  });

  it('is deterministic, so re-rendering a template does not move the snapshot hash', () => {
    expect(issueUnsubscribeToken(ID, SECRET)).toBe(issueUnsubscribeToken(ID, SECRET));
  });

  /** The whole point: a bare id is what the link used to carry, and it must no longer be enough. */
  it('refuses a bare recipient id', () => {
    expect(readUnsubscribeToken(ID, SECRET)).toBeNull();
  });

  it('refuses a token signed with a different secret', () => {
    expect(readUnsubscribeToken(issueUnsubscribeToken(ID, OTHER), SECRET)).toBeNull();
  });

  it('refuses a token whose id was swapped for another recipient', () => {
    const other = '00000000-0000-4000-8000-000000000000';
    const signature = issueUnsubscribeToken(ID, SECRET).split('.').pop()!;
    expect(readUnsubscribeToken(`${other}.${signature}`, SECRET)).toBeNull();
  });

  it('refuses a tampered signature of the right length', () => {
    const token = issueUnsubscribeToken(ID, SECRET);
    const [id, signature] = [token.slice(0, token.lastIndexOf('.')), token.slice(token.lastIndexOf('.') + 1)];
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    expect(flipped).toHaveLength(signature.length);
    expect(readUnsubscribeToken(`${id}.${flipped}`, SECRET)).toBeNull();
  });

  it('refuses empty, malformed and separator-only input without throwing', () => {
    for (const bad of ['', '.', `${ID}.`, `.${ID}`, ID.replace(/-/g, ''), 'not-a-token', undefined, null]) {
      expect(readUnsubscribeToken(bad, SECRET)).toBeNull();
    }
  });

  /**
   * A UUID contains no `.`, but the id is split on the LAST one so a future id
   * shape that does cannot silently shift the boundary and validate the wrong
   * string.
   */
  it('splits on the last separator', () => {
    const dotted = 'tenant.recipient-1';
    expect(readUnsubscribeToken(issueUnsubscribeToken(dotted, SECRET), SECRET)).toBe(dotted);
  });

  it('does not throw on a signature that is not valid base64url', () => {
    expect(() => readUnsubscribeToken(`${ID}.!!!!not base64!!!!`, SECRET)).not.toThrow();
    expect(readUnsubscribeToken(`${ID}.!!!!not base64!!!!`, SECRET)).toBeNull();
  });

  it('produces a URL-safe token -- it travels in a path segment', () => {
    const token = issueUnsubscribeToken(ID, SECRET);
    expect(token).toBe(encodeURIComponent(token));
  });
});
