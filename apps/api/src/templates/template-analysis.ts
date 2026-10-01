import type { ConfiguredVariableScope, } from '../database/entities/configured-variable.entity.js';
import type { CustomFieldType } from '../database/entities/custom-field-definition.entity.js';
import { SYSTEM_TEMPLATE_VARIABLES, type TemplateVariableToken } from './template-variables.js';
import { DEFAULT_DATE_FORMAT, FALLBACK_TIMEZONE, formatVariableValue } from './variable-value-format.js';

type CataloguePresentation = { dataType: CustomFieldType; format: string | null; timezone: string | null };

/**
 * ADR-036 scope item 5. `{{ngay_het_han}}` deliberately says nothing about how
 * it renders -- that is the price of keeping the token grammar untouched -- so
 * the catalogue has to say it instead. `example` is the reference instant
 * rendered through the exact function the send uses, not a re-description of
 * it, so a wrong preview here means a wrong email rather than a stale caption.
 */
export type TemplateAnalysisCatalogueOptions = {
  tenantTimezone: string | null;
  reference?: Date;
};

function presentationOf(source: Partial<CataloguePresentation>, options: TemplateAnalysisCatalogueOptions) {
  const dataType = source.dataType ?? 'text';
  if (dataType !== 'date') return { dataType, format: null, timezone: null, example: null };
  const format = source.format ?? DEFAULT_DATE_FORMAT;
  const timezone = source.timezone ?? options.tenantTimezone ?? FALLBACK_TIMEZONE;
  return {
    dataType,
    format,
    timezone,
    example: formatVariableValue((options.reference ?? new Date()).toISOString(), { dataType, format, timezone }, options.tenantTimezone),
  };
}

export function buildTemplateAnalysisCatalogue(
  customFields: ReadonlyArray<{ fieldKey: string; label: string; required: boolean } & Partial<CataloguePresentation>>,
  configuredVariables: ReadonlyArray<{ variableKey: string; label: string; scope: ConfiguredVariableScope; required: boolean } & Partial<CataloguePresentation>>,
  options: TemplateAnalysisCatalogueOptions = { tenantTimezone: null },
) {
  return [
    ...SYSTEM_TEMPLATE_VARIABLES.map((field) => ({ key: field.key, label: field.label, classification: 'system' as const, source: 'system' as const, required: field.required, ...presentationOf({}, options) })),
    ...customFields.map((field) => ({ key: field.fieldKey, label: field.label, classification: 'custom' as const, source: 'recipient' as const, required: field.required, ...presentationOf(field, options) })),
    ...configuredVariables.map((field) => ({ key: field.variableKey, label: field.label, classification: 'custom' as const, source: field.scope, required: field.scope === 'template' && field.required, ...presentationOf(field, options) })),
  ];
}

export function classifyTemplateAnalysisTokens(tokens: readonly TemplateVariableToken[], customFields: ReadonlyArray<{ fieldKey: string; label: string }>, configuredVariables: ReadonlyArray<{ variableKey: string; label: string; scope: ConfiguredVariableScope }>) {
  const systemByKey = new Map(SYSTEM_TEMPLATE_VARIABLES.map((field) => [field.key, field]));
  const customByKey = new Map(customFields.map((field) => [field.fieldKey, field]));
  const configuredByKey = new Map(configuredVariables.map((field) => [field.variableKey, field]));
  return tokens.map((token) => {
    const system = systemByKey.get(token.key as (typeof SYSTEM_TEMPLATE_VARIABLES)[number]['key']);
    const custom = customByKey.get(token.key);
    const configured = configuredByKey.get(token.key);
    return {
      ...token,
      classification: system ? 'system' as const : custom || configured ? 'custom' as const : 'unknown' as const,
      source: system ? 'system' as const : custom ? 'recipient' as const : configured?.scope ?? 'unknown' as const,
      label: system?.label ?? custom?.label ?? configured?.label ?? null,
    };
  });
}
