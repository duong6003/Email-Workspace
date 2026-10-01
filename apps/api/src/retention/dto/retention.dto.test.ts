import { describe, expect, it } from 'vitest';
import { retentionPolicySchema } from './retention.dto.js';

/** M6-S4 CP3 (A10). The Zod bound mirrors migration 032's own CHECK, so a
 *  rejected value is a 400 from validation, never a 500 from the database. */
describe('retentionPolicySchema', () => {
  it('accepts the floor and the ceiling', () => {
    expect(retentionPolicySchema.parse({ messageEventRetentionDays: 30 })).toEqual({ messageEventRetentionDays: 30 });
    expect(retentionPolicySchema.parse({ messageEventRetentionDays: 3650 })).toEqual({ messageEventRetentionDays: 3650 });
  });

  it('rejects a value below the floor', () => {
    expect(retentionPolicySchema.safeParse({ messageEventRetentionDays: 29 }).success).toBe(false);
  });

  it('rejects a value above the ceiling', () => {
    expect(retentionPolicySchema.safeParse({ messageEventRetentionDays: 3651 }).success).toBe(false);
  });

  it('rejects a non-integer', () => {
    expect(retentionPolicySchema.safeParse({ messageEventRetentionDays: 45.5 }).success).toBe(false);
  });
});
