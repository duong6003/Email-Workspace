export type RetryBackoffOptions = { baseMs: number; capMs: number };

const DEFAULT_OPTIONS: RetryBackoffOptions = { baseMs: 30_000, capMs: 900_000 };

/** BR-SEND-006. Worker-native duplicate of apps/api/src/campaigns/retry-backoff.ts (DEC-106). */
export function nextRetryDelayMs(
  attemptNo: number,
  opts: RetryBackoffOptions = DEFAULT_OPTIONS,
  rand: () => number = Math.random,
): number {
  const exponential = Math.min(opts.baseMs * 2 ** (attemptNo - 1), opts.capMs);
  return Math.round(exponential * (0.5 + rand() * 0.5));
}
