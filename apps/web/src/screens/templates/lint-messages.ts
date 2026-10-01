import type { TemplateAnalysis } from '../../api/templates.js';

/**
 * Vietnamese copy for the lint codes (spec §2.8, extended ADR-051) -- shared
 * between `TemplateEditorScreen` (the `imported`-origin editor, where this
 * lived until S4 Task 21) and `BuilderScreen` (MC-UI-008 `run_content_review`,
 * S4). One copy, not two screens independently translating the same codes.
 *
 * The `Record` is keyed by the mapped type over `TemplateAnalysis['lint'][number]['code']`
 * on purpose: a code missing an entry here is a compile error, not a runtime
 * gap -- the one place in the whole lint-code chain that is enforced for free
 * (see `LINT_CODES` in `apps/api/src/templates/template-content-lint.ts`).
 */
export const LINT_MESSAGE: Record<TemplateAnalysis['lint'][number]['code'], (count: number) => string> = {
  IMAGE_ALT_MISSING: (count) => `${count} ảnh thiếu mô tả alt.`,
  LINK_TARGET_MISSING: (count) => `${count} liên kết chưa có địa chỉ.`,
  LINK_PLACEHOLDER: (count) => `${count} liên kết còn dùng địa chỉ mẫu.`,
  LINK_INVALID: (count) => `${count} liên kết có giao thức hoặc địa chỉ không hợp lệ.`,
  TEXT_BODY_EMPTY: () => 'Nên bổ sung bản nội dung văn bản thuần.',
  HTML_SIZE_LARGE: () => 'HTML lớn có thể bị cắt ở một số hộp thư.',
  // ADR-051.
  HTML_SIZE_GMAIL_CLIP: () => 'HTML đủ lớn để Gmail cắt cụt email — phần bị cắt sẽ ẩn luôn, kể cả nút hủy đăng ký nếu nó nằm ở đó.',
  HEADING_ORDER_INVALID: (count) => `${count} chỗ thứ tự tiêu đề không hợp lý (thiếu H1, hoặc nhảy cấp).`,
};
