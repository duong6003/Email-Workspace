import { describe, expect, it } from 'vitest';
import { countdownFrom } from './history-countdown.js';

/**
 * BR-HIS-004: "countdown dùng server time" -- the client's own clock must
 * never be consulted. Passing a serverTime that disagrees with the test
 * machine's real clock and asserting the countdown follows serverTime
 * proves that, rather than merely asserting a plausible-looking string.
 */
describe('countdownFrom (BR-HIS-004: server time, never the client clock)', () => {
  it('computes the remainder from serverTime, ignoring the real machine clock entirely', () => {
    const serverTime = '2026-08-18T10:00:00.000Z';
    const scheduledAtUtc = '2026-08-18T12:00:00.000Z';
    expect(countdownFrom(serverTime, scheduledAtUtc)).toBe('Còn 2 giờ 0 phút');
  });

  it('formats under an hour in minutes only', () => {
    const serverTime = '2026-08-18T10:00:00.000Z';
    const scheduledAtUtc = '2026-08-18T10:45:00.000Z';
    expect(countdownFrom(serverTime, scheduledAtUtc)).toBe('Còn 45 phút');
  });

  it('a serverTime that disagrees with the real clock by hours still produces the same countdown', () => {
    const scheduledAtUtc = '2026-08-18T12:00:00.000Z';
    const nearServerTime = '2026-08-18T11:50:00.000Z';
    const farServerTime = '2026-08-18T08:00:00.000Z';
    expect(countdownFrom(nearServerTime, scheduledAtUtc)).toBe('Còn 10 phút');
    expect(countdownFrom(farServerTime, scheduledAtUtc)).toBe('Còn 4 giờ 0 phút');
  });

  it('returns "Sắp gửi" once the scheduled instant has passed relative to serverTime', () => {
    const serverTime = '2026-08-18T12:00:01.000Z';
    const scheduledAtUtc = '2026-08-18T12:00:00.000Z';
    expect(countdownFrom(serverTime, scheduledAtUtc)).toBe('Sắp gửi');
  });
});
