import { z } from 'zod';

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  remember: z.boolean().default(false),
});

export type LoginRequestDto = z.infer<typeof loginRequestSchema>;
