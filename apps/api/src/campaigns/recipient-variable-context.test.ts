import { describe, expect, it } from 'vitest';
import { recipientVariableContext, unsubscribeUrlFor } from './recipient-variable-context.js';
import { readUnsubscribeToken } from '../recipients/unsubscribe-token.js';

const SECRET = 'x'.repeat(64);
const WEB_ORIGIN = { webOrigin: 'https://app.example.test', unsubscribeSecret: SECRET };

describe('unsubscribeUrlFor (BR-TPL-008, signed since ADR-049)', () => {
  it('is a real, non-empty URL under WEB_ORIGIN, unique per recipient', () => {
    const a = unsubscribeUrlFor(WEB_ORIGIN, 'r1');
    const b = unsubscribeUrlFor(WEB_ORIGIN, 'r2');
    expect(a).toMatch(/^https:\/\/app\.example\.test\/unsubscribe\/r1\./);
    expect(b).toMatch(/^https:\/\/app\.example\.test\/unsubscribe\/r2\./);
    expect(a).not.toBe(b);
  });

  /**
   * ADR-049. The link used to end at the bare recipient id; it must not any
   * more, because ADR-049 gave it a route to redeem and ids are not secret.
   */
  it('carries a signature, not a bare recipient id', () => {
    const url = unsubscribeUrlFor(WEB_ORIGIN, 'r1');
    expect(url).not.toBe('https://app.example.test/unsubscribe/r1');
    expect(readUnsubscribeToken(url.split('/unsubscribe/')[1], SECRET)).toBe('r1');
  });

  it('produces a token no other secret can mint', () => {
    const url = unsubscribeUrlFor(WEB_ORIGIN, 'r1');
    expect(readUnsubscribeToken(url.split('/unsubscribe/')[1], 'y'.repeat(64))).toBeNull();
  });

  /** BR-SEND-012 hashes the frozen email; a link that changed per render would move that hash. */
  it('is stable across calls, so re-rendering does not move the snapshot hash', () => {
    expect(unsubscribeUrlFor(WEB_ORIGIN, 'r1')).toBe(unsubscribeUrlFor(WEB_ORIGIN, 'r1'));
  });

  it('tolerates a trailing slash on WEB_ORIGIN without producing a double slash', () => {
    const url = unsubscribeUrlFor({ ...WEB_ORIGIN, webOrigin: 'https://app.example.test/' }, 'r1');
    expect(url.startsWith('https://app.example.test/unsubscribe/r1.')).toBe(true);
  });
});

describe('recipientVariableContext (BR-CMP-004/006, BR-TPL-008)', () => {
  const recipient = {
    id: 'r1', email: 'a@example.test', firstName: 'Minh An', lastName: null,
    customData: { city: 'Hanoi', birthday: null },
  };
  const customFields = [{ fieldKey: 'city' }, { fieldKey: 'birthday' }, { fieldKey: 'unused_field' }];

  it('always includes the system keys email and unsubscribe_url', () => {
    const context = recipientVariableContext(recipient, customFields, WEB_ORIGIN);
    expect(context.email).toBe('a@example.test');
    // Signed since ADR-049, so the value is the token rather than the bare id.
    expect(context.unsubscribe_url).toBe(unsubscribeUrlFor(WEB_ORIGIN, 'r1'));
    expect(readUnsubscribeToken(String(context.unsubscribe_url).split('/unsubscribe/')[1], SECRET)).toBe('r1');
  });

  it('includes first_name when present and omits last_name when null, so the renderer sees it as genuinely missing rather than the literal string "null"', () => {
    const context = recipientVariableContext(recipient, customFields, WEB_ORIGIN);
    expect(context.first_name).toBe('Minh An');
    expect('last_name' in context).toBe(false);
  });

  it('maps recipient.customData by fieldKey for fields the recipient actually has a value for', () => {
    const context = recipientVariableContext(recipient, customFields, WEB_ORIGIN);
    expect(context.city).toBe('Hanoi');
  });

  it('omits a custom field the recipient never had a value set for, rather than injecting undefined', () => {
    const context = recipientVariableContext(recipient, customFields, WEB_ORIGIN);
    expect('unused_field' in context).toBe(false);
  });

  it('treats an explicitly-cleared custom-data value (null) as present-but-null, same as the recipient row itself', () => {
    const context = recipientVariableContext(recipient, customFields, WEB_ORIGIN);
    expect(context.birthday).toBeNull();
  });
});
