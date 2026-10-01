import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './webhook-signature.js';

const SECRET = 'a'.repeat(32);
const WRONG_SECRET = 'b'.repeat(32);
const NOW = new Date('2026-08-18T09:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function sign(rawBody: Buffer, secret: string, timestampSeconds: number): string {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody.toString('utf8')}`).digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

describe('verifyWebhookSignature (M5-S4 CP3, BR-SEND-008 signature verification)', () => {
  it('accepts a correctly signed body within the tolerance window, returning the verified timestamp', () => {
    const rawBody = Buffer.from(JSON.stringify({ id: 'evt-1' }));
    const header = sign(rawBody, SECRET, NOW_SECONDS);
    expect(verifyWebhookSignature({ rawBody, header, secret: SECRET, now: NOW })).toEqual({ ok: true, timestampSeconds: NOW_SECONDS });
  });

  it('R2: verifies against the exact raw bytes, not a re-serialisation with different key order and unicode escaping', () => {
    // A client that parsed then re-serialised this body would very likely
    // reorder keys and re-escape the accented character differently
    // (JSON.stringify escapes non-ASCII inconsistently across engines/locales
    // depending on source formatting) -- proving the byte-for-byte raw Buffer
    // is what gets signed, not JSON.stringify(JSON.parse(rawBody)).
    const rawBody = Buffer.from('{"messageId":"m-1","occurredAt":"2026-08-18T09:00:00.000Z","note":"café"}', 'utf8');
    const header = sign(rawBody, SECRET, NOW_SECONDS);
    expect(verifyWebhookSignature({ rawBody, header, secret: SECRET, now: NOW })).toEqual({ ok: true, timestampSeconds: NOW_SECONDS });
  });

  it('rejects a tampered body signed under the original bytes', () => {
    const originalBody = Buffer.from(JSON.stringify({ id: 'evt-1', type: 'delivered' }));
    const tamperedBody = Buffer.from(JSON.stringify({ id: 'evt-1', type: 'bounced' }));
    const header = sign(originalBody, SECRET, NOW_SECONDS);
    expect(verifyWebhookSignature({ rawBody: tamperedBody, header, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a signature computed with the wrong secret', () => {
    const rawBody = Buffer.from(JSON.stringify({ id: 'evt-1' }));
    const header = sign(rawBody, WRONG_SECRET, NOW_SECONDS);
    expect(verifyWebhookSignature({ rawBody, header, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a missing header', () => {
    const rawBody = Buffer.from('{}');
    expect(verifyWebhookSignature({ rawBody, header: undefined, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an empty header', () => {
    const rawBody = Buffer.from('{}');
    expect(verifyWebhookSignature({ rawBody, header: '', secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a header missing t=', () => {
    const rawBody = Buffer.from('{}');
    const digest = createHmac('sha256', SECRET).update(`${NOW_SECONDS}.${rawBody.toString('utf8')}`).digest('hex');
    expect(verifyWebhookSignature({ rawBody, header: `v1=${digest}`, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a header missing v1=', () => {
    const rawBody = Buffer.from('{}');
    expect(verifyWebhookSignature({ rawBody, header: `t=${NOW_SECONDS}`, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a non-integer t=', () => {
    const rawBody = Buffer.from('{}');
    const digest = createHmac('sha256', SECRET).update(`not-a-number.${rawBody.toString('utf8')}`).digest('hex');
    expect(verifyWebhookSignature({ rawBody, header: `t=not-a-number,v1=${digest}`, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a v1= containing uppercase or non-hex characters', () => {
    const rawBody = Buffer.from('{}');
    const digest = createHmac('sha256', SECRET).update(`${NOW_SECONDS}.${rawBody.toString('utf8')}`).digest('hex');
    const uppercased = digest.toUpperCase();
    expect(verifyWebhookSignature({ rawBody, header: `t=${NOW_SECONDS},v1=${uppercased}`, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a v1= that is too short to be a sha256 digest (R3: length checked before timingSafeEqual)', () => {
    const rawBody = Buffer.from('{}');
    expect(verifyWebhookSignature({ rawBody, header: `t=${NOW_SECONDS},v1=abcd`, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a v1= that is too long to be a sha256 digest (R3: length checked before timingSafeEqual)', () => {
    const rawBody = Buffer.from('{}');
    const tooLong = 'a'.repeat(128);
    expect(verifyWebhookSignature({ rawBody, header: `t=${NOW_SECONDS},v1=${tooLong}`, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a timestamp more than 300 seconds in the past', () => {
    const rawBody = Buffer.from('{}');
    const staleSeconds = NOW_SECONDS - 301;
    const header = sign(rawBody, SECRET, staleSeconds);
    expect(verifyWebhookSignature({ rawBody, header, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a timestamp more than 300 seconds in the future', () => {
    const rawBody = Buffer.from('{}');
    const futureSeconds = NOW_SECONDS + 301;
    const header = sign(rawBody, SECRET, futureSeconds);
    expect(verifyWebhookSignature({ rawBody, header, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts a timestamp exactly at the 300 second boundary', () => {
    const rawBody = Buffer.from('{}');
    const boundarySeconds = NOW_SECONDS - 300;
    const header = sign(rawBody, SECRET, boundarySeconds);
    expect(verifyWebhookSignature({ rawBody, header, secret: SECRET, now: NOW })).toEqual({ ok: true, timestampSeconds: boundarySeconds });
  });

  it('honours a custom toleranceSeconds', () => {
    const rawBody = Buffer.from('{}');
    const header = sign(rawBody, SECRET, NOW_SECONDS - 30);
    expect(verifyWebhookSignature({ rawBody, header, secret: SECRET, now: NOW, toleranceSeconds: 10 })).toEqual({ ok: false, reason: 'expired' });
  });
});
