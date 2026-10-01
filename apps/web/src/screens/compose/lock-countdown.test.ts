import { describe, expect, it } from 'vitest';
import { computeLockCountdown } from './lock-countdown.js';

describe('computeLockCountdown', () => {
  it('counts down in minutes and seconds well before the lock window', () => {
    const result = computeLockCountdown(new Date('2026-08-20T08:30:00.000Z'), 120, new Date('2026-08-20T08:00:00.000Z'));
    expect(result.locked).toBe(false);
    expect(result.label).toBe('Khóa lịch sau 28 phút 0 giây');
  });

  it('shows seconds only once under a minute remains', () => {
    const result = computeLockCountdown(new Date('2026-08-20T08:30:00.000Z'), 120, new Date('2026-08-20T08:27:45.000Z'));
    expect(result.locked).toBe(false);
    expect(result.label).toBe('Khóa lịch sau 15 giây');
  });

  it('is locked once inside the lock window', () => {
    const result = computeLockCountdown(new Date('2026-08-20T08:30:00.000Z'), 120, new Date('2026-08-20T08:29:00.000Z'));
    expect(result.locked).toBe(true);
  });

  it('is locked exactly at the lock boundary', () => {
    const result = computeLockCountdown(new Date('2026-08-20T08:30:00.000Z'), 120, new Date('2026-08-20T08:28:00.000Z'));
    expect(result.locked).toBe(true);
  });

  it('stays locked after the scheduled instant has already passed (missed)', () => {
    const result = computeLockCountdown(new Date('2026-08-20T08:30:00.000Z'), 120, new Date('2026-08-20T08:35:00.000Z'));
    expect(result.locked).toBe(true);
  });
});
