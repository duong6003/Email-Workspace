import { z } from 'zod';
import { variableTimezoneSchema } from '../../custom-fields/dto/custom-field.dto.js';
const email = z.string().email().max(320);
const name = z.string().trim().min(1).max(160);
const fromName = z.string().max(160);
const host = z.string().trim().min(1).max(255);
const port = z.number().int().min(1).max(65535);
const username = z.string().max(255);
const secret = z.string().max(4096);
export const createSenderSchema = z.object({ name, fromName: fromName.default(''), fromEmail: email, replyTo: email.nullish(), host, port: port.default(1025), username: username.default(''), secret: secret.default('') }).superRefine((value, context) => {
  if (value.username.trim() && !value.secret) context.addIssue({ code: 'custom', path: ['secret'], message: 'Mật khẩu/token là bắt buộc khi có tên đăng nhập SMTP.' });
});
export const updateSenderSchema = z.object({ name, fromName, fromEmail: email, replyTo: email.nullish(), host, port, username, secret }).partial().strict();
export const policySchema = z.object({
  defaultSenderConfigId: z.string().uuid().nullable(),
  replyTo: email.nullish(),
  batchSize: z.number().int().min(1).max(5000).default(100),
  maxAttempts: z.number().int().min(1).max(20).default(5),
  tenantRateLimitPerMinute: z.number().int().min(1).max(1_000_000).default(600),
  // ADR-036 scope item 3. No timezone existed per tenant anywhere -- `tenant`
  // holds only id/name/created_at -- so this per-tenant settings row is its
  // natural home and avoids a table of its own. NULL keeps the pre-ADR-036
  // behaviour, which is UTC.
  defaultTimezone: variableTimezoneSchema.nullish().default(null),
}).strict();
export type CreateSenderDto = z.infer<typeof createSenderSchema>;
export type UpdateSenderDto = z.infer<typeof updateSenderSchema>;
export type PolicyDto = z.infer<typeof policySchema>;
