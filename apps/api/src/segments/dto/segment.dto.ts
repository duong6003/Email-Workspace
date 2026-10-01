import { z } from 'zod';

const uuidSchema = z.string().uuid();
const nameSchema = z.string().trim().min(1).max(160);

export const tagColorPalette = ['#ef6f45', '#7356c8', '#278b6e', '#d79022', '#3a78c2', '#9a5eb0', '#31806b', '#b85b73'] as const;
export type TagColor = (typeof tagColorPalette)[number];

export const segmentListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type SegmentListQueryDto = z.infer<typeof segmentListQuerySchema>;

export const createRecipientListSchema = z.object({
  name: nameSchema,
  description: z.string().trim().max(1_000).nullable().optional(),
}).strict();
export type CreateRecipientListDto = z.infer<typeof createRecipientListSchema>;

export const updateRecipientListSchema = createRecipientListSchema.partial().refine((value) => value.name !== undefined || value.description !== undefined, 'At least one property is required.');
export type UpdateRecipientListDto = z.infer<typeof updateRecipientListSchema>;

export const createTagSchema = z.object({
  name: nameSchema,
  color: z.enum(tagColorPalette),
}).strict();
export type CreateTagDto = z.infer<typeof createTagSchema>;

export const updateTagSchema = createTagSchema.partial().refine((value) => value.name !== undefined || value.color !== undefined, 'At least one property is required.');
export type UpdateTagDto = z.infer<typeof updateTagSchema>;

export const segmentMembersSchema = z.object({ recipientIds: z.array(uuidSchema).min(1).max(10_000) }).strict();
export type SegmentMembersDto = z.infer<typeof segmentMembersSchema>;
