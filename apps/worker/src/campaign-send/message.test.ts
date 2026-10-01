import { describe, expect, it } from 'vitest';
import { buildMessageId, classifySmtpError, computeContentHash, safeSmtpFailureReason } from './message.js';

/**
 * M5-S3 CP4, RED first (BR-SEND-012, BR-SEND-006/011, DEC-104). Pure
 * functions: no DB, no network -- content_hash/Message-ID determinism and
 * error classification are all synchronous decisions this node makes before
 * ever touching a socket.
 */
describe('computeContentHash (BR-SEND-012)', () => {
  it('is a 64-char lowercase hex sha256 of subject+html+textBody, in that order', () => {
    const hash = computeContentHash({ subject: 'Hi', html: '<p>Hi</p>', textBody: 'Hi' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is identical for byte-identical input, called twice', () => {
    const email = { subject: 'Hi Ada', html: '<p>Hi Ada</p>', textBody: 'Hi Ada' };
    expect(computeContentHash(email)).toBe(computeContentHash({ ...email }));
  });

  it('differs when any one field differs', () => {
    const base = { subject: 'Hi', html: '<p>Hi</p>', textBody: 'Hi' };
    const hash = computeContentHash(base);
    expect(computeContentHash({ ...base, subject: 'Hey' })).not.toBe(hash);
    expect(computeContentHash({ ...base, html: '<p>Hey</p>' })).not.toBe(hash);
    expect(computeContentHash({ ...base, textBody: 'Hey' })).not.toBe(hash);
  });
});

describe('buildMessageId (DEC-104)', () => {
  it('is deterministic for the same recipient+execution, identical across calls', () => {
    const id1 = buildMessageId('recipient-1', 'execution-1', 'ops@example.test');
    const id2 = buildMessageId('recipient-1', 'execution-1', 'ops@example.test');
    expect(id1).toBe(id2);
  });

  it('differs for a different recipient, execution, or fromEmail domain', () => {
    const base = buildMessageId('recipient-1', 'execution-1', 'ops@example.test');
    expect(buildMessageId('recipient-2', 'execution-1', 'ops@example.test')).not.toBe(base);
    expect(buildMessageId('recipient-1', 'execution-2', 'ops@example.test')).not.toBe(base);
    expect(buildMessageId('recipient-1', 'execution-1', 'ops@other.test')).not.toBe(base);
  });

  it('is shaped like a valid Message-ID (angle brackets, @domain)', () => {
    expect(buildMessageId('r1', 'e1', 'ops@example.test')).toMatch(/^<[^@<>]+@example\.test>$/);
  });
});

describe('classifySmtpError (BR-SEND-006/011)', () => {
  it('classifies a connection-refused/timeout error as transient', () => {
    expect(classifySmtpError({ code: 'ECONNREFUSED' })).toMatchObject({ errorClass: 'transient' });
    expect(classifySmtpError({ code: 'ETIMEDOUT' })).toMatchObject({ errorClass: 'transient' });
  });

  it('classifies an auth failure as auth (never retried)', () => {
    expect(classifySmtpError({ code: 'EAUTH' })).toMatchObject({ errorClass: 'auth' });
  });

  it('classifies envelope sender defects as config and recipient defects as permanent', () => {
    expect(classifySmtpError({ code: 'EENVELOPE', message: 'Invalid sender address' })).toMatchObject({ errorClass: 'config' });
    expect(classifySmtpError({ code: 'EENVELOPE', response: '553 5.7.1 Sender address rejected: not logged in' })).toMatchObject({ errorClass: 'auth' });
    expect(classifySmtpError({ code: 'EENVELOPE', message: 'No recipients defined' })).toMatchObject({ errorClass: 'permanent' });
    expect(safeSmtpFailureReason({ code: 'EENVELOPE', message: 'No recipients defined' })).toBe('No recipients defined');
  });

  it('classifies a 4xx SMTP response as transient', () => {
    expect(classifySmtpError({ responseCode: 421, response: '421 Service not available' })).toMatchObject({ errorClass: 'transient' });
  });

  it('classifies a 5xx SMTP response as permanent', () => {
    expect(classifySmtpError({ responseCode: 550, response: '550 Requested action not taken' })).toMatchObject({ errorClass: 'permanent' });
  });

  it('classifies a 5.1.1/550 mailbox-unknown response as permanent AND hard-bounce', () => {
    const result = classifySmtpError({ responseCode: 550, response: '550 5.1.1 No such user here' });
    expect(result).toMatchObject({ errorClass: 'permanent', hardBounce: true });
  });

  it('a generic 5xx (not mailbox-unknown) is permanent but not a hard bounce', () => {
    const result = classifySmtpError({ responseCode: 552, response: '552 5.2.3 Message too large' });
    expect(result).toMatchObject({ errorClass: 'permanent', hardBounce: false });
  });

  it('surfaces retryAfterSeconds from a 421/450 Retry-After-shaped response when present', () => {
    const result = classifySmtpError({ responseCode: 421, response: '421 4.7.0 Try again later', retryAfterSeconds: 30 });
    expect(result).toMatchObject({ errorClass: 'transient', retryAfterSeconds: 30 });
  });

  it('an unrecognized error defaults to permanent (never silently retried forever)', () => {
    expect(classifySmtpError({ message: 'something unexpected' })).toMatchObject({ errorClass: 'permanent', hardBounce: false });
  });
});
