import { UnprocessableEntityException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { TemplateVariableSchema } from '../database/entities/email-template-version.entity.js';
import { ConfiguredVariablesRepository } from './configured-variables.repository.js';

export async function resolveConfiguredVariableValues(
  manager: EntityManager,
  tenantId: string,
  templateId: string,
  schema: TemplateVariableSchema,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  return mergeConfiguredVariableValues(
    schema,
    await new ConfiguredVariablesRepository(manager, tenantId).listForTemplate(templateId),
    overrides,
  );
}

export function mergeConfiguredVariableValues(
  schema: TemplateVariableSchema,
  definitions: ReadonlyArray<{ scope: 'global' | 'template'; variableKey: string; defaultValue: unknown }>,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const metadata = schema.configured ?? {};
  const allowedOverrides = new Set(Object.entries(metadata)
    .filter(([, definition]) => definition.allowCampaignOverride)
    .map(([key]) => key));
  const invalidOverride = Object.keys(overrides).find((key) => !allowedOverrides.has(key));
  if (invalidOverride) {
    throw new UnprocessableEntityException({
      code: 'VARIABLE_OVERRIDE_NOT_ALLOWED',
      message: 'The campaign contains a variable override that is not allowed by the published template.',
      variableKey: invalidOverride,
      fieldErrors: [{ field: `settings.variableOverrides.${invalidOverride}`, code: 'INVALID_VALUE' }],
    });
  }

  const globalValues = Object.fromEntries(definitions
    .filter((variable) => variable.scope === 'global' && metadata[variable.variableKey]?.scope === 'global')
    .map((variable) => [variable.variableKey, variable.defaultValue]));
  const templateDefaults = Object.fromEntries(Object.entries(schema.defaults ?? {})
    .filter(([key]) => metadata[key]?.scope === 'template'));
  return { ...globalValues, ...templateDefaults, ...overrides };
}
