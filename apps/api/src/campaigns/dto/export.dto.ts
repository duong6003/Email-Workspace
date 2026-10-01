import { z } from 'zod';

const messageStatuses = ['pending', 'queued', 'submitted', 'delivered', 'bounced', 'failed', 'skipped', 'cancelled'] as const;

/** BR-HIS-003. 'campaign_failures' is shorthand for statusFilter=['failed'] and ignores any explicit statusFilter. */
export const createExportSchema = z.object({
  kind: z.enum(['campaign_recipients', 'campaign_failures']).default('campaign_recipients'),
  statusFilter: z.array(z.enum(messageStatuses)).max(8).optional(),
}).strict();
export type CreateExportDto = z.infer<typeof createExportSchema>;
