export type QuotaUsageMetric = {
  tenantId: string;
  periodKey: string;
  used: number;
  limit: number | null;
  campaignId: string | null;
};

export function quotaUsageRatioMetric(metric: QuotaUsageMetric): Record<string, string | number | null> {
  return {
    metric: 'eow_quota_usage_ratio',
    tenant_id: metric.tenantId,
    period_key: metric.periodKey,
    campaign_id: metric.campaignId,
    used: metric.used,
    limit: metric.limit,
    value: metric.limit === null || metric.limit <= 0 ? null : metric.used / metric.limit,
  };
}
