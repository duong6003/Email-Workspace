import type { EntityManager } from 'typeorm';
import { ConfiguredVariablesRepository } from '../configured-variables/configured-variables.repository.js';
import { CustomFieldsRepository } from '../custom-fields/custom-fields.repository.js';
import { SendingPolicyRepository } from '../sender-config/sender-config.repository.js';
import type { CustomFieldType } from '../database/entities/custom-field-definition.entity.js';
import type { VariableFormatDefinition, VariableFormatting } from './variable-value-format.js';

type FormattableDefinition = { dataType: CustomFieldType; format: string | null; timezone: string | null };

function definitionOf(source: FormattableDefinition): VariableFormatDefinition {
  return { dataType: source.dataType, format: source.format ?? null, timezone: source.timezone ?? null };
}

/**
 * ADR-036. Both variable systems share one `{{key}}` namespace, so they share
 * one formatting map. Configured variables are applied last for the same reason
 * analyzeTemplateVariables resolves `configured ?? custom`: the two key spaces
 * are kept disjoint by ConfiguredVariablesService.assertKeyAvailable, and if
 * that ever failed the two functions must at least agree on which definition
 * wins.
 */
export function buildVariableFormatting(
  customFields: ReadonlyArray<FormattableDefinition & { fieldKey: string }>,
  configuredVariables: ReadonlyArray<FormattableDefinition & { variableKey: string }>,
  tenantTimezone: string | null,
): VariableFormatting {
  const definitions: Record<string, VariableFormatDefinition> = {};
  for (const field of customFields) definitions[field.fieldKey] = definitionOf(field);
  for (const variable of configuredVariables) definitions[variable.variableKey] = definitionOf(variable);
  return { definitions, tenantTimezone };
}

/**
 * Reads the *current* definitions, never the version's frozen
 * variableSchemaJson -- that is the whole point of ADR-036, and the cost it
 * accepts. `templateId` is null for a draft analysis that has no template row
 * of its own; only tenant-global variables are in scope then.
 */
export async function resolveVariableFormatting(manager: EntityManager, tenantId: string, templateId: string | null): Promise<VariableFormatting> {
  const configuredVariables = new ConfiguredVariablesRepository(manager, tenantId);
  const [customFields, configured, policy] = await Promise.all([
    new CustomFieldsRepository(manager, tenantId).list(),
    templateId === null ? configuredVariables.listGlobal() : configuredVariables.listForTemplate(templateId),
    new SendingPolicyRepository(manager, tenantId).get(),
  ]);
  return buildVariableFormatting(customFields, configured, policy?.defaultTimezone ?? null);
}
