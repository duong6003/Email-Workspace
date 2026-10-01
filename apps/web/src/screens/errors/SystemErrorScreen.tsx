import { UiIcon } from '../../app/ui-icons.js';

/**
 * The generic "error" required state (design-reference/ui-source-
 * contract.yaml -> required_states) for a session/system failure -- e.g.
 * GET /auth/me returning a 500 or the network being unreachable. Built from
 * the same handoff vocabulary as PermissionDeniedScreen (module-card,
 * .status pill, existing icon set): a system outage is not "you are not
 * logged in" and must never silently redirect to /login (that was
 * RequireAuth's pre-existing bug, fixed alongside this screen -- M1-S3).
 */
export function SystemErrorScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="workspace-module-frame standard-module-frame">
      <div className="module-frame-body">
        <div className="module-card permission-denied-card">
          <i aria-hidden="true">
            <UiIcon name="warning" size={22} />
          </i>
          <span className="status danger" role="status">
            Không thể tải dữ liệu
          </span>
          {/* This screen fully replaces the page (RequireAuth renders it in
              place of AppShell), so it must carry the page's only h1 and its
              own landmark -- unlike PermissionDeniedScreen, which is always
              nested inside AppShell's existing <main>/<h1> chrome. */}
          <h1>Đã xảy ra lỗi hệ thống</h1>
          <p>Không thể kết nối tới máy chủ. Vui lòng kiểm tra kết nối mạng và thử lại.</p>
          <button type="button" className="secondary-button" onClick={onRetry}>
            <UiIcon name="refresh" size={16} /> Thử lại
          </button>
        </div>
      </div>
    </main>
  );
}
