/**
 * Cùng ngưỡng với `LARGE_HTML_WARNING_BYTES` trong
 * apps/api/src/templates/template-content-lint.ts -- con số server dùng để phát
 * cảnh báo `HTML_SIZE_LARGE`. Dùng lại cái server đã coi là "lớn" thay vì bịa
 * một hằng số thứ hai cho cùng một khái niệm.
 */
export const THUMBNAIL_MAX_HTML_BYTES = 512 * 1024;

export type ThumbnailMode = 'pending' | 'thumbnail' | 'poster';

/**
 * Một thẻ trong thư viện chỉ có ba trạng thái: chưa có HTML (đang chờ lọt vào
 * tầm nhìn hoặc đang nạp), có HTML và render được, hoặc phải hạ xuống poster.
 *
 * Tách khỏi component để test được mà không cần DOM, IntersectionObserver hay
 * mạng -- đó cũng là ba thứ khiến nhánh fallback khó kiểm nhất.
 */
export function thumbnailMode(input: {
  html: string | null;
  failed: boolean;
  observerAvailable: boolean;
}): ThumbnailMode {
  if (input.failed || !input.observerAvailable) return 'poster';
  if (input.html === null) return 'pending';
  return new TextEncoder().encode(input.html).length > THUMBNAIL_MAX_HTML_BYTES ? 'poster' : 'thumbnail';
}
