import { describe, expect, it } from 'vitest';
import { resolveLocalSchedule } from './schedule-time.js';

/**
 * R2 guard, must run first: a small-icu Node build silently resolves every
 * zone to UTC, which would make every DST assertion below pass vacuously.
 * Fail loud instead of testing nothing.
 */
describe('ICU guard (R2)', () => {
  it('resolves genuinely different offsets for Europe/Berlin in January vs July', () => {
    const jan = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' })
      .formatToParts(new Date(Date.UTC(2024, 0, 15)))
      .find((p) => p.type === 'timeZoneName')?.value;
    const jul = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' })
      .formatToParts(new Date(Date.UTC(2024, 6, 15)))
      .find((p) => p.type === 'timeZoneName')?.value;
    expect(jan, 'full ICU required: Node resolved Europe/Berlin to a fixed offset').not.toBe(jul);
  });
});

describe('resolveLocalSchedule (BR-SCH-002/003)', () => {
  it('rejects an unknown IANA zone', () => {
    expect(resolveLocalSchedule({ localDateTime: '2026-08-20T10:00', timeZone: 'Not/AZone' })).toMatchObject({ code: 'UNKNOWN_TIME_ZONE' });
  });

  it('rejects a malformed local date-time', () => {
    expect(resolveLocalSchedule({ localDateTime: '2026-08-20T10:00:00Z', timeZone: 'UTC' })).toMatchObject({ code: 'INVALID_LOCAL_DATE_TIME' });
  });

  it('UTC: round-trips with offsetMinutes 0', () => {
    const result = resolveLocalSchedule({ localDateTime: '2026-08-20T10:00', timeZone: 'UTC' });
    expect(result).toMatchObject({ offsetMinutes: 0, scheduledAtUtc: new Date('2026-08-20T10:00:00.000Z') });
  });

  it('Asia/Ho_Chi_Minh (no DST): round-trips at UTC+7 in both January and July', () => {
    const jan = resolveLocalSchedule({ localDateTime: '2026-01-15T09:00', timeZone: 'Asia/Ho_Chi_Minh' });
    const jul = resolveLocalSchedule({ localDateTime: '2026-07-15T09:00', timeZone: 'Asia/Ho_Chi_Minh' });
    expect(jan).toMatchObject({ offsetMinutes: 420, scheduledAtUtc: new Date('2026-01-15T02:00:00.000Z') });
    expect(jul).toMatchObject({ offsetMinutes: 420, scheduledAtUtc: new Date('2026-07-15T02:00:00.000Z') });
  });

  it('Europe/Berlin: round-trips at UTC+1 in winter and UTC+2 in summer', () => {
    const winter = resolveLocalSchedule({ localDateTime: '2026-01-15T09:00', timeZone: 'Europe/Berlin' });
    const summer = resolveLocalSchedule({ localDateTime: '2026-07-15T09:00', timeZone: 'Europe/Berlin' });
    expect(winter).toMatchObject({ offsetMinutes: 60, scheduledAtUtc: new Date('2026-01-15T08:00:00.000Z') });
    expect(summer).toMatchObject({ offsetMinutes: 120, scheduledAtUtc: new Date('2026-07-15T07:00:00.000Z') });
  });

  it('Europe/Berlin: a spring-forward gap local time is NONEXISTENT_LOCAL_TIME, never silently shifted', () => {
    const result = resolveLocalSchedule({ localDateTime: '2024-03-31T02:30', timeZone: 'Europe/Berlin' });
    expect(result).toMatchObject({ code: 'NONEXISTENT_LOCAL_TIME', localDateTime: '2024-03-31T02:30', timeZone: 'Europe/Berlin' });
    expect((result as { suggestedAtUtc: Date }).suggestedAtUtc).toBeInstanceOf(Date);
  });

  it('Europe/Berlin: a fall-back repeated local time is AMBIGUOUS_LOCAL_TIME with both candidate offsets', () => {
    const result = resolveLocalSchedule({ localDateTime: '2024-10-27T02:30', timeZone: 'Europe/Berlin' });
    expect(result).toMatchObject({ code: 'AMBIGUOUS_LOCAL_TIME', candidateOffsetMinutes: [60, 120] });
  });

  it('Europe/Berlin: supplying the explicit offset for an ambiguous local time resolves it', () => {
    const cet = resolveLocalSchedule({ localDateTime: '2024-10-27T02:30', timeZone: 'Europe/Berlin', offsetMinutes: 60 });
    const cest = resolveLocalSchedule({ localDateTime: '2024-10-27T02:30', timeZone: 'Europe/Berlin', offsetMinutes: 120 });
    expect(cet).toMatchObject({ offsetMinutes: 60, scheduledAtUtc: new Date('2024-10-27T01:30:00.000Z') });
    expect(cest).toMatchObject({ offsetMinutes: 120, scheduledAtUtc: new Date('2024-10-27T00:30:00.000Z') });
  });

  it('Australia/Lord_Howe (30-minute DST shift): round-trips at UTC+10:30 standard and UTC+11:00 DST', () => {
    const standard = resolveLocalSchedule({ localDateTime: '2024-07-15T09:00', timeZone: 'Australia/Lord_Howe' });
    const dst = resolveLocalSchedule({ localDateTime: '2024-01-15T09:00', timeZone: 'Australia/Lord_Howe' });
    expect(standard).toMatchObject({ offsetMinutes: 630, scheduledAtUtc: new Date('2024-07-14T22:30:00.000Z') });
    expect(dst).toMatchObject({ offsetMinutes: 660, scheduledAtUtc: new Date('2024-01-14T22:00:00.000Z') });
  });

  it('Australia/Lord_Howe: a 30-minute spring-forward gap is NONEXISTENT_LOCAL_TIME', () => {
    const result = resolveLocalSchedule({ localDateTime: '2024-10-06T02:15', timeZone: 'Australia/Lord_Howe' });
    expect(result).toMatchObject({ code: 'NONEXISTENT_LOCAL_TIME' });
  });

  it('Australia/Lord_Howe: a 30-minute fall-back repeat is AMBIGUOUS_LOCAL_TIME with both offsets', () => {
    const result = resolveLocalSchedule({ localDateTime: '2024-04-07T01:45', timeZone: 'Australia/Lord_Howe' });
    expect(result).toMatchObject({ code: 'AMBIGUOUS_LOCAL_TIME', candidateOffsetMinutes: [630, 660] });
  });
});
