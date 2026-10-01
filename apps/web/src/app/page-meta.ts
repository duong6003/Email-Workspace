export type PageMeta = { title: string; description: string };

const CAMPAIGN_LIST: PageMeta = { title: 'Chiến dịch', description: 'Theo dõi mọi chiến dịch, từ bản nháp đến kết quả gửi.' };
const CAMPAIGN_COMPOSE: PageMeta = { title: 'Soạn chiến dịch', description: 'Thay đổi được tự động lưu tuần tự để không ghi đè phiên mới hơn.' };
const CAMPAIGN_DETAIL: PageMeta = { title: 'Chi tiết chiến dịch', description: 'Tiến độ gửi và kết quả theo từng người nhận.' };
const SETTINGS: PageMeta = { title: 'Cấu hình', description: 'Quản lý cấu hình gửi, dữ liệu người nhận và biến dùng chung.' };
const TEMPLATE_EDITOR: PageMeta = { title: 'Chỉnh sửa template', description: 'Nội dung và biến riêng được lưu ở bản nháp; phiên bản đã xuất bản luôn bất biến.' };

/**
 * Pattern-matched rather than keyed by exact pathname. The previous
 * `pageMeta[location.pathname]` lookup silently rendered an empty <h1> on
 * every route with a dynamic segment -- /history/:campaignId did exactly
 * that -- so any new detail route inherited the same bug by default.
 *
 * Order matters: /campaigns/new and /campaigns/:id/edit must be tested
 * before the /campaigns/:id catch-all, which would otherwise swallow them.
 */
const ROUTES: ReadonlyArray<[RegExp, PageMeta]> = [
  [/^\/campaigns$/, CAMPAIGN_LIST],
  [/^\/campaigns\/new$/, CAMPAIGN_COMPOSE],
  [/^\/campaigns\/[^/]+\/edit$/, CAMPAIGN_COMPOSE],
  [/^\/campaigns\/[^/]+$/, CAMPAIGN_DETAIL],
  [/^\/recipients$/, { title: 'Người nhận', description: 'Quản lý danh sách liên hệ hoặc nhập dữ liệu từ Excel.' }],
  [/^\/templates\/[^/]+\/edit$/, TEMPLATE_EDITOR],
  [/^\/templates$/, { title: 'Email template', description: 'Quản lý, chỉnh sửa và xem trước các template HTML.' }],
  [/^\/settings\/(senders|policy|custom-fields|global-variables)$/, SETTINGS],
];

export function resolvePageMeta(pathname: string): PageMeta {
  return ROUTES.find(([pattern]) => pattern.test(pathname))?.[1] ?? { title: '', description: '' };
}

/** Routes that autosave. AppShell uses this to decide whether to show the save indicator. */
export function isAutosaveRoute(pathname: string): boolean {
  return isCampaignComposeRoute(pathname) || /^\/templates\/[^/]+\/edit$/.test(pathname);
}

/**
 * The campaign composer alone. Kept separate from isAutosaveRoute because the
 * shell hangs two different things off these predicates: the save indicator,
 * which every autosaving screen wants, and the "Gửi thử"/"Gửi ngay" header
 * actions, which only make sense for a campaign. Folding the template editor
 * into one predicate put send buttons on a screen that cannot send.
 */
export function isCampaignComposeRoute(pathname: string): boolean {
  return /^\/campaigns\/new$/.test(pathname) || /^\/campaigns\/[^/]+\/edit$/.test(pathname);
}

/**
 * ADR-041: decides layout only -- whether AppShell renders its compact focus
 * header instead of the sidebar/utility-bar/page-header/footer. Deliberately
 * its own predicate rather than a reuse of isAutosaveRoute, which today
 * happens to answer true for the same route but is asking a different
 * question (does this screen show a save indicator, not does this screen own
 * the whole viewport) -- the exact trap isCampaignComposeRoute's own comment
 * above already records for this file.
 */
export function isFocusRoute(pathname: string): boolean {
  return /^\/templates\/[^/]+\/build$/.test(pathname);
}
