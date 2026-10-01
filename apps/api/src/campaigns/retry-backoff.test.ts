import { describe, expect, it } from 'vitest';
import { nextRetryDelayMs } from './retry-backoff.js';

/**
 * M5-S3 CP2, RED first (BR-SEND-006). `rand` is injected so the jitter band
 * is assertable without a flaky test (R4): pinning it to 0 and 1 exercises
 * the band's exact edges instead of a statistical sample.
 */
describe('nextRetryDelayMs (BR-SEND-006)', () => {
  it('doubles the exponential component per attempt before jitter, capped at opts.capMs', () => {
    const opts = { baseMs: 1000, capMs: 60_000 };
    // rand=1 -> the full (uncapped-by-jitter) exponential value: base * 2^(n-1)
    expect(nextRetryDelayMs(1, opts, () => 1)).toBe(1000);
    expect(nextRetryDelayMs(2, opts, () => 1)).toBe(2000);
    expect(nextRetryDelayMs(3, opts, () => 1)).toBe(4000);
    expect(nextRetryDelayMs(4, opts, () => 1)).toBe(8000);
  });

  it('caps the exponential component at opts.capMs before jitter is applied', () => {
    const opts = { baseMs: 1000, capMs: 5000 };
    expect(nextRetryDelayMs(10, opts, () => 1)).toBe(5000);
  });

  it('never returns less than half the (capped) exponential component -- full-band jitter, never below half', () => {
    const opts = { baseMs: 1000, capMs: 60_000 };
    expect(nextRetryDelayMs(3, opts, () => 0)).toBe(2000); // 4000 * 0.5
  });

  it('is deterministic for a fixed rand, and produces a different value for a different rand within the band', () => {
    const opts = { baseMs: 1000, capMs: 60_000 };
    const low = nextRetryDelayMs(3, opts, () => 0);
    const mid = nextRetryDelayMs(3, opts, () => 0.5);
    const high = nextRetryDelayMs(3, opts, () => 1);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(low).toBe(2000);
    expect(high).toBe(4000);
  });

  it('uses the documented defaults (30s base, 15min cap) when opts is omitted', () => {
    expect(nextRetryDelayMs(1, undefined, () => 1)).toBe(30_000);
    expect(nextRetryDelayMs(20, undefined, () => 1)).toBe(900_000);
  });
});
