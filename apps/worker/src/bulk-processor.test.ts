import { describe, expect, it } from 'vitest';
import { bulkQueueJobId, classifyBulkJobStatus } from './bulk-processor.js';

describe('bulk worker helpers', () => {
  it('classifies a mixed terminal result as partial_success', () => {
    expect(classifyBulkJobStatus({ total: 3, succeeded: 2, failed: 1, skipped: 0 })).toBe('partial_success');
  });

  it('uses a deterministic queue id for an outbox retry', () => {
    expect(bulkQueueJobId('4c2b3f9b-61ed-4d86-9d99-6ad6b9580f92')).toBe('bulk-4c2b3f9b-61ed-4d86-9d99-6ad6b9580f92');
  });
});
