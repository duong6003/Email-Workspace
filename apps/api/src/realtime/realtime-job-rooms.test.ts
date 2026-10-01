import { describe, expect, it } from 'vitest';
import { requestedJobIds } from './realtime-job-rooms.js';

describe('requestedJobIds', () => {
  it('accepts a legacy single job and a bounded list without duplicates', () => {
    expect(requestedJobIds({ jobId: 'one' })).toEqual(['one']);
    expect(requestedJobIds({ jobIds: ['one', 'two', 'one'] })).toEqual(['one', 'two']);
  });

  it('ignores malformed or excessive subscription requests', () => {
    expect(requestedJobIds({ jobIds: ['one', 2, 'two'] })).toEqual(['one', 'two']);
    expect(requestedJobIds({ jobIds: Array.from({ length: 51 }, (_, index) => String(index)) })).toEqual([]);
  });
});
