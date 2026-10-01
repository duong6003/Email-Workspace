export type DeadLetterDepthMetric = {
  metric: 'eow_dead_letter_depth';
  tenant_id: string;
  value: number;
};

export function deadLetterDepthMetric(tenantId: string, value: number): DeadLetterDepthMetric {
  return { metric: 'eow_dead_letter_depth', tenant_id: tenantId, value };
}
