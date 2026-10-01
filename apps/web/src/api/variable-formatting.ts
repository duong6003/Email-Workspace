import type { CustomFieldType } from './customFields.js';

/**
 * ADR-036 client side. Deliberately NOT a formatter: the rendered value comes
 * from the server (`renderTemplateVariables`, reached by both preview and the
 * campaign snapshot freeze), and re-deriving it here would recreate exactly the
 * preview/send divergence the ADR exists to prevent. What lives here is the
 * vocabulary a settings form needs -- which patterns to offer, which zones, and
 * how to describe a stored choice back to a reader.
 *
 * Every pattern below must use only the tokens
 * apps/api/src/templates/variable-value-format.ts recognises, or the API will
 * refuse the save. ARCH-VARIABLE-FORMAT-TOKENS in packages/architecture-tests
 * enforces that mechanically.
 */

/** The one type with a presentation today, mirroring FORMATTABLE_VARIABLE_TYPES on the API. */
export const FORMATTABLE_VARIABLE_TYPES: readonly CustomFieldType[] = ['date'];

export const DEFAULT_DATE_FORMAT = 'dd/MM/yyyy';

export type DateFormatPreset = {
  value: string;
  /** How 1 September 2026, 14:30 local reads in this pattern. */
  sample: string;
};

export const DATE_FORMAT_PRESETS: readonly DateFormatPreset[] = [
  { value: 'dd/MM/yyyy', sample: '01/09/2026' },
  { value: 'd/M/yyyy', sample: '1/9/2026' },
  { value: 'dd-MM-yyyy', sample: '01-09-2026' },
  { value: 'yyyy-MM-dd', sample: '2026-09-01' },
  { value: 'dd/MM/yyyy HH:mm', sample: '01/09/2026 14:30' },
  { value: 'HH:mm dd/MM/yyyy', sample: '14:30 01/09/2026' },
];

export function dateFormatPresetFor(format: string | null): DateFormatPreset | null {
  return DATE_FORMAT_PRESETS.find((preset) => preset.value === format) ?? null;
}

/**
 * Zones that must be offered whatever the runtime's own list looks like: they
 * are the ones this product's tenants actually live in, and they double as the
 * whole list for a browser too old for Intl.supportedValuesOf.
 *
 * Asia/Ho_Chi_Minh is the reason this is a merge rather than a fallback.
 * Node's ICU enumerates that zone under its older alias Asia/Saigon, so an
 * operator in Vietnam searching the select for "Ho_Chi_Minh" would find
 * nothing. Both names resolve identically in Intl.DateTimeFormat, so the API
 * accepts either.
 */
const REQUIRED_TIMEZONES: readonly string[] = [
  'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Jakarta', 'Asia/Kuala_Lumpur', 'Asia/Manila',
  'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
  'Etc/UTC', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles',
];

export function timezoneOptions(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const zones = typeof supported === 'function' ? supported.call(Intl, 'timeZone') : [];
  return [...new Set([...zones, ...REQUIRED_TIMEZONES])].sort();
}

export type VariablePresentation = {
  dataType: CustomFieldType;
  format: string | null;
  timezone: string | null;
};

/**
 * The API refuses a format on a type that has no presentation, so a form that
 * kept a stale value after the author switched the type back would fail to save
 * with an error about a control that is no longer on screen. Empty string means
 * "use the default", which the API spells as null.
 */
export function variableFormattingPayload(presentation: { dataType: CustomFieldType; format: string; timezone: string } | VariablePresentation): { format: string | null; timezone: string | null } {
  if (!FORMATTABLE_VARIABLE_TYPES.includes(presentation.dataType)) return { format: null, timezone: null };
  return {
    format: presentation.format?.trim() ? presentation.format.trim() : null,
    timezone: presentation.timezone?.trim() ? presentation.timezone.trim() : null,
  };
}

/** One line for a table cell: the effective pattern and zone, defaults spelled out rather than left blank. */
export function variablePresentationSummary(presentation: VariablePresentation): string | null {
  if (!FORMATTABLE_VARIABLE_TYPES.includes(presentation.dataType)) return null;
  return `${presentation.format ?? DEFAULT_DATE_FORMAT} · ${presentation.timezone ?? 'múi giờ mặc định'}`;
}
