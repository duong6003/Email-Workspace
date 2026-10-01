import { describe, expect, it } from 'vitest';
import { scheduleErrorCopy } from './schedule-error-copy.js';

describe('scheduleErrorCopy', () => {
  it('falls back to a generic message when there is no problem body', () => {
    const result = scheduleErrorCopy(null);
    expect(result.message).toBe('Không thể lên lịch gửi. Vui lòng kiểm tra lại thời gian và múi giờ.');
    expect(result.suggestedLocalDateTime).toBeUndefined();
    expect(result.candidateOffsetMinutes).toBeUndefined();
  });

  it('falls back to the generic message for an unrecognized code', () => {
    const result = scheduleErrorCopy({ code: 'SOMETHING_ELSE' });
    expect(result.message).toBe('Không thể lên lịch gửi. Vui lòng kiểm tra lại thời gian và múi giờ.');
  });

  it('renders OUT_OF_SCHEDULE_WINDOW with the computed lead/horizon bounds', () => {
    const result = scheduleErrorCopy({ code: 'OUT_OF_SCHEDULE_WINDOW', minAt: '2026-08-17T16:16:20.000Z', maxAt: '2027-08-17T16:14:20.000Z' });
    expect(result.message).toContain('2026-08-17 16:16 UTC');
    expect(result.message).toContain('2027-08-17 16:14 UTC');
  });

  it('renders UNKNOWN_TIME_ZONE as an invalid-zone message', () => {
    const result = scheduleErrorCopy({ code: 'UNKNOWN_TIME_ZONE', timeZone: 'Not/AZone' });
    expect(result.message).toBe('Múi giờ không hợp lệ. Vui lòng chọn lại múi giờ.');
  });

  it('renders NONEXISTENT_LOCAL_TIME with a one-click suggested local time', () => {
    // Same Europe/Berlin spring-forward fixture as schedule-time.test.ts
    // (apps/api) and schedule-time-preview.test.ts; suggestedAtUtc verified
    // against real Intl/ICU, not assumed.
    const result = scheduleErrorCopy({ code: 'NONEXISTENT_LOCAL_TIME', suggestedAtUtc: '2024-03-31T00:30:00.000Z', timeZone: 'Europe/Berlin' });
    expect(result.suggestedLocalDateTime).toBe('2024-03-31T01:30');
    expect(result.message).not.toBe('Không thể lên lịch gửi. Vui lòng kiểm tra lại thời gian và múi giờ.');
  });

  it('renders AMBIGUOUS_LOCAL_TIME with both candidate offsets echoed back', () => {
    const result = scheduleErrorCopy({ code: 'AMBIGUOUS_LOCAL_TIME', candidateOffsetMinutes: [60, 120] });
    expect(result.candidateOffsetMinutes).toEqual([60, 120]);
    expect(result.message).not.toBe('Không thể lên lịch gửi. Vui lòng kiểm tra lại thời gian và múi giờ.');
  });

  it('renders INVALID_LOCAL_DATE_TIME as a bad-input message', () => {
    const result = scheduleErrorCopy({ code: 'INVALID_LOCAL_DATE_TIME' });
    expect(result.message).toBe('Ngày giờ không hợp lệ.');
  });

  it('D-114: renders a blocking sender report as a sender problem, not as a time/timezone problem', () => {
    const result = scheduleErrorCopy({ blocking: true, sender: { valid: false, reason: 'SENDER_NOT_VERIFIED' } });
    expect(result.message).toBe('Cấu hình gửi chưa được xác minh hoặc đã bị tắt. Hãy kiểm tra và xác minh cấu hình gửi trước khi lên lịch.');
  });

  it('D-114: renders a missing sender config distinctly from an unverified one', () => {
    const result = scheduleErrorCopy({ blocking: true, sender: { valid: false, reason: 'SENDER_NOT_FOUND' } });
    expect(result.message).toBe('Không tìm thấy cấu hình gửi của chiến dịch. Hãy chọn lại cấu hình gửi.');
  });

  it('D-114: leaves a blocking report whose sender is valid on the generic message', () => {
    const result = scheduleErrorCopy({ blocking: true, sender: { valid: true } });
    expect(result.message).toBe('Không thể lên lịch gửi. Vui lòng kiểm tra lại thời gian và múi giờ.');
  });
});
