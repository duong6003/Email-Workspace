import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { bulkQueueJobId } from './bulk-processor.js';
import { importQueueJobId } from './outbox-relay.js';

describe('import outbox relay', () => {
  it('uses a deterministic queue job id so a retried outbox publish cannot create a second worker job', () => {
    expect(importQueueJobId('4c2b3f9b-61ed-4d86-9d99-6ad6b9580f92')).toBe('import-4c2b3f9b-61ed-4d86-9d99-6ad6b9580f92');
  });

  it('uses the same deterministic strategy for bulk jobs', () => {
    expect(bulkQueueJobId('4c2b3f9b-61ed-4d86-9d99-6ad6b9580f92')).toBe('bulk-4c2b3f9b-61ed-4d86-9d99-6ad6b9580f92');
  });

  it('publishes the tenant id read from the trusted outbox row', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', aggregate_id: 'job-1', tenant_id: 'tenant-1' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const end = vi.fn();
    const poolSpy = vi.spyOn(pg, 'Pool').mockImplementation(function MockPool() { return { query, end }; } as never);
    const queue = { add: vi.fn().mockResolvedValue({}) };

    const { relayUnpublishedImportEvents } = await import('./outbox-relay.js');
    await relayUnpublishedImportEvents(`postgresql://${process.env.EOW_POSTGRES_USER ?? 'test'}@example.invalid/db`, queue as never);

    expect(queue.add).toHaveBeenCalledWith('process-import-job', { jobId: 'job-1', tenantId: 'tenant-1' }, expect.any(Object));
    poolSpy.mockRestore();
  });
});
