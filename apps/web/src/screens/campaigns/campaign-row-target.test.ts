import { describe, expect, it } from 'vitest';
import { campaignRowTarget } from './campaign-row-target.js';

describe('campaignRowTarget', () => {
  it('opens the composer for a draft, which has no send history yet', () => {
    expect(campaignRowTarget('draft', 'c-1')).toBe('/campaigns/c-1/edit');
  });

  it('opens the detail screen for every non-draft status', () => {
    for (const status of ['scheduled', 'queued', 'sending', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled', 'blocked', 'missed', 'validating']) {
      expect(campaignRowTarget(status, 'c-1')).toBe('/campaigns/c-1');
    }
  });

  it('does not encode or alter the id it is given', () => {
    expect(campaignRowTarget('draft', '11111111-1111-4111-8111-111111111111')).toBe('/campaigns/11111111-1111-4111-8111-111111111111/edit');
  });
});
