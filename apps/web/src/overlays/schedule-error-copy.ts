import { formatInstantInZone } from './schedule-time-preview.js';

/**
 * The extra fields `POST /schedule`'s 422 body carries beyond RFC 9457's
 * `Problem` shape (apps/api/src/campaigns/schedule-time.ts's
 * `ScheduleResolutionError` plus `campaigns.service.ts`'s
 * `OUT_OF_SCHEDULE_WINDOW`) -- not modeled in the OpenAPI `Problem` schema,
 * same established pattern as `ManageCustomFieldOverlay.tsx`'s
 * `reservedKeys` cast for BR-CF-003.
 */
export type ScheduleProblemExtras = {
  code?: string;
  minAt?: string;
  maxAt?: string;
  suggestedAtUtc?: string;
  candidateOffsetMinutes?: [number, number];
  timeZone?: string;
  /**
   * D-114: `POST /schedule`'s *other* 422 body -- BR-SCH-004's blocking
   * validation report -- carries no `code` at all, so it fell through to the
   * generic time/timezone copy. Modeled here for the sender dimension only;
   * the template/audience/variable dimensions are already blocked before this
   * overlay can submit (`p0Blocked`, ScheduleSendOverlay.tsx:94).
   */
  blocking?: boolean;
  sender?: { valid: boolean; reason?: string };
};

export type ScheduleErrorCopy = {
  message: string;
  suggestedLocalDateTime?: string;
  candidateOffsetMinutes?: [number, number];
};

const DEFAULT_MESSAGE = 'Không thể lên lịch gửi. Vui lòng kiểm tra lại thời gian và múi giờ.';

function formatUtcBound(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** A19: renders the schedule 422 codes as human copy, never a raw problem body. */
export function scheduleErrorCopy(problem: ScheduleProblemExtras | null): ScheduleErrorCopy {
  if (problem?.blocking && problem.sender?.valid === false) {
    return {
      message: problem.sender.reason === 'SENDER_NOT_FOUND'
        ? 'Không tìm thấy cấu hình gửi của chiến dịch. Hãy chọn lại cấu hình gửi.'
        : 'Cấu hình gửi chưa được xác minh hoặc đã bị tắt. Hãy kiểm tra và xác minh cấu hình gửi trước khi lên lịch.',
    };
  }
  switch (problem?.code) {
    case 'OUT_OF_SCHEDULE_WINDOW':
      return {
        message: problem.minAt && problem.maxAt
          ? `Thời gian gửi phải từ ${formatUtcBound(problem.minAt)} đến ${formatUtcBound(problem.maxAt)}.`
          : DEFAULT_MESSAGE,
      };
    case 'UNKNOWN_TIME_ZONE':
      return { message: 'Múi giờ không hợp lệ. Vui lòng chọn lại múi giờ.' };
    case 'NONEXISTENT_LOCAL_TIME':
      return {
        message: 'Thời điểm này không tồn tại do chuyển giờ mùa hè tại múi giờ đã chọn.',
        suggestedLocalDateTime: problem.suggestedAtUtc && problem.timeZone ? formatInstantInZone(problem.suggestedAtUtc, problem.timeZone) : undefined,
      };
    case 'AMBIGUOUS_LOCAL_TIME':
      return {
        message: 'Thời điểm này lặp lại do chuyển giờ mùa đông tại múi giờ đã chọn. Vui lòng chọn giờ cụ thể.',
        candidateOffsetMinutes: problem.candidateOffsetMinutes,
      };
    case 'INVALID_LOCAL_DATE_TIME':
      return { message: 'Ngày giờ không hợp lệ.' };
    default:
      return { message: DEFAULT_MESSAGE };
  }
}
