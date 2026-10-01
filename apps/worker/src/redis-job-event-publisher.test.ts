import { describe, expect, it } from 'vitest';
import { jobChannel } from './redis-job-event-publisher.js';

describe('jobChannel', () => {
  it('uses the job id as the realtime authorization boundary', () => {
    expect(jobChannel('90ad8642-49cd-4736-b459-9d1cb63d0e88')).toBe('eow:job:90ad8642-49cd-4736-b459-9d1cb63d0e88');
  });
});
