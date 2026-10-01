import { ApiError, errorPresentation } from '../../api/problem.js';

const TEMPLATE_ERROR_COPY: Record<string, string> = {
  TEMPLATE_DRAFT_INCOMPLETE: 'Bản nháp cần có cả tiêu đề và nội dung HTML trước khi xuất bản.',
  UNKNOWN_VARIABLE: 'Template đang dùng biến chưa tồn tại trong không gian làm việc.',
  MALFORMED_TEMPLATE_SYNTAX: 'Cú pháp biến trong template chưa đúng. Chỉ dùng dạng {{ten_bien}}.',
  UNSAFE_TEMPLATE_EXPRESSION: 'Template có biểu thức không an toàn. Helper, truy cập thuộc tính và biểu thức lồng nhau không được hỗ trợ.',
  DUPLICATE_VARIABLE: 'Danh mục biến có khóa bị trùng. Hãy kiểm tra các trường tùy chỉnh trước khi xuất bản.',
  TEMPLATE_VARIABLE_LIMIT_EXCEEDED: 'Một trường đang chứa quá nhiều biến. Hãy rút gọn nội dung rồi thử lại.',
  TEMPLATE_PUBLISH_CONFLICT: 'Template vừa được xuất bản ở phiên làm việc khác. Hãy tải lại danh sách trước khi thử lại.',
};

export function templatePublishError(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'Không thể xuất bản template. Vui lòng thử lại.';
  const presentation = errorPresentation(cause);
  const problem = cause.problem as (Record<string, unknown> & { fieldErrors?: Array<{ value?: unknown }> }) | null;
  const variableKey = typeof problem?.variableKey === 'string'
    ? problem.variableKey
    : typeof problem?.fieldErrors?.[0]?.value === 'string' ? problem.fieldErrors[0].value : null;
  const base = TEMPLATE_ERROR_COPY[presentation.code] ?? presentation.message;
  return variableKey ? `${base} Biến cần xử lý: {{${variableKey}}}.` : base;
}
