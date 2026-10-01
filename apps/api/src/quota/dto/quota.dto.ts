import { z } from 'zod';

export const quotaSchema = z.object({
  limit: z.number().int().positive().nullable(),
  period: z.enum(['day', 'month']),
});

export type QuotaUpdate = z.infer<typeof quotaSchema>;
