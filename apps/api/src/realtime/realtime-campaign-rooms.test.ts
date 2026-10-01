import { describe, expect, it } from 'vitest';
import { requestedCampaignIds } from './realtime-campaign-rooms.js';

describe('requestedCampaignIds', () => {
  it('accepts a singular campaignId and a bounded list without duplicates', () => {
    expect(requestedCampaignIds({ campaignId: 'one' })).toEqual(['one']);
    expect(requestedCampaignIds({ campaignIds: ['one', 'two', 'one'] })).toEqual(['one', 'two']);
  });

  it('ignores malformed or excessive subscription requests', () => {
    expect(requestedCampaignIds({ campaignIds: ['one', 2, 'two'] })).toEqual(['one', 'two']);
    expect(requestedCampaignIds({ campaignIds: Array.from({ length: 11 }, (_, index) => String(index)) })).toEqual([]);
  });

  it('returns an empty list for no auth payload at all', () => {
    expect(requestedCampaignIds(undefined)).toEqual([]);
    expect(requestedCampaignIds({})).toEqual([]);
  });
});
