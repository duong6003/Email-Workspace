import { describe, expect, it } from 'vitest';
import { countRecipient, createThrottleState, markPublished, shouldPublishProgress } from './progress-throttle.js';

describe('shouldPublishProgress (ADR-016: no faster than 1/s or 250 recipients)', () => {
  it('holds below both bounds', () => {
    const state = createThrottleState(1_000);
    expect(shouldPublishProgress(state, 1_999)).toBe(false);
  });

  it('fires at exactly one second', () => {
    const state = createThrottleState(1_000);
    expect(shouldPublishProgress(state, 2_000)).toBe(true);
  });

  it('fires at exactly 250 recipients inside the same millisecond', () => {
    let state = createThrottleState(1_000);
    for (let i = 0; i < 250; i += 1) state = countRecipient(state);
    expect(shouldPublishProgress(state, 1_000)).toBe(true);
  });

  it('holds at 249 recipients inside the same millisecond', () => {
    let state = createThrottleState(1_000);
    for (let i = 0; i < 249; i += 1) state = countRecipient(state);
    expect(shouldPublishProgress(state, 1_000)).toBe(false);
  });

  it('resets both bounds on publish', () => {
    let state = createThrottleState(1_000);
    for (let i = 0; i < 250; i += 1) state = countRecipient(state);
    state = markPublished(state, 1_500);
    expect(shouldPublishProgress(state, 1_999)).toBe(false);
    expect(state.recipientsSinceLastPublish).toBe(0);
  });
});
