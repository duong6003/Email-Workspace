import { describe, expect, it } from 'vitest';
import { campaignQueryString } from './campaigns.js';

describe('campaign API query serialization', () => {
  it('serializes only supplied bounded list filters', () => {
    expect(campaignQueryString({ status: 'draft', limit: 50, scope: 'mine' })).toBe('status=draft&limit=50&scope=mine');
    expect(campaignQueryString({})).toBe('');
  });
});
