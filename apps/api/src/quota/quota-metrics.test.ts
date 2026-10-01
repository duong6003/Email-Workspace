import { describe, expect, it } from 'vitest';
import { quotaUsageRatioMetric } from './quota-metrics.js';

describe('BR-CFG-006 / traceability-plan runtime_evidence: eow_quota_usage_ratio', () => {
  it('emits identifiers and magnitudes only, never a recipient or campaign name', () => {
    expect(quotaUsageRatioMetric({ tenantId: 't1', periodKey: '2026-08', used: 80, limit: 100, campaignId: 'c1' })).toEqual({
      metric: 'eow_quota_usage_ratio', tenant_id: 't1', period_key: '2026-08', campaign_id: 'c1', used: 80, limit: 100, value: 0.8,
    });
  });

  it('emits a null ratio rather than dividing by zero when the tenant is unlimited', () => {
    const metric = quotaUsageRatioMetric({ tenantId: 't1', periodKey: '2026-08', used: 5, limit: null, campaignId: null });
    expect(metric.value).toBeNull();
    expect(metric.limit).toBeNull();
  });
});
