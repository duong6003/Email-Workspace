import { z } from 'zod';
import { MAX_DATE_FORMAT_LENGTH, dateFormatError, timezoneError } from '../../templates/variable-value-format.js';

/**
 * BR-CF-003: system/merge variables that a custom field may never shadow.
 * Shared with the API's 422 Problem body (see custom-fields.service.ts)
 * so the "valid keys" list the rule's acceptance text requires
 * ("Tạo key bị bảo lưu trả 422 với danh sách key hợp lệ") is generated
 * from one place, not duplicated.
 */
export const RESERVED_CUSTOM_FIELD_KEYS = ['email', 'first_name', 'last_name', 'unsubscribe_url'] as const;

// BR-CF-001: key is a-z/0-9/underscore, must start with a letter.
export const customFieldKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Key must start with a lowercase letter and contain only a-z, 0-9, underscore.');

// BR-CF-002: text, number, date, boolean, enum.
export const customFieldTypeSchema = z.enum(['text', 'number', 'date', 'boolean', 'enum']);

/**
 * ADR-036. Shared by both variable systems (custom fields and configured
 * variables), because both now declare their own presentation and both would
 * otherwise let `DD/MM/YYYY` -- the moment.js spelling, which renders as that
 * literal text in a customer's inbox -- reach the database.
 */
export const variableFormatSchema = z.string().trim().min(1).max(MAX_DATE_FORMAT_LENGTH).superRefine((value, context) => {
  const error = dateFormatError(value);
  if (error) context.addIssue({ code: 'custom', message: error });
});

export const variableTimezoneSchema = z.string().trim().min(1).max(64).superRefine((value, context) => {
  const error = timezoneError(value);
  if (error) context.addIssue({ code: 'custom', message: error });
});

/**
 * `date` is the only type with presentation today. Accepting a format on a
 * `text` field would store a setting that silently does nothing, which is
 * worse than a 400 that says so.
 */
export const FORMATTABLE_VARIABLE_TYPES: readonly z.infer<typeof customFieldTypeSchema>[] = ['date'];

export function assertFormattingApplies(
  body: { format?: string | null; timezone?: string | null },
  dataType: z.infer<typeof customFieldTypeSchema>,
  context: z.RefinementCtx,
): void {
  if (FORMATTABLE_VARIABLE_TYPES.includes(dataType)) return;
  for (const key of ['format', 'timezone'] as const) {
    if (body[key] !== undefined && body[key] !== null) {
      context.addIssue({ code: 'custom', path: [key], message: `${key} chỉ áp dụng cho kiểu ${FORMATTABLE_VARIABLE_TYPES.join(', ')}.` });
    }
  }
}

// BR-CF-001: key + label + type + required + default value + validation (enum options).
export const customFieldCreateRequestSchema = z
  .object({
    key: customFieldKeySchema,
    label: z.string().trim().min(1).max(120),
    type: customFieldTypeSchema,
    required: z.boolean().default(false),
    defaultValue: z.unknown().optional(),
    enumOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
    // BR-CF-009: recipient-level values for this field are masked in audit_log rows.
    sensitive: z.boolean().default(false),
    // ADR-036: presentation lives on the definition, not in the {{...}} token.
    format: variableFormatSchema.nullish(),
    timezone: variableTimezoneSchema.nullish(),
  })
  .strict()
  .superRefine((body, context) => assertFormattingApplies(body, body.type, context))
  .refine((body) => body.type !== 'enum' || (body.enumOptions && body.enumOptions.length > 0), {
    message: 'enumOptions is required and must be non-empty when type is "enum".',
    path: ['enumOptions'],
  })
  .refine((body) => body.type === 'enum' || body.enumOptions === undefined, {
    message: 'enumOptions is only valid when type is "enum".',
    path: ['enumOptions'],
  });
export type CustomFieldCreateRequestDto = z.infer<typeof customFieldCreateRequestSchema>;

// BR-CF-001: "đổi label không đổi key" -- key is immutable after creation,
// so it is deliberately absent from this schema. `.strict()` means a body
// that includes `key` is rejected with a 400 naming the unrecognized key,
// rather than silently ignored.
export const customFieldUpdateRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    required: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
    enumOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
    sensitive: z.boolean().optional(),
    // Nullable, not merely optional: null is how an author clears a format or a
    // timezone back to the product default and the tenant zone. The
    // "only for a date field" half is checked in the service, which is the only
    // place that knows the stored type -- BR-CF-001 keeps `type` immutable and
    // therefore absent from this schema.
    format: variableFormatSchema.nullish(),
    timezone: variableTimezoneSchema.nullish(),
  })
  .strict();
export type CustomFieldUpdateRequestDto = z.infer<typeof customFieldUpdateRequestSchema>;

export const customFieldListQuerySchema = z.object({}).strict();
export type CustomFieldListQueryDto = z.infer<typeof customFieldListQuerySchema>;
