import { z } from 'zod';
import { assertFormattingApplies, customFieldTypeSchema, variableFormatSchema, variableTimezoneSchema } from '../../custom-fields/dto/custom-field.dto.js';

export const configuredVariableKeySchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);

const configuredVariableBody = z.object({
  key: configuredVariableKeySchema,
  label: z.string().trim().min(1).max(120),
  /**
   * ADR-036 scope item 1. A configured variable carried no type at all, so a
   * tenant-wide `{{ngay_khai_truong}}` could be neither validated on entry nor
   * formatted on the way out. Existing rows default to `text` -- which is
   * exactly what they already were -- so nothing about them changes.
   */
  dataType: customFieldTypeSchema.optional().default('text'),
  enumOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
  format: variableFormatSchema.nullish(),
  timezone: variableTimezoneSchema.nullish(),
  defaultValue: z.unknown().optional(),
  required: z.boolean().optional().default(false),
  allowCampaignOverride: z.boolean().optional().default(false),
}).strict();

/**
 * ADR-036 scope item 6, the half of the custom-field asymmetry that carries a
 * coherent meaning here: `enumOptions` constrains what an operator may type for
 * this variable. `sensitive` does not carry over -- BR-CF-009 masks a
 * *recipient-level* value in audit_log, and a configured variable has none: its
 * value is the definition itself, which every reader of the settings screen can
 * already see.
 */
function refineTypedVariable(body: { dataType: z.infer<typeof customFieldTypeSchema>; enumOptions?: string[]; format?: string | null; timezone?: string | null }, context: z.RefinementCtx): void {
  assertFormattingApplies(body, body.dataType, context);
  if (body.dataType === 'enum' && (body.enumOptions?.length ?? 0) === 0) {
    context.addIssue({ code: 'custom', path: ['enumOptions'], message: 'enumOptions là bắt buộc khi kiểu dữ liệu là "enum".' });
  }
  if (body.dataType !== 'enum' && body.enumOptions !== undefined) {
    context.addIssue({ code: 'custom', path: ['enumOptions'], message: 'enumOptions chỉ áp dụng cho kiểu dữ liệu "enum".' });
  }
}

export const createGlobalVariableSchema = configuredVariableBody.extend({
  defaultValue: z.unknown().refine((value) => value !== null && value !== undefined, 'Global variables require a value.'),
  required: z.literal(false).optional().default(false),
}).strict().superRefine(refineTypedVariable);
export type CreateGlobalVariableDto = z.infer<typeof createGlobalVariableSchema>;

/**
 * `dataType` is deliberately absent from every update schema, for the reason
 * BR-CF-001 keeps a custom field's `type` immutable: existing published
 * versions and stored values were written against the declared type, and
 * `.strict()` turns an attempted change into a 400 naming the field rather than
 * a silent no-op.
 */
export const updateGlobalVariableSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  defaultValue: z.unknown().refine((value) => value !== null && value !== undefined, 'Global variables require a value.').optional(),
  enumOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
  format: variableFormatSchema.nullish(),
  timezone: variableTimezoneSchema.nullish(),
  allowCampaignOverride: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'At least one field is required.');
export type UpdateGlobalVariableDto = z.infer<typeof updateGlobalVariableSchema>;

export const createTemplateVariableSchema = configuredVariableBody.superRefine(refineTypedVariable);
export type CreateTemplateVariableDto = z.infer<typeof createTemplateVariableSchema>;

export const updateTemplateVariableSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  defaultValue: z.unknown().optional(),
  enumOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
  format: variableFormatSchema.nullish(),
  timezone: variableTimezoneSchema.nullish(),
  required: z.boolean().optional(),
  allowCampaignOverride: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'At least one field is required.');
export type UpdateTemplateVariableDto = z.infer<typeof updateTemplateVariableSchema>;
