import { z } from 'zod';

/**
 * M6-S4 (BR-HIS-006). Bounds mirror migration 032's
 * retention_policy_days_bounded CHECK: 30 days is the same floor
 * purge_message_events() enforces, so no reachable API value can ask the
 * purge to delete recent evidence.
 */
export const retentionPolicySchema = z.object({
  messageEventRetentionDays: z.number().int().min(30).max(3650),
});

export type RetentionPolicyDto = z.infer<typeof retentionPolicySchema>;
export type RetentionPolicyView = { messageEventRetentionDays: number; source: 'policy' | 'default' };
