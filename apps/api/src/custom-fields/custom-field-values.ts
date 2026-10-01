import { BadRequestException } from '@nestjs/common';
import type { CustomFieldDefinitionEntity, CustomFieldType } from '../database/entities/custom-field-definition.entity.js';
import { RESERVED_CUSTOM_FIELD_KEYS } from './dto/custom-field.dto.js';

/**
 * What the coercion needs to know about a definition, independent of which of
 * the two variable systems it came from. `subject` is the phrase that names the
 * offender in the 400 -- "Custom field \"x\"" or "Variable \"x\"".
 */
export type TypedValueDescriptor = {
  subject: string;
  dataType: CustomFieldType;
  enumOptions: string[] | null;
  /**
   * True where every value arrives as text because a human typed it into a
   * settings form (ADR-036's configured variables). The recipient side leaves
   * this off: its customData comes from an API caller or an import mapper that
   * can send a real boolean, and silently accepting "false" there would hide a
   * caller sending the string "false" where it meant the value false.
   */
  parseTextualBoolean?: boolean;
};

/**
 * BR-CF-002 ("giá trị được lưu theo kiểu, không chỉ chuỗi"): coerces/
 * validates one value against a declared type. Returns the coerced value or
 * throws BadRequestException naming the offender -- never silently stores a
 * string where a typed value was declared.
 *
 * ADR-036 generalised this from recipient custom data to any typed variable
 * definition, so a configured variable declared `date` is normalised to the one
 * shape the render-time formatter can read, instead of being reimplemented.
 */
export function coerceTypedValue(field: TypedValueDescriptor, value: unknown): unknown {
  if (value === null) return null;

  switch (field.dataType) {
    case 'text': {
      if (typeof value !== 'string') {
        throw new BadRequestException(`${field.subject} expects a text value.`);
      }
      return value;
    }
    case 'number': {
      const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (typeof num !== 'number' || Number.isNaN(num)) {
        throw new BadRequestException(`${field.subject} expects a numeric value.`);
      }
      return num;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const textual = field.parseTextualBoolean && typeof value === 'string' ? value.trim().toLowerCase() : null;
      if (textual === 'true') return true;
      if (textual === 'false') return false;
      throw new BadRequestException(`${field.subject} expects a boolean value.`);
    }
    case 'date': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new BadRequestException(`${field.subject} expects an ISO-8601 date string.`);
      }
      return new Date(value).toISOString();
    }
    case 'enum': {
      const options = field.enumOptions ?? [];
      if (typeof value !== 'string' || !options.includes(value)) {
        throw new BadRequestException(`${field.subject} expects one of: ${options.join(', ')}.`);
      }
      return value;
    }
    default: {
      // Exhaustiveness guard; the DB CHECK constraint already restricts data_type.
      throw new BadRequestException(`${field.subject} has an unsupported type.`);
    }
  }
}

/** BR-CF-002 for one recipient custom-data value. */
export function coerceCustomFieldValue(field: CustomFieldDefinitionEntity, value: unknown): unknown {
  return coerceTypedValue({ subject: `Custom field "${field.fieldKey}"`, dataType: field.dataType, enumOptions: field.enumOptions }, value);
}

/** ADR-036: the same rule for a configured variable's stored default or shared value. */
export function coerceConfiguredVariableValue(
  variable: { variableKey: string; dataType: CustomFieldType; enumOptions: string[] | null },
  value: unknown,
): unknown {
  return coerceTypedValue({ subject: `Variable "${variable.variableKey}"`, dataType: variable.dataType, enumOptions: variable.enumOptions, parseTextualBoolean: true }, value);
}

/**
 * BR-CF-002/BR-CF-003: validates and coerces an entire recipient
 * `custom_data` patch against the tenant's current custom-field schema.
 *
 * - Any key that is a reserved system field (BR-CF-003) is rejected --
 *   defence in depth; the recipient DTO already models those as top-level
 *   fields (email/firstName/lastName), so this only fires for a caller
 *   that tries to smuggle one into customData directly.
 * - Any key with no matching custom_field_definition is rejected (typo
 *   protection; "system fields cannot be shadowed or redefined" implies
 *   the schema is the source of truth for what customData may contain).
 * - Every present value is type-coerced via coerceCustomFieldValue.
 * - Required fields missing from the patch fall back to their
 *   default_value when creating a new recipient (see `applyDefaults`);
 *   this function alone does not enforce requiredness on a partial update
 *   patch (a PATCH that does not touch customData at all must not be
 *   forced to supply every required field).
 */
export function validateCustomData(fields: CustomFieldDefinitionEntity[], data: Record<string, unknown>): Record<string, unknown> {
  const byKey = new Map(fields.map((field) => [field.fieldKey, field]));
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if ((RESERVED_CUSTOM_FIELD_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException({
        message: `"${key}" is a reserved system field and cannot be stored in customData.`,
        reservedKeys: RESERVED_CUSTOM_FIELD_KEYS,
      });
    }
    const field = byKey.get(key);
    if (!field) {
      throw new BadRequestException(`Unknown custom field key "${key}". Define it first via POST /custom-fields.`);
    }
    result[key] = coerceCustomFieldValue(field, value);
  }

  return result;
}

/** Fills in default_value for required fields that a create request did not supply. */
export function applyCustomFieldDefaults(fields: CustomFieldDefinitionEntity[], data: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };
  for (const field of fields) {
    if (field.required && !(field.fieldKey in result) && field.defaultValue !== null && field.defaultValue !== undefined) {
      result[field.fieldKey] = field.defaultValue;
    }
  }
  return result;
}
