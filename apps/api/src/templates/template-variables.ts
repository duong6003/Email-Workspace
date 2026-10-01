import { RESERVED_CUSTOM_FIELD_KEYS } from '../custom-fields/dto/custom-field.dto.js';
import type { CustomFieldType } from '../database/entities/custom-field-definition.entity.js';
import type { TemplateVariableSchema } from '../database/entities/email-template-version.entity.js';

export type { TemplateVariableSchema } from '../database/entities/email-template-version.entity.js';

export type TemplateVariableToken = {
  field: 'subject' | 'html' | 'textBody';
  key: string;
  start: number;
  end: number;
};

export type TemplateVariableInput = {
  subject: string;
  html: string;
  textBody: string;
};

export type TemplateCustomField = {
  fieldKey: string;
  dataType: CustomFieldType;
  required: boolean;
  defaultValue: unknown;
};

export type TemplateConfiguredVariable = {
  variableKey: string;
  label: string;
  scope: 'global' | 'template';
  defaultValue: unknown;
  required: boolean;
  allowCampaignOverride: boolean;
};

export type SystemTemplateVariable = {
  key: (typeof RESERVED_CUSTOM_FIELD_KEYS)[number];
  label: string;
  required: boolean;
};

const systemVariableDetails = {
  email: { label: 'Email', required: true },
  first_name: { label: 'Tên', required: false },
  last_name: { label: 'Họ', required: false },
  unsubscribe_url: { label: 'Link hủy đăng ký', required: false },
} as const satisfies Record<(typeof RESERVED_CUSTOM_FIELD_KEYS)[number], Omit<SystemTemplateVariable, 'key'>>;

/** The custom-field reserved-key tuple is the single source for system-variable keys. */
export const SYSTEM_TEMPLATE_VARIABLES: readonly SystemTemplateVariable[] = RESERVED_CUSTOM_FIELD_KEYS
  .map((key) => ({ key, ...systemVariableDetails[key] }));

const MAX_TEMPLATE_VARIABLE_OCCURRENCES = 1_000;
const VARIABLE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export class TemplateVariableError extends Error {
  constructor(
    readonly code: 'DUPLICATE_VARIABLE' | 'MALFORMED_TEMPLATE_SYNTAX' | 'TEMPLATE_VARIABLE_LIMIT_EXCEEDED' | 'UNKNOWN_VARIABLE' | 'UNSAFE_TEMPLATE_EXPRESSION',
    readonly details: { field?: TemplateVariableToken['field']; variableKey?: string } = {},
  ) {
    super(code);
    this.name = 'TemplateVariableError';
  }

  get variableKey(): string | undefined {
    return this.details.variableKey;
  }
}

function rejectMalformed(field: TemplateVariableToken['field']): never {
  throw new TemplateVariableError('MALFORMED_TEMPLATE_SYNTAX', { field });
}

function rejectUnsafe(field: TemplateVariableToken['field']): never {
  throw new TemplateVariableError('UNSAFE_TEMPLATE_EXPRESSION', { field });
}

export function parseTemplateVariableTokens(input: TemplateVariableInput): TemplateVariableToken[] {
  const tokens: TemplateVariableToken[] = [];
  const fields: Array<[TemplateVariableToken['field'], string]> = [
    ['subject', input.subject],
    ['html', input.html],
    ['textBody', input.textBody],
  ];

  for (const [field, value] of fields) {
    let index = 0;
    while (index < value.length) {
      const open = value.indexOf('{{', index);
      const close = value.indexOf('}}', index);
      if (close !== -1 && (open === -1 || close < open)) rejectMalformed(field);
      if (open === -1) break;
      if (value[open + 2] === '{') rejectUnsafe(field);

      const end = value.indexOf('}}', open + 2);
      if (end === -1) rejectMalformed(field);
      const expression = value.slice(open + 2, end).trim();
      if (!VARIABLE_KEY_PATTERN.test(expression)) rejectUnsafe(field);
      tokens.push({ field, key: expression, start: open, end: end + 2 });
      if (tokens.length > MAX_TEMPLATE_VARIABLE_OCCURRENCES) {
        throw new TemplateVariableError('TEMPLATE_VARIABLE_LIMIT_EXCEEDED', { field });
      }
      index = end + 2;
    }
  }

  return tokens;
}

export function analyzeTemplateVariables(input: TemplateVariableInput, customFields: readonly TemplateCustomField[], configuredVariables: readonly TemplateConfiguredVariable[] = []): {
  schema: TemplateVariableSchema;
  tokens: TemplateVariableToken[];
} {
  const tokens = parseTemplateVariableTokens(input);
  const systemByKey = new Map(SYSTEM_TEMPLATE_VARIABLES.map((variable) => [variable.key, variable]));
  const customByKey = new Map<string, TemplateCustomField>();
  const configuredByKey = new Map<string, TemplateConfiguredVariable>();
  let duplicateVariableKey: string | undefined;
  for (const field of customFields) {
    if (systemByKey.has(field.fieldKey as (typeof RESERVED_CUSTOM_FIELD_KEYS)[number]) || customByKey.has(field.fieldKey)) {
      duplicateVariableKey ??= field.fieldKey;
    }
    customByKey.set(field.fieldKey, field);
  }
  for (const variable of configuredVariables) {
    if (systemByKey.has(variable.variableKey as (typeof RESERVED_CUSTOM_FIELD_KEYS)[number]) || customByKey.has(variable.variableKey)) {
      duplicateVariableKey ??= variable.variableKey;
    }
    configuredByKey.set(variable.variableKey, variable);
  }
  const required: string[] = [];
  const optional: string[] = [];
  const defaults: Record<string, unknown> = {};
  const resolved = new Set<string>();

  for (const token of tokens) {
    const system = systemByKey.get(token.key as (typeof RESERVED_CUSTOM_FIELD_KEYS)[number]);
    if (system) {
      if (resolved.has(token.key)) continue;
      resolved.add(token.key);
      (system.required ? required : optional).push(token.key);
      continue;
    }

    const custom = customByKey.get(token.key);
    const configured = configuredByKey.get(token.key);
    if (!custom && !configured) throw new TemplateVariableError('UNKNOWN_VARIABLE', { field: token.field, variableKey: token.key });
    if (resolved.has(token.key)) continue;
    resolved.add(token.key);
    const definition = configured ?? custom!;
    const hasDefault = (!configured || configured.scope === 'template')
      && definition.defaultValue !== null && definition.defaultValue !== undefined;
    if (definition.required && !hasDefault) required.push(token.key);
    else optional.push(token.key);
    if (hasDefault) defaults[token.key] = definition.defaultValue;
  }

  if (duplicateVariableKey) {
    throw new TemplateVariableError('DUPLICATE_VARIABLE', { variableKey: duplicateVariableKey });
  }

  const schema: TemplateVariableSchema = {
    required: required.sort(),
    optional: optional.sort(),
  };
  if (Object.keys(defaults).length > 0) schema.defaults = Object.fromEntries(Object.entries(defaults).sort(([left], [right]) => left.localeCompare(right)));
  const configured = [...configuredByKey.values()].filter((variable) => resolved.has(variable.variableKey));
  if (configured.length > 0) {
    schema.configured = Object.fromEntries(configured
      .sort((left, right) => left.variableKey.localeCompare(right.variableKey))
      .map((variable) => [variable.variableKey, {
        label: variable.label,
        scope: variable.scope,
        allowCampaignOverride: variable.allowCampaignOverride,
      }]));
  }
  return { schema, tokens };
}
