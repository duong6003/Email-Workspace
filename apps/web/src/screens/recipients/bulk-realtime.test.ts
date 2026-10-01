import { describe, expect, it } from 'vitest';
import { isBulkJobEvent } from './bulk-realtime.js';

describe('isBulkJobEvent', () => {
  it('accepts only progress/completion events for the subscribed bulk job', () => {
    expect(isBulkJobEvent({ aggregate_id: 'job-a', event_type: 'bulk_update.progress' }, 'job-a')).toBe(true);
    expect(isBulkJobEvent({ aggregate_id: 'job-a', event_type: 'bulk_update.completed' }, 'job-a')).toBe(true);
    expect(isBulkJobEvent({ aggregate_id: 'job-b', event_type: 'bulk_update.completed' }, 'job-a')).toBe(false);
    expect(isBulkJobEvent({ aggregate_id: 'job-a', event_type: 'import.completed' }, 'job-a')).toBe(false);
  });
});
