/**
 * ADR-036. A typed variable's presentation -- currently only `date`, the type
 * that was leaking `2026-08-31T00:00:00.000Z` into customer-facing bodies --
 * is resolved here, at render time, from the *current* variable definition.
 * It is deliberately not part of the published version's frozen
 * `variableSchemaJson` and never enters `contentHash`: a format correction is
 * presentation configuration, not a content change (ADR-036 "Decision").
 *
 * No new dependency (ADR-018). `Intl.DateTimeFormat` with an explicit
 * `timeZone` already gives every calendar field in the target zone, which is
 * the same mechanism campaigns/schedule-time.ts uses for BR-SCH-002/003.
 */

export type VariableDataType = 'text' | 'number' | 'date' | 'boolean' | 'enum';

export type VariableFormatDefinition = {
  dataType: VariableDataType;
  format: string | null;
  timezone: string | null;
};

/**
 * Everything renderTemplateVariables needs to present typed values: one entry
 * per variable key in scope, plus the tenant fallback zone. Both halves are
 * read from live rows, never from the version snapshot.
 */
export type VariableFormatting = {
  definitions: Readonly<Record<string, VariableFormatDefinition>>;
  tenantTimezone: string | null;
};

/**
 * Vietnamese day-first ordering, matching every date already rendered in
 * apps/web. A tenant that wants something else sets it per variable.
 */
export const DEFAULT_DATE_FORMAT = 'dd/MM/yyyy';

/** Last resort when neither the variable nor the tenant declares a zone (ADR-036 resolution order). */
export const FALLBACK_TIMEZONE = 'Etc/UTC';

export const MAX_DATE_FORMAT_LENGTH = 40;

/** Longest-first: `yyyy` must win over `yy`, `MM` over `M`. */
const DATE_FORMAT_TOKENS = ['yyyy', 'yy', 'MM', 'M', 'dd', 'd', 'HH', 'H', 'mm', 'm', 'ss', 's'] as const;

type DateParts = Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;

function tokenAt(format: string, index: number): string | undefined {
  return DATE_FORMAT_TOKENS.find((token) => format.startsWith(token, index));
}

/**
 * Returns a human-readable reason the format is unusable, or null when it is
 * fine. Every ASCII letter must belong to a recognized token: that is what
 * turns `DD/MM/YYYY` -- the moment.js spelling, which would otherwise render
 * as the literal text "DD/MM/YYYY" in a real email -- into a validation error
 * at definition time rather than a silent defect at send time.
 */
export function dateFormatError(format: string): string | null {
  if (format.trim() === '') return 'Định dạng ngày không được để trống.';
  if (format.length > MAX_DATE_FORMAT_LENGTH) return `Định dạng ngày tối đa ${MAX_DATE_FORMAT_LENGTH} ký tự.`;

  let index = 0;
  let tokenCount = 0;
  while (index < format.length) {
    const token = tokenAt(format, index);
    if (token) {
      tokenCount += 1;
      index += token.length;
      continue;
    }
    if (/[A-Za-z]/.test(format[index])) {
      const word = /^[A-Za-z]+/.exec(format.slice(index))![0];
      return `"${word}" không phải ký hiệu ngày hợp lệ. Dùng ${DATE_FORMAT_TOKENS.join(', ')}; chữ đi kèm hãy viết trong template quanh biến.`;
    }
    index += 1;
  }
  if (tokenCount === 0) return `Định dạng ngày phải chứa ít nhất một ký hiệu (${DATE_FORMAT_TOKENS.join(', ')}).`;
  return null;
}

/** Returns a reason the zone is unusable, or null. Node's ICU is the authority, as in schedule-time.ts. */
export function timezoneError(timezone: string): string | null {
  if (timezone.trim() === '') return 'Múi giờ không được để trống.';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return null;
  } catch {
    return `"${timezone}" không phải múi giờ IANA hợp lệ (ví dụ: Asia/Ho_Chi_Minh).`;
  }
}

function partsInZone(instant: Date, timezone: string): DateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    year: String(parts.year).padStart(4, '0'),
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function unpadded(value: string): string {
  return String(Number(value));
}

function applyDateFormat(parts: DateParts, format: string): string {
  let rendered = '';
  let index = 0;
  while (index < format.length) {
    const token = tokenAt(format, index);
    if (!token) {
      rendered += format[index];
      index += 1;
      continue;
    }
    rendered += {
      yyyy: parts.year,
      yy: parts.year.slice(-2),
      MM: parts.month,
      M: unpadded(parts.month),
      dd: parts.day,
      d: unpadded(parts.day),
      HH: parts.hour,
      H: unpadded(parts.hour),
      mm: parts.minute,
      m: unpadded(parts.minute),
      ss: parts.second,
      s: unpadded(parts.second),
    }[token];
    index += token.length;
  }
  return rendered;
}

/** The pre-ADR-036 behaviour, still the whole story for every type but `date`. */
function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function toInstant(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * ADR-036 resolution order: the variable's own format/timezone, then the
 * tenant default timezone, then UTC.
 *
 * A value that is not a parsable instant is passed through untouched rather
 * than rendered as "Invalid Date". Configured variables were untyped free text
 * until this change, and a campaign override is still an arbitrary value, so a
 * `date` variable can legitimately be holding something that is not one --
 * showing the operator's own text is strictly better than showing garbage in a
 * customer's inbox.
 */
export function formatVariableValue(value: unknown, definition: VariableFormatDefinition | undefined, tenantTimezone: string | null): string {
  if (value === null || value === undefined) return '';
  if (definition?.dataType !== 'date') return toText(value);

  const instant = toInstant(value);
  if (!instant) return toText(value);

  const timezone = definition.timezone ?? tenantTimezone ?? FALLBACK_TIMEZONE;
  if (timezoneError(timezone) !== null) return toText(value);

  const format = definition.format ?? DEFAULT_DATE_FORMAT;
  if (dateFormatError(format) !== null) return toText(value);

  return applyDateFormat(partsInZone(instant, timezone), format);
}
