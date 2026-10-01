import { describe, expect, it } from 'vitest';
import { nextRetryDelayMs } from './retry-backoff.js';

/**
 * M5-S3 CP4, RED first. Worker-native duplicate of apps/api's
 * retry-backoff.ts (cross-package import is not available -- see
 * message.ts's own note on DEC-106/the tenant-transaction.ts precedent).
 * Identical contract and test shape.
 */
describe('nextRetryDelayMs (BR-SEND-006, worker-native)', () => {
  it('doubles the exponential component per attempt before jitter, capped at opts.capMs', () => {
    const opts = { baseMs: 1000, capMs: 60_000 };
    expect(nextRetryDelayMs(1, opts, () => 1)).toBe(1000);
    expect(nextRetryDelayMs(2, opts, () => 1)).toBe(2000);
    expect(nextRetryDelayMs(3, opts, () => 1)).toBe(4000);
  });

  it('caps the exponential component at opts.capMs before jitter is applied', () => {
    expect(nextRetryDelayMs(10, { baseMs: 1000, capMs: 5000 }, () => 1)).toBe(5000);
  });

  it('never returns less than half the (capped) exponential component', () => {
    expect(nextRetryDelayMs(3, { baseMs: 1000, capMs: 60_000 }, () => 0)).toBe(2000);
  });

  it('uses the documented defaults (30s base, 15min cap) when opts is omitted', () => {
    expect(nextRetryDelayMs(1, undefined, () => 1)).toBe(30_000);
    expect(nextRetryDelayMs(20, undefined, () => 1)).toBe(900_000);
  });
});
