import { z } from 'zod';

const actionSchema = z.enum(['add_tag', 'remove_tag', 'add_list', 'remove_list', 'set_custom_data', 'export', 'delete']);

export const bulkJobCreateRequestSchema = z
  .object({
    action: actionSchema,
    actionPayload: z.record(z.string(), z.unknown()),
    recipientIds: z.array(z.string().uuid()).max(100_000),
  })
  .strict();

export type BulkJobCreateRequestDto = z.infer<typeof bulkJobCreateRequestSchema>;
