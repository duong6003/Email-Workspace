import { describe, expect, it } from 'vitest';
import { createSequenceGuard } from './sequence-guard.js';

describe('sequence guard', () => {
  it('accepts the most recently issued token', () => {
    const guard = createSequenceGuard();
    const token = guard.issue();
    expect(guard.isCurrent(token)).toBe(true);
  });

  it('rejects a token that a later request superseded', () => {
    const guard = createSequenceGuard();
    const first = guard.issue();
    const second = guard.issue();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it('keeps accepting the latest token for repeated checks', () => {
    const guard = createSequenceGuard();
    const token = guard.issue();
    expect([guard.isCurrent(token), guard.isCurrent(token)]).toEqual([true, true]);
  });
});
