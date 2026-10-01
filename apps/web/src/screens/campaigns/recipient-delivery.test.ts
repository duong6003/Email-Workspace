import { describe, expect, it } from 'vitest';
import type { CampaignRecipientHistory } from '../../api/campaign-list.js';
import { RECIPIENT_STATUS_LABEL, recipientFailureReason } from './recipient-delivery.js';

const row = (overrides: Partial<CampaignRecipientHistory>): CampaignRecipientHistory => ({
  id: 'row-1', recipientId: 'recipient-1', email: 'an@example.test', displayName: 'An', status: 'failed', skippedReason: null,
  attemptCount: 1, providerMessageId: null, lastErrorCode: null, lastErrorClass: null, failureReason: null,
  lastAttemptAt: null, submittedAt: null, deliveredAt: null, nextRetryAt: null, updatedAt: '', ...overrides,
});

describe('recipient delivery reason', () => {
  it('prioritizes the safe provider response captured for the latest attempt', () => {
    expect(recipientFailureReason(row({ failureReason: 'No recipients defined', lastErrorCode: 'EENVELOPE' }))).toBe('No recipients defined');
  });

  it('turns a 553 not-logged-in response into an actionable authentication message', () => {
    expect(recipientFailureReason(row({ failureReason: '553 5.7.1 Sender address rejected: not logged in', lastErrorCode: 'EENVELOPE', lastErrorClass: 'auth' }))).toContain('tên đăng nhập');
  });

  it('explains EENVELOPE and skipped rows when a provider response is unavailable', () => {
    expect(recipientFailureReason(row({ lastErrorCode: 'EENVELOPE', lastErrorClass: 'permanent' }))).toContain('người nhận');
    expect(recipientFailureReason(row({ status: 'skipped', skippedReason: 'missing_required_variable' }))).toContain('Thiếu dữ liệu');
  });

  it('uses human delivery wording instead of raw provider states', () => {
    expect(RECIPIENT_STATUS_LABEL.pending).toBe('Đang chuẩn bị');
    expect(RECIPIENT_STATUS_LABEL.submitted).toBe('Máy chủ nhận đã chấp nhận');
    expect(RECIPIENT_STATUS_LABEL.failed).toBe('Gửi không thành công');
  });
});
