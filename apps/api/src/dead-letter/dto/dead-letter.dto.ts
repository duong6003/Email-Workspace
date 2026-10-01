import { z } from 'zod';

export const deadLetterListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().uuid().optional(),
}).strict();

export type DeadLetterListQueryDto = z.infer<typeof deadLetterListQuerySchema>;
