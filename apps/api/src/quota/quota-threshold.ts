export const QUOTA_THRESHOLDS = [80, 90, 100] as const;
export type QuotaThreshold = (typeof QUOTA_THRESHOLDS)[number];

export function crossedThresholds(before: number, after: number, limit: number | null): QuotaThreshold[] {
  if (limit === null || limit <= 0 || after <= before) return [];
  const ratio = (value: number) => (value / limit) * 100;
  return QUOTA_THRESHOLDS.filter((threshold) => ratio(before) < threshold && ratio(after) >= threshold);
}
