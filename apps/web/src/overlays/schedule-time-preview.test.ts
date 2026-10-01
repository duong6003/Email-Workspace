import { describe, expect, it } from 'vitest';
import { formatHumanDateTimeInZone, formatInstantInZone, previewLocalSchedule } from './schedule-time-preview.js';

describe('previewLocalSchedule', () => {
  it('resolves a fixed +420 minute offset for Asia/Ho_Chi_Minh (no DST)', () => {
    const result = previewLocalSchedule('2026-08-20T08:30', 'Asia/Ho_Chi_Minh');
    expect(result).not.toBeNull();
    expect(result?.offsetMinutes).toBe(420);
    expect(result?.scheduledAtUtc.toISOString()).toBe('2026-08-20T01:30:00.000Z');
  });

  it('resolves a 0 offset for UTC', () => {
    const result = previewLocalSchedule('2026-08-20T08:30', 'UTC');
    expect(result?.offsetMinutes).toBe(0);
    expect(result?.scheduledAtUtc.toISOString()).toBe('2026-08-20T08:30:00.000Z');
  });

  it('returns null for an unknown IANA zone rather than a wrong offset', () => {
    expect(previewLocalSchedule('2026-08-20T08:30', 'Not/AZone')).toBeNull();
  });

  it('returns null for a malformed local date-time', () => {
    expect(previewLocalSchedule('2026-08-20 08:30', 'UTC')).toBeNull();
  });
});

describe('formatInstantInZone', () => {
  it('renders a UTC instant back into the zone local wall time, to the minute', () => {
    // Ground truth verified against real Intl/ICU (not assumed): the
    // NONEXISTENT_LOCAL_TIME suggestedAtUtc for 2024-03-31T02:30
    // Europe/Berlin (schedule-time.test.ts's own spring-forward fixture).
    expect(formatInstantInZone('2024-03-31T00:30:00.000Z', 'Europe/Berlin')).toBe('2024-03-31T01:30');
  });
});

describe('formatHumanDateTimeInZone', () => {
  it('renders a Vietnamese weekday + dd/mm/yyyy + "lúc" HH:mm, matching the handoff\'s presentation register', () => {
    // Ground truth verified against real Intl/ICU: 2026-12-24T01:30:00.000Z
    // is 08:30 in Asia/Ho_Chi_Minh (UTC+7) on a Thursday.
    expect(formatHumanDateTimeInZone('2026-12-24T01:30:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('Thứ Năm, 24/12/2026 lúc 08:30');
  });
});
