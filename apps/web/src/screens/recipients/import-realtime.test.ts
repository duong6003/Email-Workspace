import { describe, expect, it } from 'vitest';
import { isImportJobEvent, activeJobIds } from './import-realtime.js';

describe('isImportJobEvent', () => {
  it('accepts only progress/completion events for the subscribed job', () => {
    expect(isImportJobEvent({ aggregate_id: 'job-a', event_type: 'import.progress' }, 'job-a')).toBe(true);
    expect(isImportJobEvent({ aggregate_id: 'job-b', event_type: 'import.completed' }, 'job-a')).toBe(false);
    expect(isImportJobEvent({ aggregate_id: 'job-a', event_type: 'campaign.progress' }, 'job-a')).toBe(false);
  });

  it('subscribes only to jobs that still need reconciliation', () => {
    expect(activeJobIds([{ id: 'a', status: 'queued' }, { id: 'b', status: 'completed' }, { id: 'c', status: 'running' }])).toEqual(['a', 'c']);
  });
});
