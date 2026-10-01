import { z } from 'zod';

const name = z.string().trim().min(1).max(160);
const subject = z.string().trim().max(998);
const html = z.string().max(6 * 1024 * 1024);
const textBody = z.string().max(1024 * 1024);
const mergeData = z.record(z.string(), z.unknown()).default({});
const projectData = z.record(z.string(), z.unknown()).nullable();
const origin = z.enum(['imported', 'builder']);

export const createTemplateSchema = z.object({
  name,
  subject: subject.optional().default(''),
  html: html.optional().default(''),
  textBody: textBody.optional().default(''),
  origin: origin.optional().default('imported'),
}).strict();
export type CreateTemplateDto = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z.object({
  name: name.optional(),
  subject: subject.optional(),
  html: html.optional(),
  textBody: textBody.optional(),
  projectData: projectData.optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'At least one template field is required.');
export type UpdateTemplateDto = z.infer<typeof updateTemplateSchema>;

export const templateListQuerySchema = z.object({
  search: z.string().trim().min(1).max(160).optional(),
  status: z.enum(['draft', 'published']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type TemplateListQueryDto = z.infer<typeof templateListQuerySchema>;

export const templatePreviewSchema = z.object({
  mergeData,
}).strict();
export type TemplatePreviewDto = z.infer<typeof templatePreviewSchema>;

export const templateAnalyzeSchema = z.object({
  templateId: z.string().uuid().optional(),
  subject: subject.optional().default(''),
  html: html.optional().default(''),
  // No default: an omitted textBody has to stay distinguishable from one the
  // author cleared, because only the latter earns a TEXT_BODY_EMPTY warning.
  textBody: textBody.optional(),
}).strict();
export type TemplateAnalyzeDto = z.infer<typeof templateAnalyzeSchema>;

export const templateTestSendSchema = z.object({
  mergeData,
}).strict();
export type TemplateTestSendDto = z.infer<typeof templateTestSendSchema>;
