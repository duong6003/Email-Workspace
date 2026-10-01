import { describe, expect, it } from 'vitest';
import { formatEta } from './eta-format.js';
import type { CampaignEtaEstimate } from '../../api/campaigns.js';

describe('formatEta (BR-SEND-005: never a number when there is none)', () => {
  it('returns null (renders no ETA row at all) once nothing remains', () => {
    expect(formatEta(null)).toBeNull();
  });

  it('reads "đang ước tính" below the sample threshold', () => {
    const eta: CampaignEtaEstimate = { state: 'estimating' };
    expect(formatEta(eta)).toBe('Đang ước tính…');
  });

  it('formats a real estimate in minutes and seconds', () => {
    const eta: CampaignEtaEstimate = { state: 'estimated', secondsRemaining: 125 };
    expect(formatEta(eta)).toBe('Còn khoảng 2 phút 5 giây');
  });

  it('formats an estimate under a minute in seconds only', () => {
    const eta: CampaignEtaEstimate = { state: 'estimated', secondsRemaining: 40 };
    expect(formatEta(eta)).toBe('Còn khoảng 40 giây');
  });
});
