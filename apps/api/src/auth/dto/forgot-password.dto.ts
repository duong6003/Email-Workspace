import { z } from 'zod';

export const forgotPasswordRequestSchema = z.object({
  email: z.string().email(),
});

export type ForgotPasswordRequestDto = z.infer<typeof forgotPasswordRequestSchema>;

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'password must be at least 8 characters'),
});

export type ResetPasswordRequestDto = z.infer<typeof resetPasswordRequestSchema>;
