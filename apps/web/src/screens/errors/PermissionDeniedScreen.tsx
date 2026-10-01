import { UiIcon } from '../../app/ui-icons.js';

/**
 * The `permission_denied` required state (design-reference/ui-source-
 * contract.yaml -> required_states), absent from the approved handoff (see
 * ui_intake evidence: "Required-state gap confirmed: loading, empty,
 * permission_denied and reconnecting are absent from the handoff"). Built
 * strictly from the handoff's own vocabulary: the module-card/
 * workspace-module-frame layout already used by ComingSoon, the .status
 * pill already used across recipient/template lists, and the existing
 * `lock` icon from ui-icons.tsx — see the M1-S2 CSS addition comment in
 * app/globals.css for the exact reused tokens (BR-AUTH-003/004; EXECPLAN
 * §9 M1-S2 step 4).
 */
export function PermissionDeniedScreen({ title = 'Bạn không có quyền truy cập trang này' }: { title?: string }) {
  return (
    <section className="workspace-module-frame standard-module-frame">
      <div className="module-frame-body">
        <div className="module-card permission-denied-card">
          <i aria-hidden="true">
            <UiIcon name="lock" size={22} />
          </i>
          <span className="status danger" role="status">
            Không đủ quyền truy cập
          </span>
          <h2>{title}</h2>
          <p>
            Vai trò hiện tại của bạn không cho phép thực hiện thao tác này. Vui lòng liên hệ quản trị viên nếu bạn cần được cấp quyền.
          </p>
        </div>
      </div>
    </section>
  );
}
