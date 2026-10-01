import type { CampaignDraft, CampaignScheduleValidationReport } from '../../api/campaigns.js';

export type ComposeFieldKey = 'name' | 'subject' | 'sender' | 'audience' | 'template';
export type ComposeValidation = { errors: Partial<Record<ComposeFieldKey, string>>; firstInvalid: ComposeFieldKey | null };

export function localComposeValidation(draft: CampaignDraft, audienceActionable: number | null): ComposeValidation {
  const errors: ComposeValidation['errors'] = {};
  if (!draft.name.trim()) errors.name = 'Nhập tên chiến dịch để nhận biết bản ghi trong lịch sử và báo cáo.';
  if (!draft.subject.trim()) errors.subject = 'Nhập tiêu đề email. Thiếu tiêu đề sẽ chặn gửi và hẹn giờ.';
  if (!draft.sender.senderConfigId) errors.sender = 'Chọn một cấu hình gửi đã xác thực.';
  if (audienceActionable !== null && audienceActionable <= 0) errors.audience = 'Chọn ít nhất một người nhận đủ điều kiện.';
  if (!draft.templateVersionId) errors.template = 'Chọn một template đã xuất bản để tạo nội dung gửi.';
  return { errors, firstInvalid: (Object.keys(errors)[0] as ComposeFieldKey | undefined) ?? null };
}

const REASON_COPY: Record<string, string> = {
  CAMPAIGN_NAME_REQUIRED: 'Chưa nhập tên chiến dịch.',
  CAMPAIGN_SUBJECT_REQUIRED: 'Chưa nhập tiêu đề email.',
  SENDER_MISSING: 'Chưa chọn cấu hình gửi.',
  SENDER_NOT_FOUND: 'Cấu hình gửi đã chọn không còn tồn tại.',
  SENDER_NOT_VERIFIED: 'Cấu hình gửi chưa được xác thực.',
  SENDER_NOT_USABLE: 'Cấu hình gửi chưa sẵn sàng.',
  TEMPLATE_MISSING: 'Chưa chọn template đã xuất bản.',
  AUDIENCE_EMPTY: 'Chưa có người nhận đủ điều kiện.',
  AUDIENCE_OVER_LIMIT: 'Số người nhận vượt giới hạn cho phép.',
  QUOTA_EXCEEDED: 'Hạn mức gửi không đủ.',
};

export function preflightBlockers(report: CampaignScheduleValidationReport | null): string[] {
  if (!report) return [];
  const reasons = [report.name.reason, report.subject.reason, report.sender.reason, report.template.reason, report.audience.reason, report.quota.reason]
    .filter((reason): reason is string => Boolean(reason))
    .map((reason) => REASON_COPY[reason] ?? reason);
  if (!report.variables.valid) reasons.push(`${report.variables.missingCount} người nhận thiếu biến bắt buộc chưa được xử lý.`);
  return reasons;
}
