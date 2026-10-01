const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export type SchedulePreview = { scheduledAtUtc: Date; offsetMinutes: number };

function isTimeZoneKnown(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function offsetMinutesAt(utcInstantMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcInstantMs)).map((part) => [part.type, part.value]));
  const wallAsUtcMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return (wallAsUtcMs - utcInstantMs) / 60_000;
}

/** Formats a UTC instant back into the zone as `YYYY-MM-DDTHH:mm`, to the minute. */
export function formatInstantInZone(utcIso: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcIso)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Same presentation register as the handoff's hardcoded schedule preview ("Thứ Ba, 11/08/2026 lúc 08:30"). */
export function formatHumanDateTimeInZone(utcIso: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('vi-VN', {
    timeZone, hourCycle: 'h23', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcIso)).map((part) => [part.type, part.value]));
  return `${parts.weekday}, ${parts.day}/${parts.month}/${parts.year} lúc ${parts.hour}:${parts.minute}`;
}

/**
 * Client-side preview only (M5-S2 CP6, plan SS3.6, BR-GEN-003's UI half): a
 * single-probe offset lookup at the naive instant itself, not the two-probe
 * round-trip `resolveLocalSchedule` (apps/api/src/campaigns/schedule-time.ts)
 * uses to detect a DST gap/repeat. Good enough to catch a wrong zone before
 * submit; the authoritative NONEXISTENT_LOCAL_TIME/AMBIGUOUS_LOCAL_TIME
 * decision always comes from the real `POST /schedule` 422, never
 * duplicated here (see schedule-error-copy.ts).
 */
export function previewLocalSchedule(localDateTime: string, timeZone: string): SchedulePreview | null {
  const match = LOCAL_DATE_TIME_PATTERN.exec(localDateTime);
  if (!match) return null;
  if (!isTimeZoneKnown(timeZone)) return null;

  const [, year, month, day, hour, minute] = match;
  const naiveUtcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const offsetMinutes = offsetMinutesAt(naiveUtcMs, timeZone);
  return { scheduledAtUtc: new Date(naiveUtcMs - offsetMinutes * 60_000), offsetMinutes };
}
