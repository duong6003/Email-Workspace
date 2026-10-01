import { describe, expect, it } from 'vitest';
import { ETA_MIN_SAMPLES, estimateEta, progressPercent, rollupCounts, type ProgressCounts } from './progress-math.js';

function counts(overrides: Partial<ProgressCounts>): ProgressCounts {
  return { pending: 0, queued: 0, submitted: 0, delivered: 0, bounced: 0, failed: 0, skipped: 0, cancelled: 0, ...overrides };
}

describe('rollupCounts (D-105, BR-SEND-003)', () => {
  it('overlaps sent and failed on bounced -- a bounced message was sent and did fail', () => {
    const result = rollupCounts(counts({ submitted: 2, delivered: 3, bounced: 1, failed: 4 }));
    expect(result).toEqual({ queued: 0, sent: 6, delivered: 3, failed: 5 });
  });

  it('queued rollup sums pending and queued', () => {
    const result = rollupCounts(counts({ pending: 2, queued: 3 }));
    expect(result.queued).toBe(5);
  });
});

describe('progressPercent (BR-SEND-003)', () => {
  it('is 0 when there are no actionable recipients', () => {
    expect(progressPercent(counts({}), 0)).toBe(0);
  });

  it('is 100 only when every actionable recipient is terminal', () => {
    const allTerminal = counts({ submitted: 5, delivered: 3, bounced: 1, failed: 1 });
    expect(progressPercent(allTerminal, 10)).toBe(100);
  });

  it('is less than 100 while any actionable recipient remains pending or queued', () => {
    const almostDone = counts({ submitted: 8, pending: 1, queued: 1 });
    expect(progressPercent(almostDone, 10)).toBe(80);
  });

  it('never exceeds 100 even if terminal exceeds actionable (defensive clamp)', () => {
    expect(progressPercent(counts({ submitted: 20 }), 10)).toBe(100);
  });

  it('is non-decreasing across a monotonic sequence of terminal counts', () => {
    const actionable = 10;
    const sequence = [
      counts({ submitted: 3, pending: 7 }),
      counts({ submitted: 6, pending: 4 }),
      counts({ submitted: 6, delivered: 2, pending: 2 }),
      counts({ submitted: 6, delivered: 4 }),
    ];
    const percents = sequence.map((c) => progressPercent(c, actionable));
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]);
    }
  });
});

describe('estimateEta (BR-SEND-005)', () => {
  it('returns estimating below the minimum sample size', () => {
    expect(estimateEta(ETA_MIN_SAMPLES - 1, 60_000, 100)).toEqual({ state: 'estimating' });
  });

  it('returns null once nothing remains -- not estimating, not zero', () => {
    expect(estimateEta(50, 60_000, 0)).toBeNull();
  });

  it('returns a non-negative estimate above the sample threshold', () => {
    const result = estimateEta(10, 60_000, 100);
    expect(result).not.toBeNull();
    if (result?.state === 'estimated') {
      expect(result.secondsRemaining).toBeGreaterThanOrEqual(0);
    } else {
      throw new Error('expected an estimated result');
    }
  });

  it('returns estimating for a zero-length window even with enough samples', () => {
    expect(estimateEta(10, 0, 100)).toEqual({ state: 'estimating' });
  });

  it('does not let a window with only failed/skipped attempts imply throughput -- caller passes zero samples for those', () => {
    // BR-SEND-005: "không dùng failed/skipped để thổi phồng throughput" is
    // enforced by the caller's SQL only counting outcome='submitted' rows
    // (progress-snapshot.ts); this pure function's own contract is that zero
    // samples always yields 'estimating', which is what that caller relies on.
    expect(estimateEta(0, 60_000, 100)).toEqual({ state: 'estimating' });
  });
});
