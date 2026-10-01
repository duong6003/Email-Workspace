import { describe, expect, it } from 'vitest';
import { importJobErrorFileUrl } from './import-jobs.js';

describe('import job artifacts', () => {
  it('exposes the canonical error-file endpoint for a failed import result', () => {
    expect(importJobErrorFileUrl('job-1')).toContain('/import-jobs/job-1/error-file');
  });
});
