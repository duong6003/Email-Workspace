import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureFailure = 'malformed' | 'expired' | 'mismatch';
/**
 * `timestampSeconds` (M5-S4 CP4) is the provider-chosen `t=` value, already
 * proven inside the tolerance window by the time `ok: true` is returned --
 * the apply algorithm reuses it as the fallback `occurredAt` when a
 * provider's payload omits its own timestamp (SS3.3), rather than
 * substituting request-processing time, which is not a fact about the event.
 */
export type SignatureResult = { ok: true; timestampSeconds: number } | { ok: false; reason: SignatureFailure };

const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNATURE_HEADER_PATTERN = /^t=(\d+),v1=([0-9a-f]+)$/;
const SHA256_HEX_LENGTH = 64;

/**
 * BR-SEND-008's HMAC scheme (M5-S4-WEBHOOK-PLAN.md SS3.2). `rawBody` MUST be
 * the exact bytes the provider signed -- never a re-serialisation
 * (JSON.stringify(parsed) reorders keys and re-escapes unicode differently),
 * which is why this function's only body input is a Buffer, never a parsed
 * object (R2).
 *
 * Digest comparison uses timingSafeEqual only after confirming both buffers
 * are the same length -- timingSafeEqual throws on a length mismatch, which
 * would itself become a length oracle if it reached the caller as an
 * unhandled 500 (R3). A `v1` of the wrong length is therefore rejected as
 * `malformed` by the header-shape check before any comparison is attempted.
 */
export function verifyWebhookSignature(input: {
  rawBody: Buffer;
  header: string | undefined;
  secret: string;
  now: Date;
  toleranceSeconds?: number;
}): SignatureResult {
  const { rawBody, header, secret, now, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS } = input;

  if (!header) return { ok: false, reason: 'malformed' };
  const match = SIGNATURE_HEADER_PATTERN.exec(header);
  if (!match) return { ok: false, reason: 'malformed' };

  const [, timestampText, providedDigestHex] = match;
  if (providedDigestHex.length !== SHA256_HEX_LENGTH) return { ok: false, reason: 'malformed' };

  const timestampSeconds = Number(timestampText);
  if (!Number.isSafeInteger(timestampSeconds)) return { ok: false, reason: 'malformed' };

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) return { ok: false, reason: 'expired' };

  const expectedDigestHex = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody.toString('utf8')}`).digest('hex');
  const provided = Buffer.from(providedDigestHex, 'hex');
  const expected = Buffer.from(expectedDigestHex, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: true, timestampSeconds };
}
