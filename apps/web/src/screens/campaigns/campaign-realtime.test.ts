import { describe, expect, it } from 'vitest';
import { applyProgressEvent, isCampaignProgressEvent, type CampaignProgressEvent } from './campaign-realtime.js';

describe('isCampaignProgressEvent', () => {
  it('accepts only campaign.progress events for the subscribed campaign', () => {
    expect(isCampaignProgressEvent({ aggregate_id: 'c-1', event_type: 'campaign.progress' }, 'c-1')).toBe(true);
    expect(isCampaignProgressEvent({ aggregate_id: 'c-2', event_type: 'campaign.progress' }, 'c-1')).toBe(false);
    expect(isCampaignProgressEvent({ aggregate_id: 'c-1', event_type: 'rt.resync_required' }, 'c-1')).toBe(false);
  });
});

describe('applyProgressEvent (ADR-010 + BR-SEND-003: never move a counter backwards)', () => {
  const campaignId = 'c-1';

  function event(version: number, overrides: Partial<CampaignProgressEvent> = {}): CampaignProgressEvent {
    return { aggregate_id: campaignId, event_type: 'campaign.progress', version, data: { percent: version * 10 }, ...overrides };
  }

  it('applies an event with a higher version than the current one', () => {
    const current = { version: 1, percent: 10 };
    const result = applyProgressEvent(current, event(2), campaignId);
    expect(result).toEqual({ percent: 20, version: 2 });
  });

  it('discards an event with an equal version', () => {
    const current = { version: 2, percent: 20 };
    const result = applyProgressEvent(current, event(2, { data: { percent: 99 } }), campaignId);
    expect(result).toBe(current);
  });

  it('discards an event with a lower version', () => {
    const current = { version: 5, percent: 50 };
    const result = applyProgressEvent(current, event(3, { data: { percent: 99 } }), campaignId);
    expect(result).toBe(current);
  });

  it('discards an event for a different campaign', () => {
    const current = { version: 1, percent: 10 };
    const result = applyProgressEvent(current, event(2, { aggregate_id: 'c-2' }), campaignId);
    expect(result).toBe(current);
  });

  it('discards an event with a non-numeric version', () => {
    const current = { version: 1, percent: 10 };
    const result = applyProgressEvent(current, event(2, { version: 'x' as never }), campaignId);
    expect(result).toBe(current);
  });

  it('applies the very first event when there is no current state', () => {
    const result = applyProgressEvent(null, event(1), campaignId);
    expect(result).toEqual({ percent: 10, version: 1 });
  });
});
