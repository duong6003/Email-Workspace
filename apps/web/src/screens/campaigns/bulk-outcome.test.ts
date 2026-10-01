import { describe, expect, it } from 'vitest';
import { bulkSummary, orphanReasons, reasonByCampaign, retrySet } from './bulk-outcome.js';

const response = {
  results: [
    { campaignId: 'a', outcome: 'succeeded' as const, code: 'OK', message: '' },
    { campaignId: 'b', outcome: 'succeeded' as const, code: 'OK', message: '' },
    { campaignId: 'c', outcome: 'failed' as const, code: 'CAMPAIGN_VERSION_CONFLICT', message: 'Campaign changed while the action was running.' },
    { campaignId: 'd', outcome: 'skipped' as const, code: 'CAMPAIGN_NOT_DRAFT', message: 'Only a draft campaign can be deleted.' },
  ],
  succeeded: 2, failed: 1, skipped: 1,
};

describe('bulkSummary', () => {
  it('reports the unfinished rows alongside the successes', () => {
    expect(bulkSummary('delete', response)).toBe('Đã xóa 2 chiến dịch. 2 chiến dịch không xử lý được.');
  });

  it('reports a clean run without mentioning failures', () => {
    expect(bulkSummary('duplicate', { results: [], succeeded: 3, failed: 0, skipped: 0 })).toBe('Đã nhân bản 3 chiến dịch.');
  });

  it('uses the right verb for cancel', () => {
    expect(bulkSummary('cancel', { results: [], succeeded: 1, failed: 0, skipped: 0 })).toBe('Đã dừng 1 chiến dịch.');
  });
});

describe('retrySet', () => {
  it('is exactly the rows that did not succeed', () => {
    expect(retrySet(response)).toEqual(['c', 'd']);
  });

  it('is empty for a clean run', () => {
    expect(retrySet({ results: [{ campaignId: 'a', outcome: 'succeeded' as const, code: 'OK', message: '' }], succeeded: 1, failed: 0, skipped: 0 })).toEqual([]);
  });
});

describe('reasonByCampaign', () => {
  it('maps each unfinished row to a short Vietnamese one-liner keyed by code', () => {
    expect(reasonByCampaign(response)).toEqual({
      c: 'Không xong: vừa bị người khác sửa.',
      d: 'Bỏ qua: chỉ xóa được bản nháp.',
    });
  });

  it('falls back to a generic line for an unrecognised code, never the server message', () => {
    const unknown = { results: [{ campaignId: 'x', outcome: 'failed' as const, code: 'WAT', message: 'a very long server sentence' }], succeeded: 0, failed: 1, skipped: 0 };
    expect(reasonByCampaign(unknown)).toEqual({ x: 'Không xong: lỗi không xác định.' });
  });

  it('keeps every reason to a single short line, because a wrapped reason breaks the table column widths', () => {
    for (const reason of Object.values(reasonByCampaign(response))) {
      expect(reason).not.toContain('\n');
      expect(reason.length).toBeLessThanOrEqual(48);
    }
  });
});

describe('orphanReasons', () => {
  it('is empty when every unfinished row is still on the page', () => {
    expect(orphanReasons(reasonByCampaign(response), ['a', 'b', 'c', 'd'])).toEqual([]);
  });

  it('surfaces the reason for an unfinished row that left the list', () => {
    expect(orphanReasons(reasonByCampaign(response), ['a', 'b', 'd'])).toEqual(['Không xong: vừa bị người khác sửa.']);
  });

  it('deduplicates identical reasons so the bar does not repeat itself', () => {
    const twoMissing = {
      results: [
        { campaignId: 'x', outcome: 'failed' as const, code: 'CAMPAIGN_NOT_FOUND', message: '' },
        { campaignId: 'y', outcome: 'failed' as const, code: 'CAMPAIGN_NOT_FOUND', message: '' },
      ],
      succeeded: 0, failed: 2, skipped: 0,
    };
    expect(orphanReasons(reasonByCampaign(twoMissing), [])).toEqual(['Không xong: chiến dịch không còn tồn tại.']);
  });

  /** The exact case found in the browser: a delete whose target had already gone. */
  it('does not silently drop the only reason when nothing is left to annotate', () => {
    const gone = {
      results: [{ campaignId: 'z', outcome: 'failed' as const, code: 'CAMPAIGN_NOT_FOUND', message: '' }],
      succeeded: 0, failed: 1, skipped: 0,
    };
    expect(orphanReasons(reasonByCampaign(gone), ['other'])).toHaveLength(1);
  });
});
