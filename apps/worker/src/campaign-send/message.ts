import { createHash } from 'node:crypto';

export type FrozenEmail = { subject: string; html: string; textBody: string };

/**
 * BR-SEND-012: rendered from the frozen snapshot only. The worker never
 * reads live recipient data, so the same input here always produces the
 * same hash regardless of what changed on the live `recipient` row since.
 */
export function computeContentHash(email: FrozenEmail): string {
  return createHash('sha256').update(`${email.subject}\n${email.html}\n${email.textBody}`).digest('hex');
}

/**
 * DEC-104: identical across every re-submission of the same recipient's
 * attempt for the same execution, so a crash between the provider accepting
 * a message and this worker recording that fact is provider-side detectable
 * (A15) rather than a silent duplicate send.
 */
export function buildMessageId(campaignRecipientId: string, executionId: string, fromEmail: string): string {
  const domain = fromEmail.split('@')[1] ?? 'localhost';
  return `<${campaignRecipientId}.${executionId}@${domain}>`;
}

export type SmtpErrorClass = 'permanent' | 'transient' | 'auth' | 'config';
export type SmtpErrorClassification = {
  errorClass: SmtpErrorClass;
  hardBounce: boolean;
  retryAfterSeconds: number | null;
};

type RawSmtpError = {
  code?: string;
  responseCode?: number;
  response?: string;
  retryAfterSeconds?: number;
  message?: string;
};

/**
 * BR-SEND-006/011. Extends SmtpProviderAdapter.classifyError's shape
 * (apps/api) with the hard-bounce distinction the send path needs and this
 * worker owns natively -- see M5-S3-SEND-PLAN.md SS0(g)/DEC-106: apps/api's
 * adapter has no caller for a real send today and this worker cannot import
 * across the process boundary (the same tenant-transaction.ts duplication
 * this codebase already accepts), so the logic is reimplemented here rather
 * than left half-shared.
 */
export function classifySmtpError(error: RawSmtpError): SmtpErrorClassification {
  const code = (error.code ?? '').toUpperCase();
  const retryAfterSeconds = error.retryAfterSeconds ?? null;
  const message = `${error.message ?? ''} ${error.response ?? ''}`.toUpperCase();

  if (code === 'EAUTH') return { errorClass: 'auth', hardBounce: false, retryAfterSeconds };
  if (code === 'EENVELOPE') {
    if (message.includes('NOT LOGGED IN') || message.includes('AUTHENTICAT') || message.includes('LOGIN')) {
      return { errorClass: 'auth', hardBounce: false, retryAfterSeconds };
    }
    return { errorClass: message.includes('SENDER') ? 'config' : 'permanent', hardBounce: false, retryAfterSeconds };
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code.startsWith('ETIMEDOUT')) {
    return { errorClass: 'transient', hardBounce: false, retryAfterSeconds };
  }

  if (typeof error.responseCode === 'number') {
    if (error.responseCode >= 400 && error.responseCode < 500) {
      return { errorClass: 'transient', hardBounce: false, retryAfterSeconds };
    }
    if (error.responseCode >= 500 && error.responseCode < 600) {
      const response = (error.response ?? '').toUpperCase();
      const hardBounce = response.includes('5.1.1') || response.includes('5.1.10') || /\b550\b/.test(response);
      return { errorClass: 'permanent', hardBounce, retryAfterSeconds };
    }
  }

  return { errorClass: 'permanent', hardBounce: false, retryAfterSeconds };
}

export function safeSmtpFailureReason(error: RawSmtpError): string | null {
  if (typeof error.response === 'string' && error.response.trim()) return error.response.trim().slice(0, 1000);
  const code = (error.code ?? '').toUpperCase();
  if (['EENVELOPE', 'EAUTH', 'ECONNREFUSED', 'ECONNRESET'].includes(code) || code.startsWith('ETIMEDOUT')) {
    return typeof error.message === 'string' && error.message.trim() ? error.message.trim().slice(0, 1000) : null;
  }
  return null;
}
