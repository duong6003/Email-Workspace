import { describe, expect, it } from 'vitest';
import { buildJobEvent, shouldEmitProgress } from './job-events.js';

describe('buildJobEvent', () => {
  it('creates a versioned tenant-scoped progress envelope for a job room', () => {
    expect(buildJobEvent({ tenantId: 'tenant-1', jobId: 'job-1', eventType: 'import.progress', version: 3, data: { processedRows: 10 } }))
      .toMatchObject({ event_type: 'import.progress', tenant_id: 'tenant-1', aggregate_id: 'job-1', version: 3, data: { processedRows: 10 } });
  });

  it('limits progress publications to one per job per second', () => {
    const now = new Date('2026-08-11T11:00:01.000Z');
    expect(shouldEmitProgress(null, now)).toBe(true);
    expect(shouldEmitProgress(new Date('2026-08-11T11:00:00.001Z'), now)).toBe(false);
    expect(shouldEmitProgress(new Date('2026-08-11T11:00:00.000Z'), now)).toBe(true);
  });
});
