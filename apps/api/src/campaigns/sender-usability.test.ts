import { describe, expect, it } from 'vitest';
import { checkSenderUsable } from './sender-usability.js';

/** BR-CFG-002: sender phải verified và active trước khi dùng. */
describe('checkSenderUsable (BR-CFG-002)', () => {
  it('blocks every non-verified status by name, not just disabled', () => {
    for (const status of ['pending', 'failed', 'disabled']) {
      expect(checkSenderUsable({ senderConfigId: 'sender-1' }, { status })).toEqual({
        valid: false,
        reason: 'SENDER_NOT_VERIFIED',
      });
    }
  });

  it('accepts a verified sender config', () => {
    expect(checkSenderUsable({ senderConfigId: 'sender-1' }, { status: 'verified' })).toEqual({ valid: true });
  });

  it('reports a referenced-but-absent sender config as not found, not as unverified', () => {
    expect(checkSenderUsable({ senderConfigId: 'sender-1' }, null)).toEqual({
      valid: false,
      reason: 'SENDER_NOT_FOUND',
    });
  });

  it('rejects raw From identities that are not backed by a verified sender config', () => {
    expect(checkSenderUsable({ fromEmail: 'ops@example.test' }, null)).toEqual({ valid: false, reason: 'SENDER_MISSING' });
    expect(checkSenderUsable({ fromEmail: '   ' }, null)).toEqual({ valid: false, reason: 'SENDER_MISSING' });
    expect(checkSenderUsable({}, null)).toEqual({ valid: false, reason: 'SENDER_MISSING' });
  });
});
