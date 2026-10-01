import type { components } from '@eow/contracts';

export type Problem = components['schemas']['Problem'];

export type ErrorPresentation = {
  code: string;
  message: string;
  retryable: boolean;
  action: string | null;
  traceId: string | null;
};

const ERROR_COPY: Record<string, string> = {
  AUTH_REQUIRED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  ACCESS_DENIED: 'Bạn không có quyền thực hiện thao tác này.',
  RESOURCE_NOT_FOUND: 'Nội dung yêu cầu không còn tồn tại hoặc bạn không thể truy cập.',
  RESOURCE_CONFLICT: 'Dữ liệu đã thay đổi. Vui lòng tải lại và kiểm tra trước khi tiếp tục.',
  VERSION_CONFLICT: 'Bản nháp đã được thay đổi ở nơi khác. Thay đổi của bạn vẫn được giữ để xử lý xung đột.',
  PRECONDITION_REQUIRED: 'Cần tải phiên bản mới nhất trước khi lưu thay đổi.',
  VALIDATION_FAILED: 'Một số dữ liệu chưa hợp lệ. Vui lòng kiểm tra các trường được đánh dấu.',
  PAYLOAD_TOO_LARGE: 'Tệp hoặc dữ liệu gửi lên vượt quá giới hạn cho phép.',
  RATE_LIMITED: 'Bạn thao tác quá nhanh. Vui lòng chờ rồi thử lại.',
  TEMPLATE_UNKNOWN_VARIABLE: 'Template có biến dữ liệu chưa tồn tại. Hãy tạo trường tùy chỉnh, đổi tên hoặc xóa biến.',
  UNKNOWN_VARIABLE: 'Template có biến dữ liệu chưa tồn tại. Hãy tạo trường tùy chỉnh, đổi tên hoặc xóa biến.',
  TEMPLATE_DRAFT_INCOMPLETE: 'Bản nháp cần có tiêu đề và nội dung HTML trước khi xuất bản.',
  MALFORMED_TEMPLATE_SYNTAX: 'Cú pháp biến trong template chưa hợp lệ.',
  UNSAFE_TEMPLATE_EXPRESSION: 'Template có biểu thức biến không an toàn hoặc không được hỗ trợ.',
  DUPLICATE_VARIABLE: 'Danh mục biến có khóa bị trùng.',
  TEMPLATE_VARIABLE_LIMIT_EXCEEDED: 'Template vượt quá số lượng biến cho phép trong một trường.',
  TEMPLATE_PUBLISH_CONFLICT: 'Template vừa được xuất bản ở nơi khác. Vui lòng tải lại và thử lại.',
  SENDER_NOT_USABLE: 'Cấu hình gửi chưa được xác thực hoặc đã bị vô hiệu hóa.',
  SENDER_MISSING: 'Hãy chọn một cấu hình gửi đã xác thực trước khi gửi.',
  SENDER_NOT_FOUND: 'Cấu hình gửi đã chọn không còn tồn tại hoặc đã bị vô hiệu hóa.',
  SENDER_NOT_VERIFIED: 'Cấu hình gửi chưa được xác thực. Hãy kiểm tra kết nối trước khi gửi.',
  SENDER_REQUIRED: 'Hãy chọn một cấu hình gửi đã xác thực trước khi gửi.',
  QUOTA_EXCEEDED: 'Hạn mức gửi hiện tại không đủ cho phạm vi người nhận này.',
  CAMPAIGN_PREFLIGHT_BLOCKED: 'Chiến dịch chưa vượt qua các kiểm tra bắt buộc trước khi gửi.',
  CAMPAIGN_NAME_REQUIRED: 'Hãy nhập tên chiến dịch trước khi gửi hoặc hẹn giờ.',
  CAMPAIGN_SUBJECT_REQUIRED: 'Hãy nhập tiêu đề email trước khi gửi hoặc hẹn giờ.',
  AUDIENCE_EMPTY: 'Hãy chọn ít nhất một người nhận đủ điều kiện.',
  CUSTOM_FIELD_IN_USE: 'Trường tùy chỉnh đang được template sử dụng. Hãy sửa template trước khi xóa trường.',
  INTERNAL_ERROR: 'Hệ thống gặp lỗi tạm thời. Vui lòng thử lại sau.',
  SERVICE_UNAVAILABLE: 'Dịch vụ đang tạm thời gián đoạn. Vui lòng thử lại.',
  UPSTREAM_FAILURE: 'Dịch vụ liên quan đang gặp sự cố. Vui lòng thử lại.',
  UPSTREAM_TIMEOUT: 'Dịch vụ phản hồi quá chậm. Vui lòng thử lại.',
};

function safeFallback(status: number): string {
  if (status === 401) return ERROR_COPY.AUTH_REQUIRED!;
  if (status === 403) return ERROR_COPY.ACCESS_DENIED!;
  if (status === 404) return ERROR_COPY.RESOURCE_NOT_FOUND!;
  if (status === 409 || status === 412 || status === 428) return ERROR_COPY.RESOURCE_CONFLICT!;
  if (status === 429) return ERROR_COPY.RATE_LIMITED!;
  if (status >= 500 || status === 0) return ERROR_COPY.INTERNAL_ERROR!;
  return 'Không thể hoàn tất yêu cầu. Vui lòng kiểm tra dữ liệu và thử lại.';
}

export function errorPresentation(error: ApiError): ErrorPresentation {
  const code = error.problem?.code ?? (error.status === 0 ? 'NETWORK_ERROR' : 'REQUEST_FAILED');
  return {
    code,
    message: ERROR_COPY[code] ?? safeFallback(error.status),
    retryable: error.problem?.retryable ?? (error.status === 0 || error.status === 429 || error.status >= 500),
    action: error.problem?.nextAction ?? null,
    traceId: error.problem?.traceId ?? null,
  };
}

/** Typed client for the API's RFC 9457 (application/problem+json) error model. */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly problem: Problem | null) {
    super('');
    this.name = 'ApiError';
    this.message = errorPresentation(this).message;
  }
}

/**
 * True only for a genuine "not authenticated" response (401) -- distinct
 * from a system/network failure (500, timeout, offline), which must never
 * be presented or handled as "please log in" (that was RequireAuth's bug
 * before this node: it redirected to /login on *any* session-query error,
 * including a backend outage, silently discarding the user's location).
 */
export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** Parses a non-ok fetch Response into a typed ApiError, tolerating a body that is missing or not valid JSON. */
export async function parseErrorResponse(response: Response): Promise<never> {
  let problem: Problem | null = null;
  try {
    problem = await response.json();
  } catch {
    problem = null;
  }
  throw new ApiError(response.status, problem);
}

export function networkApiError(): ApiError {
  return new ApiError(0, null);
}
