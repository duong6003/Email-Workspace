import type { CampaignRecipientHistory } from '../../api/campaign-list.js';

export const RECIPIENT_STATUS_LABEL: Record<CampaignRecipientHistory['status'], string> = {
  pending: 'Đang chuẩn bị',
  queued: 'Sẵn sàng gửi',
  submitted: 'Máy chủ nhận đã chấp nhận',
  delivered: 'Đã giao thành công',
  bounced: 'Không giao được',
  failed: 'Gửi không thành công',
  skipped: 'Không gửi theo chính sách',
  cancelled: 'Đã dừng',
};

const SKIP_REASON: Record<string, string> = {
  deleted: 'Người nhận đã bị xóa trước khi đóng băng.',
  status_paused: 'Người nhận đang tạm dừng nhận email.',
  status_unsubscribed: 'Người nhận đã hủy đăng ký.',
  status_bounced: 'Địa chỉ đã bị đánh dấu nảy cứng.',
  excluded_by_list: 'Bị loại bởi danh sách loại trừ.',
  excluded_by_tag: 'Bị loại bởi tag loại trừ.',
  excluded_by_recipient: 'Bị loại trực tiếp khỏi chiến dịch.',
  duplicate_email: 'Trùng địa chỉ với một người nhận khác trong chiến dịch.',
  missing_required_variable: 'Thiếu dữ liệu bắt buộc để render template.',
};

export function recipientFailureReason(row: CampaignRecipientHistory): string | null {
  const providerReason = row.failureReason?.trim() ?? '';
  if (/not logged in|authenticat|login required/i.test(providerReason)) {
    return 'Máy chủ SMTP chưa xác thực tài khoản gửi. Hãy nhập đúng tên đăng nhập và mật khẩu/token, lưu cấu hình, rồi kiểm tra kết nối lại.';
  }
  if (providerReason) return providerReason;
  if (row.skippedReason) return SKIP_REASON[row.skippedReason] ?? `Bỏ qua: ${row.skippedReason}`;
  if (row.status === 'bounced') return 'Máy chủ nhận đã trả lại email.';
  if (row.lastErrorCode === 'EENVELOPE') {
    return row.lastErrorClass === 'config'
      ? 'Địa chỉ người gửi không hợp lệ. Kiểm tra cấu hình gửi.'
      : 'Địa chỉ người nhận không hợp lệ hoặc bị thiếu trong envelope.';
  }
  if (row.lastErrorCode === 'EAUTH') return 'Máy chủ SMTP từ chối thông tin xác thực. Kiểm tra tên đăng nhập, mật khẩu/token và quyền dùng địa chỉ người gửi.';
  if (row.lastErrorCode === 'ECONNREFUSED') return 'Không kết nối được tới máy chủ SMTP.';
  if (row.lastErrorCode?.startsWith('ETIMEDOUT')) return 'Kết nối SMTP quá thời gian chờ.';
  return row.lastErrorCode ? `Lỗi nhà cung cấp: ${row.lastErrorCode}` : null;
}

export function recipientStatusTone(status: CampaignRecipientHistory['status']): 'success' | 'danger' | 'warning' | 'processing' {
  if (status === 'delivered' || status === 'submitted') return 'success';
  if (status === 'failed' || status === 'bounced') return 'danger';
  if (status === 'skipped' || status === 'cancelled') return 'warning';
  return 'processing';
}
