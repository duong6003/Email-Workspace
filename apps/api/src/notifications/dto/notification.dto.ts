import { z } from 'zod';
// z.coerce.boolean() coerces any non-empty string via JS `Boolean(...)`, so the
// literal query string "false" (sent by the "all" filter) resolves to `true` --
// silently forcing every "all" request to behave as unread-only. Parse the two
// literal query values explicitly instead.
export const notificationListQuerySchema = z.object({ unread: z.enum(['true', 'false']).optional().default('false').transform((value) => value === 'true'), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() });
export type NotificationListQueryDto = z.infer<typeof notificationListQuerySchema>;
export const updateActionStateSchema = z.object({ actionState: z.enum(['open', 'resolved', 'expired']) });
export type UpdateActionStateDto = z.infer<typeof updateActionStateSchema>;
export const updatePreferenceSchema = z.object({ category: z.string().min(1).max(80), enabled: z.boolean() });
export type UpdatePreferenceDto = z.infer<typeof updatePreferenceSchema>;
