/**
 * ADR-016: "Persist counters in PostgreSQL; workers emit throttled aggregate
 * updates no faster than 1/s or 250 recipients." Pure, clock-injected, no
 * timers -- both bounds are floors on spacing (>=), not ceilings on count,
 * so either firing is enough to open the gate.
 */
export const PROGRESS_THROTTLE_MS = 1_000;
export const PROGRESS_THROTTLE_RECIPIENTS = 250;

export type ThrottleState = { lastPublishedAtMs: number; recipientsSinceLastPublish: number };

export function createThrottleState(nowMs: number): ThrottleState {
  return { lastPublishedAtMs: nowMs, recipientsSinceLastPublish: 0 };
}

export function countRecipient(state: ThrottleState): ThrottleState {
  return { ...state, recipientsSinceLastPublish: state.recipientsSinceLastPublish + 1 };
}

export function shouldPublishProgress(state: ThrottleState, nowMs: number): boolean {
  return nowMs - state.lastPublishedAtMs >= PROGRESS_THROTTLE_MS
    || state.recipientsSinceLastPublish >= PROGRESS_THROTTLE_RECIPIENTS;
}

export function markPublished(state: ThrottleState, nowMs: number): ThrottleState {
  return { lastPublishedAtMs: nowMs, recipientsSinceLastPublish: 0 };
}
