import nodemailer from 'nodemailer';
import type { EmailProviderAdapter, ProviderErrorClass, ProviderProbeResult, ProviderWebhookEvent, SenderConnectionConfig } from './provider-adapter.js';

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(['delivered', 'bounced', 'complaint', 'deferred']);

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Port 465 is implicit TLS (SMTPS): the listener expects a TLS handshake as
 * the first bytes on the socket and never writes a plaintext 220 greeting.
 * Every other SMTP port starts in the clear and negotiates upwards, so
 * nodemailer's own `secure` flag has to be derived rather than fixed --
 * `secure: false` against 465 leaves the probe waiting for a banner that is
 * never coming, and `secure: true` against 587 or 25 breaks STARTTLS, which
 * nodemailer already applies on its own when the server advertises it.
 *
 * Deriving it from the port keeps the sender-config contract unchanged
 * (BR-CFG-002 stores no TLS field). The tradeoff is that implicit TLS on a
 * non-standard port -- 2465, say -- is still unreachable; if such a sender
 * ever needs supporting, that is the point to add an explicit `secure`
 * column rather than widening this predicate.
 */
export const SMTP_IMPLICIT_TLS_PORT = 465;

export function smtpTransportOptions(config: SenderConnectionConfig) {
  return {
    host: config.host,
    port: config.port,
    secure: config.port === SMTP_IMPLICIT_TLS_PORT,
    auth: config.username ? { user: config.username, pass: config.secret } : undefined,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 5_000,
  };
}
export class SmtpProviderAdapter implements EmailProviderAdapter {
  async testConnection(config: SenderConnectionConfig): Promise<ProviderProbeResult> {
    const transport = nodemailer.createTransport(smtpTransportOptions(config));
    try {
      await transport.verify();
      await transport.sendMail({
        from: config.fromEmail,
        to: config.fromEmail,
        subject: '[Email Operations] Kiểm tra cấu hình SMTP',
        text: 'Email kiểm tra xác thực tài khoản và địa chỉ người gửi. Bạn có thể bỏ qua thư này.',
      });
      return { ok: true };
    }
    catch (error) {
      const classification = this.classifyError(error);
      return { ok: false, code: String((error as { code?: unknown })?.code ?? classification).toUpperCase(), classification, reason: this.safeReason(error) };
    }
    finally { transport.close(); }
  }
  async send(_message: unknown): Promise<import('./provider-adapter.js').ProviderSendResult> { throw new Error('SENDING_DEFERRED_TO_M5_S3'); }
  classifyError(error: unknown): ProviderErrorClass {
    const code = String((error as { code?: unknown })?.code ?? '').toUpperCase();
    const message = String((error as { message?: unknown })?.message ?? '').toUpperCase();
    if (code.includes('AUTH') || code === 'EAUTH' || message.includes('NOT LOGGED IN') || message.includes('AUTHENTICAT') || message.includes('LOGIN')) return 'auth';
    if (code.startsWith('EEN') || code.includes('CONFIG')) return 'config';
    if (code.startsWith('ETIMEDOUT') || code === 'ECONNREFUSED' || code === 'ECONNRESET' || message.includes('ECONNREFUSED') || message.includes('ECONNRESET') || message.includes('ETIMEDOUT')) return 'transient';
    return 'permanent';
  }
  private safeReason(error: unknown): string | null {
    const response = (error as { response?: unknown })?.response;
    if (typeof response === 'string' && response.trim()) return response.trim().slice(0, 1000);
    const message = (error as { message?: unknown })?.message;
    return typeof message === 'string' && message.trim() ? message.trim().slice(0, 1000) : null;
  }
  /**
   * D-106: reads exactly four named fields and ignores every other key,
   * including a payload shaped like a cross-tenant write attempt
   * (`tenantId`, `campaignRecipientId`, `status`) -- the previous
   * implementation spread the entire caller-controlled payload through
   * with an `as` cast. `type` accepts `id`/`eventId` and `messageId`/
   * `providerMessageId` as synonyms; an event whose `type` is missing or
   * not one of BR-SEND-008's four known values maps to `'unknown'` rather
   * than passing an arbitrary string through, since the webhook apply
   * algorithm's own decision table (M5-S4-WEBHOOK-PLAN.md SS3.4b) switches
   * on exactly those five literal values.
   */
  parseWebhookEvent(payload: unknown): ProviderWebhookEvent {
    const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    const type = readString(body.type);
    const occurred = readString(body.occurredAt);
    const parsedOccurredAt = occurred ? new Date(occurred) : null;
    return {
      eventId: readString(body.id) ?? readString(body.eventId),
      type: type && KNOWN_EVENT_TYPES.has(type) ? (type as ProviderWebhookEvent['type']) : 'unknown',
      providerMessageId: readString(body.messageId) ?? readString(body.providerMessageId),
      occurredAt: parsedOccurredAt && !Number.isNaN(parsedOccurredAt.getTime()) ? parsedOccurredAt : null,
    };
  }
}
