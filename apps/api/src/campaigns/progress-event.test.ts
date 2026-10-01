import { describe, expect, it } from 'vitest';
import { buildProgressEvent } from './progress-event.js';
import type { ProgressCounts } from './progress-math.js';

const counts: ProgressCounts = { pending: 1, queued: 2, submitted: 3, delivered: 4, bounced: 1, failed: 5, skipped: 0, cancelled: 0 };

describe('buildProgressEvent (A8, A21)', () => {
  const event = buildProgressEvent({
    tenantId: '11111111-1111-1111-1111-111111111111',
    campaignId: '22222222-2222-2222-2222-222222222222',
    executionId: '33333333-3333-3333-3333-333333333333',
    progressSeq: 7,
    counts,
    actionable: 16,
    totalSnapshot: 16,
    status: 'sending',
    eta: { state: 'estimating' },
  });

  it('carries every EventEnvelope-required field with the right shapes', () => {
    expect(typeof event.event_id).toBe('string');
    expect(event.event_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(event.event_type).toBe('campaign.progress');
    expect(() => new Date(event.occurred_at).toISOString()).not.toThrow();
    expect(event.tenant_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(event.aggregate_id).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('uses progress_seq as version, not campaign.version (D-116/DEC-122)', () => {
    expect(event.version).toBe(7);
  });

  it('data carries counts, rollups, percent and eta', () => {
    expect(event.data.counts).toEqual(counts);
    expect(event.data.sent).toBe(counts.submitted + counts.delivered + counts.bounced);
    expect(event.data.delivered).toBe(counts.delivered);
    expect(event.data.failed).toBe(counts.failed + counts.bounced);
    expect(event.data.percent).toBeGreaterThanOrEqual(0);
    expect(event.data.percent).toBeLessThanOrEqual(100);
    expect(event.data.eta).toEqual({ state: 'estimating' });
    expect(event.data.execution_id).toBe('33333333-3333-3333-3333-333333333333');
    expect(event.data.total).toBe(16);
    expect(event.data.actionable).toBe(16);
    expect(event.data.status).toBe('sending');
  });

  it('never carries a recipient address or rendered body -- no "@" anywhere in the serialized payload', () => {
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('@');
  });
});
