export type JobCounters = {
  resolvedCount?: number;
  totalRows?: number;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
  skippedRows: number;
};

export type JobOutcomeBreakdown = {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  unfinished: number;
};

/** Counts are canonical server checkpoints; unfinished work remains explicit. */
export function jobOutcomeBreakdown(job: JobCounters): JobOutcomeBreakdown {
  const total = job.resolvedCount ?? job.totalRows ?? 0;
  return {
    processed: job.processedRows,
    succeeded: job.succeededRows,
    failed: job.failedRows,
    skipped: job.skippedRows,
    unfinished: Math.max(0, total - job.processedRows),
  };
}
