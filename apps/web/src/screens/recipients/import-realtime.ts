export type ImportJobEvent = { aggregate_id?: unknown; event_type?: unknown };

export function isImportJobEvent(event: ImportJobEvent, jobId: string): boolean {
  return event.aggregate_id === jobId && (event.event_type === 'import.progress' || event.event_type === 'import.completed');
}

export function activeJobIds(jobs: Array<{ id: string; status: string }>): string[] {
  return jobs.filter((job) => job.status === 'queued' || job.status === 'running').map((job) => job.id);
}
