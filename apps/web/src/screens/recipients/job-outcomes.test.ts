import { describe, expect, it } from 'vitest';
import { jobOutcomeBreakdown } from './job-outcomes.js';

describe('jobOutcomeBreakdown', () => {
  it('keeps successes visible beside failures and exposes only unfinished rows for retry recovery', () => {
    expect(jobOutcomeBreakdown({ resolvedCount: 10, processedRows: 7, succeededRows: 4, failedRows: 2, skippedRows: 1 }))
      .toEqual({ processed: 7, succeeded: 4, failed: 2, skipped: 1, unfinished: 3 });
  });

  it('reports the import outcome aggregate supplied by the contract without inventing a duplicate count', () => {
    expect(jobOutcomeBreakdown({ totalRows: 6, processedRows: 6, succeededRows: 3, failedRows: 1, skippedRows: 2 }))
      .toEqual({ processed: 6, succeeded: 3, failed: 1, skipped: 2, unfinished: 0 });
  });
});
