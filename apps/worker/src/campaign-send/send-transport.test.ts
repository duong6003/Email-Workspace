import { describe, expect, it } from 'vitest';
import { sendTransportOptions } from './send.js';

/**
 * The send path's twin of the API adapter's smtpTransportOptions. Both
 * hardcoded `secure: false`, so a sender saved on port 465 (implicit TLS /
 * SMTPS) could neither be verified nor sent through: nodemailer opens a
 * plaintext socket and waits for a 220 banner the TLS-only listener never
 * sends. Fixing only the adapter would be worse than not fixing it -- the
 * operator's connection test would go green while every real send still
 * stalled until socketTimeout and retried.
 */
describe('sendTransportOptions (implicit TLS on port 465)', () => {
  const message = { host: 'smtp.example.test', port: 465, username: 'people@example.test', secret: 's3cret' };

  it('enables implicit TLS on port 465', () => {
    expect(sendTransportOptions(message).secure).toBe(true);
  });

  it('leaves 587, 25 and the dev mailpit port plaintext-first so STARTTLS still applies', () => {
    for (const port of [587, 25, 2525, 1025]) {
      expect(sendTransportOptions({ ...message, port }).secure).toBe(false);
    }
  });

  it('keeps the send path on its own longer timeouts, not the probe timeouts', () => {
    expect(sendTransportOptions(message)).toMatchObject({ host: 'smtp.example.test', port: 465, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 });
  });

  it('sends credentials only when a username is configured', () => {
    expect(sendTransportOptions(message).auth).toEqual({ user: 'people@example.test', pass: 's3cret' });
    expect(sendTransportOptions({ ...message, username: '' }).auth).toBeUndefined();
  });
});
