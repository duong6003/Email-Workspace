/**
 * M5-S2 (BR-SCH-002/003). No new dependency (ADR-018): Intl.DateTimeFormat
 * with a timeZone gives everything zone resolution needs. Pure, no I/O.
 *
 * Mechanism: compute the zone's UTC offset at two probe instants bracketing
 * the candidate (naive-local - 24h, naive-local + 24h), build one UTC
 * candidate per distinct offset, then format each candidate back into the
 * zone and keep only those whose formatted local time equals the requested
 * one. Zero survivors -> NONEXISTENT_LOCAL_TIME (spring-forward gap). Two ->
 * AMBIGUOUS_LOCAL_TIME, resolvable only by an explicit offsetMinutes. Exactly
 * one -> resolved. This is round-trip verification, not offset arithmetic, so
 * it is correct for any zone rule Node's ICU knows, including historical and
 * half-hour zones.
 */

const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export type LocalScheduleInput = {
  localDateTime: string;
  timeZone: string;
  offsetMinutes?: number;
};

export type ResolvedSchedule = {
  scheduledAtUtc: Date;
  timeZone: string;
  offsetMinutes: number;
};

export type ScheduleResolutionError =
  | { code: 'INVALID_LOCAL_DATE_TIME'; localDateTime: string }
  | { code: 'UNKNOWN_TIME_ZONE'; timeZone: string }
  | { code: 'NONEXISTENT_LOCAL_TIME'; localDateTime: string; timeZone: string; suggestedAtUtc: Date }
  | { code: 'AMBIGUOUS_LOCAL_TIME'; localDateTime: string; timeZone: string; candidateOffsetMinutes: [number, number] };

function isTimeZoneKnown(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset (minutes) such that wallClockInZone = utcInstant + offsetMinutes. */
function offsetMinutesAt(utcInstantMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcInstantMs)).map((part) => [part.type, part.value]));
  const wallAsUtcMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return (wallAsUtcMs - utcInstantMs) / 60_000;
}

/** Formats a UTC instant back into the zone as `YYYY-MM-DDTHH:mm`, to the minute. */
function formatInZone(utcInstantMs: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcInstantMs)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function resolveLocalSchedule(input: LocalScheduleInput): ResolvedSchedule | ScheduleResolutionError {
  const match = LOCAL_DATE_TIME_PATTERN.exec(input.localDateTime);
  if (!match) return { code: 'INVALID_LOCAL_DATE_TIME', localDateTime: input.localDateTime };
  if (!isTimeZoneKnown(input.timeZone)) return { code: 'UNKNOWN_TIME_ZONE', timeZone: input.timeZone };

  const [, year, month, day, hour, minute] = match;
  const naiveUtcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));

  if (input.offsetMinutes !== undefined) {
    const scheduledAtUtc = new Date(naiveUtcMs - input.offsetMinutes * 60_000);
    return { scheduledAtUtc, timeZone: input.timeZone, offsetMinutes: input.offsetMinutes };
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const probeOffsets = [offsetMinutesAt(naiveUtcMs - dayMs, input.timeZone), offsetMinutesAt(naiveUtcMs + dayMs, input.timeZone)];
  const distinctOffsets = [...new Set(probeOffsets)];

  const survivors = distinctOffsets.filter((offset) => formatInZone(naiveUtcMs - offset * 60_000, input.timeZone) === input.localDateTime);

  if (survivors.length === 0) {
    // No offset round-trips: a spring-forward gap. Suggest the later probe's
    // offset (the post-transition wall clock), the smallest well-defined
    // instant at or after the requested local time.
    const suggestedAtUtc = new Date(naiveUtcMs - probeOffsets[1] * 60_000);
    return { code: 'NONEXISTENT_LOCAL_TIME', localDateTime: input.localDateTime, timeZone: input.timeZone, suggestedAtUtc };
  }
  if (survivors.length >= 2) {
    const [first, second] = survivors.sort((a, b) => a - b);
    return { code: 'AMBIGUOUS_LOCAL_TIME', localDateTime: input.localDateTime, timeZone: input.timeZone, candidateOffsetMinutes: [first, second] };
  }
  const offsetMinutes = survivors[0];
  return { scheduledAtUtc: new Date(naiveUtcMs - offsetMinutes * 60_000), timeZone: input.timeZone, offsetMinutes };
}
