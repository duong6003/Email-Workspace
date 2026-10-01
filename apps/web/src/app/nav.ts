/**
 * Route/nav table for the shell, matching
 * .agents/runs/2026-08-10-eow-master-execplan/ui-inventory.yaml → routing.routes
 * and the handoff's navGroups (app/page.tsx L11-29), ported to real
 * addressable routes instead of in-memory view state (DEC-003).
 *
 * Page titles used to live here as a pathname-keyed `pageMeta` map; they now
 * live in page-meta.ts, which matches by route pattern so routes with a
 * dynamic segment get a title instead of an empty <h1>.
 */
export type NavIconName = 'compose' | 'drafts' | 'recipients' | 'templates' | 'settings' | 'history';

export type NavItem = {
  id: string;
  label: string;
  icon: NavIconName;
  path: string;
  /**
   * Additional routes that also count as "on this nav item" for the active
   * highlight (see nav-active.ts) -- used by consolidated entries like
   * "Cấu hình", whose four sub-routes are route siblings, not descendants
   * of `path`.
   */
  activePaths?: string[];
  /**
   * BR-AUTH-003/004 (M1-S2): the permission required to see and use this
   * nav destination. Grounded in BR-AUTH-003's own acceptance text --
   * Operator "quan ly noi dung va gui" (content:manage) covers compose/
   * recipients/templates, Admin "quan tri cau hinh" (settings:manage)
   * covers sender configuration, and Viewer "chi xem lich su/bao cao"
   * (campaign:read) covers history. AppShell filters navGroups by this
   * against the real session.data.permissions from GET /auth/me -- a role
   * that cannot use a destination never sees it in the sidebar at all
   * (server-side enforcement is independent of this; this is only nav
   * presentation).
   */
  requiredPermission: string;
};

export type NavGroup = {
  label?: string;
  items: NavItem[];
};

export const navGroups: NavGroup[] = [
  {
    items: [{
      id: 'campaigns',
      label: 'Chiến dịch',
      icon: 'compose',
      path: '/campaigns',
      // No activePaths needed: the composer and the detail screen are route
      // descendants of /campaigns, which isNavItemActive matches directly.
      requiredPermission: 'campaign:read',
    }],
  },
  {
    label: 'QUẢN LÝ',
    items: [
      { id: 'recipients', label: 'Người nhận', icon: 'recipients', path: '/recipients', requiredPermission: 'recipient:read' },
      // content:read, not content:manage: the template section is browsable by
      // every role (073_content_read_permission.sql) and renders read-only for
      // anyone who cannot edit, per
      // docs/frontend/mailcraft-integration-requirements.md §5.1. Hiding the
      // destination would leave that read-only state unreachable.
      { id: 'templates', label: 'Email template', icon: 'templates', path: '/templates', requiredPermission: 'content:read' },
    ],
  },
  {
    label: 'HỆ THỐNG',
    items: [
      {
        id: 'settings',
        label: 'Cấu hình',
        icon: 'settings',
        path: '/settings/senders',
        activePaths: ['/settings/policy', '/settings/custom-fields', '/settings/global-variables'],
        requiredPermission: 'settings:manage',
      },
    ],
  },
];

/**
 * Route -> required permission. `campaign:read` is held by admin, operator and
 * viewer alike (004_rbac.sql), so every role reaches the campaign list and the
 * detail screen; only the composer stays behind content:manage.
 *
 * The two parameterised entries are documentation of intent -- AppRoutes wires
 * the literal permission strings, since a path with a segment cannot be looked
 * up by pathname.
 */
export const routePermissions: Record<string, string> = {
  '/campaigns': 'campaign:read',
  '/campaigns/new': 'content:manage',
  '/campaigns/:id/edit': 'content:manage',
  '/campaigns/:id': 'campaign:read',
  '/recipients': 'recipient:read',
  '/templates': 'content:read',
  // Same content:read as /edit (ADR-041): content:manage is enforced inside
  // the screen, not the route -- gating the route would blank it instead of
  // showing the read-only builder (conventions spec §2.1).
  '/templates/:id/build': 'content:read',
  '/settings/senders': 'settings:manage',
  '/settings/policy': 'settings:manage',
  '/settings/custom-fields': 'settings:manage',
  '/settings/global-variables': 'settings:manage',
};
