import { describe, expect, it } from 'vitest';
import type { SenderConnectionConfig } from './provider-adapter.js';
import { SmtpProviderAdapter, smtpTransportOptions } from './smtp-provider.adapter.js';

/**
 * M5-S4 CP4 (D-106, BR-CFG-005's webhook half). The previous implementation
 * spread the caller's entire, unvalidated payload into the returned event and
 * cast the result -- harmless only because nothing called it. This suite
 * proves the replacement reads exactly four named fields and ignores every
 * other key, including ones shaped like an attempted cross-tenant write
 * (D-106's own finding).
 */
describe('SmtpProviderAdapter.parseWebhookEvent (M5-S4 CP4, D-106)', () => {
  const adapter = new SmtpProviderAdapter();

  it('reads id, type, messageId and occurredAt from a well-formed delivered event', () => {
    const result = adapter.parseWebhookEvent({
      id: 'evt-1',
      type: 'delivered',
      messageId: 'mid-1',
      occurredAt: '2026-08-18T09:00:00.000Z',
    });
    expect(result).toEqual({
      eventId: 'evt-1',
      type: 'delivered',
      providerMessageId: 'mid-1',
      occurredAt: new Date('2026-08-18T09:00:00.000Z'),
    });
  });

  it('reads bounced, complaint and deferred event types verbatim', () => {
    for (const type of ['bounced', 'complaint', 'deferred'] as const) {
      expect(adapter.parseWebhookEvent({ id: 'e', type, messageId: 'm' }).type).toBe(type);
    }
  });

  it('maps an unrecognized type to "unknown" rather than passing it through', () => {
    const result = adapter.parseWebhookEvent({ id: 'evt-2', type: 'spam_complaint_v2', messageId: 'mid-2' });
    expect(result.type).toBe('unknown');
  });

  it('maps a missing type to "unknown"', () => {
    const result = adapter.parseWebhookEvent({ id: 'evt-3', messageId: 'mid-3' });
    expect(result.type).toBe('unknown');
  });

  it('accepts eventId as an alias for id, and providerMessageId as an alias for messageId', () => {
    const result = adapter.parseWebhookEvent({ eventId: 'evt-alias', type: 'delivered', providerMessageId: 'mid-alias' });
    expect(result.eventId).toBe('evt-alias');
    expect(result.providerMessageId).toBe('mid-alias');
  });

  it('returns null eventId when neither id nor eventId is a non-empty string', () => {
    expect(adapter.parseWebhookEvent({ type: 'delivered', messageId: 'm' }).eventId).toBeNull();
    expect(adapter.parseWebhookEvent({ id: '', type: 'delivered', messageId: 'm' }).eventId).toBeNull();
    expect(adapter.parseWebhookEvent({ id: 123, type: 'delivered', messageId: 'm' }).eventId).toBeNull();
  });

  it('returns null providerMessageId when neither messageId nor providerMessageId is a non-empty string', () => {
    expect(adapter.parseWebhookEvent({ id: 'e', type: 'delivered' }).providerMessageId).toBeNull();
    expect(adapter.parseWebhookEvent({ id: 'e', type: 'delivered', messageId: '' }).providerMessageId).toBeNull();
  });

  it('returns null occurredAt when the field is missing or not a valid date string', () => {
    expect(adapter.parseWebhookEvent({ id: 'e', type: 'delivered', messageId: 'm' }).occurredAt).toBeNull();
    expect(adapter.parseWebhookEvent({ id: 'e', type: 'delivered', messageId: 'm', occurredAt: 'not-a-date' }).occurredAt).toBeNull();
    expect(adapter.parseWebhookEvent({ id: 'e', type: 'delivered', messageId: 'm', occurredAt: 12345 }).occurredAt).toBeNull();
  });

  it('D-106: ignores every key not in its own named list, including a hostile cross-tenant write attempt', () => {
    const result = adapter.parseWebhookEvent({
      id: 'evt-hostile',
      type: 'delivered',
      messageId: 'mid-hostile',
      tenantId: 'attacker-controlled-tenant',
      campaignRecipientId: 'attacker-controlled-recipient',
      status: 'delivered',
      __proto__: { polluted: true },
    });
    expect(result).toEqual({
      eventId: 'evt-hostile',
      type: 'delivered',
      providerMessageId: 'mid-hostile',
      occurredAt: null,
    });
    expect(Object.keys(result)).toEqual(['eventId', 'type', 'providerMessageId', 'occurredAt']);
  });

  it('handles a non-object payload without throwing', () => {
    expect(adapter.parseWebhookEvent(null)).toEqual({ eventId: null, type: 'unknown', providerMessageId: null, occurredAt: null });
    expect(adapter.parseWebhookEvent('not-an-object')).toEqual({ eventId: null, type: 'unknown', providerMessageId: null, occurredAt: null });
    expect(adapter.parseWebhookEvent(undefined)).toEqual({ eventId: null, type: 'unknown', providerMessageId: null, occurredAt: null });
  });
});

/**
 * A sender saved on port 465 speaks implicit TLS (SMTPS): the server expects
 * a TLS handshake as the very first bytes on the socket and never emits a
 * plaintext 220 banner. The adapter previously hardcoded `secure: false` for
 * every port, so such a sender could not be verified at all -- nodemailer sat
 * waiting for a greeting that was never coming until greetingTimeout fired.
 */
describe('smtpTransportOptions (implicit TLS on port 465)', () => {
  const config: SenderConnectionConfig = { host: 'smtp.example.test', port: 465, username: 'people@example.test', secret: 's3cret', fromEmail: 'people@example.test' };

  it('enables implicit TLS on port 465', () => {
    expect(smtpTransportOptions(config).secure).toBe(true);
  });

  it('leaves 587, 25 and the dev mailpit port plaintext-first so STARTTLS still applies', () => {
    for (const port of [587, 25, 2525, 1025]) {
      expect(smtpTransportOptions({ ...config, port }).secure).toBe(false);
    }
  });

  it('carries host, port and the probe timeouts through unchanged', () => {
    expect(smtpTransportOptions(config)).toMatchObject({ host: 'smtp.example.test', port: 465, connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 5_000 });
  });

  it('sends credentials only when a username is configured', () => {
    expect(smtpTransportOptions(config).auth).toEqual({ user: 'people@example.test', pass: 's3cret' });
    expect(smtpTransportOptions({ ...config, username: '' }).auth).toBeUndefined();
  });
});
