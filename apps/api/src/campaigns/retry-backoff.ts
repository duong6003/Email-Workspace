export type RetryBackoffOptions = { baseMs: number; capMs: number };

const DEFAULT_OPTIONS: RetryBackoffOptions = { baseMs: 30_000, capMs: 900_000 };

/**
 * BR-SEND-006: exponential backoff with jitter. `rand` is injected (default
 * Math.random) so tests can pin the jitter band deterministically (R4) --
 * production always calls this with the default.
 *
 * Full-band jitter never drops below half the capped exponential value, so a
 * retry is never scheduled sooner than the backoff curve intends, only later
 * within the band.
 */
export function nextRetryDelayMs(
  attemptNo: number,
  opts: RetryBackoffOptions = DEFAULT_OPTIONS,
  rand: () => number = Math.random,
): number {
  const exponential = Math.min(opts.baseMs * 2 ** (attemptNo - 1), opts.capMs);
  return Math.round(exponential * (0.5 + rand() * 0.5));
}
