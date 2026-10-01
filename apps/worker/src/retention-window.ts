/**
 * M6-S4 (BR-HIS-006). The purge's own arithmetic, kept pure so it is
 * exhaustively testable without a database. The 30-day floor is repeated
 * inside migration 032's purge_message_events() -- this copy makes a wrong
 * caller impossible, that one makes a wrong *future* caller impossible.
 */
export const RETENTION_FLOOR_DAYS = 30;
export const DEFAULT_HISTORY_EVENT_RETENTION_DAYS = 365;

export function historyRetentionDefaultDays(configured: string | undefined): number {
  if (configured === undefined || configured === '') return DEFAULT_HISTORY_EVENT_RETENTION_DAYS;
  const days = Number(configured);
  if (!Number.isInteger(days) || days < RETENTION_FLOOR_DAYS || days > 3650) {
    throw new Error(`HISTORY_EVENT_RETENTION_DAYS must be an integer between ${RETENTION_FLOOR_DAYS} and 3650.`);
  }
  return days;
}

export function retentionCutoff(retentionDays: number, now: Date): Date {
  const days = Math.max(retentionDays, RETENTION_FLOOR_DAYS);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
