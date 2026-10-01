/**
 * BR-SEND-003/BR-SEND-005 arithmetic (M6-S1). API-native duplicate at
 * apps/api/src/campaigns/progress-math.ts (DEC-107's transliteration
 * precedent -- neither app can import the other's source, rootDir: "src",
 * no shared workspace package). ARCH-PROGRESS-PARITY keeps the two files in
 * step. Pure and DB-free by design so both copies are exhaustively
 * unit-testable without a database.
 */
export type ProgressCounts = {
  pending: number; queued: number; submitted: number; delivered: number;
  bounced: number; failed: number; skipped: number; cancelled: number;
};

export type ProgressRollups = { queued: number; sent: number; delivered: number; failed: number };

/**
 * D-105's rollup shape, unchanged: sent and failed deliberately overlap on
 * bounced -- a bounced message *was* sent and *did* fail. Only these
 * rollups are monotonic; `counts` is the exact partition that sums to
 * total_snapshot.
 */
export function rollupCounts(counts: ProgressCounts): ProgressRollups {
  return {
    queued: counts.pending + counts.queued,
    sent: counts.submitted + counts.delivered + counts.bounced,
    delivered: counts.delivered,
    failed: counts.failed + counts.bounced,
  };
}

/**
 * BR-SEND-003. Terminal send state = anything that left pending/queued.
 * Actionable = eligibility 'sendable', which is what `skipped` is already
 * excluded from upstream at freeze time, so it is not subtracted again here.
 */
export function progressPercent(counts: ProgressCounts, actionable: number): number {
  if (actionable <= 0) return 0;
  const terminal = counts.submitted + counts.delivered + counts.bounced + counts.failed;
  return Math.max(0, Math.min(100, Math.round((terminal / actionable) * 100)));
}

export const ETA_MIN_SAMPLES = 5;
export const ETA_WINDOW_MS = 120_000;

export type EtaEstimate = { state: 'estimating' } | { state: 'estimated'; secondsRemaining: number };

/**
 * BR-SEND-005. `sampleCount` is the number of message_attempt rows with
 * outcome='submitted' inside the window; `windowMs` is the observed span
 * between the oldest and newest of those samples, not the nominal window --
 * a burst of 100 sends in 2 seconds must not be averaged over 120. Returns
 * null (not 'estimating', not 0) once nothing remains: "biến mất khi
 * complete" is a disappearance, not a number.
 */
export function estimateEta(sampleCount: number, windowMs: number, remaining: number): EtaEstimate | null {
  if (remaining <= 0) return null;
  if (sampleCount < ETA_MIN_SAMPLES || windowMs <= 0) return { state: 'estimating' };
  const perSecond = sampleCount / (windowMs / 1000);
  if (perSecond <= 0) return { state: 'estimating' };
  return { state: 'estimated', secondsRemaining: Math.max(0, Math.ceil(remaining / perSecond)) };
}
