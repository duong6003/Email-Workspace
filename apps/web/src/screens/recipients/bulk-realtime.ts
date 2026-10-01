export type BulkJobEvent = { aggregate_id?: unknown; event_type?: unknown };

export function isBulkJobEvent(event: BulkJobEvent, jobId: string): boolean {
  return event.aggregate_id === jobId
    && (event.event_type === 'bulk_update.progress' || event.event_type === 'bulk_update.completed');
}
