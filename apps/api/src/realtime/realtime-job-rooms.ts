const MAX_JOB_SUBSCRIPTIONS = 50;

export function requestedJobIds(auth: unknown): string[] {
  if (!auth || typeof auth !== 'object') return [];
  const value = auth as { jobId?: unknown; jobIds?: unknown };
  const candidates = Array.isArray(value.jobIds)
    ? value.jobIds
    : typeof value.jobId === 'string' ? [value.jobId] : [];
  if (candidates.length > MAX_JOB_SUBSCRIPTIONS) return [];
  return [...new Set(candidates.filter((jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0))];
}
