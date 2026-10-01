import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { UiIcon } from './ui-icons.js';
import { NavIcon } from './nav-icon.js';
import { navGroups } from './nav.js';
import { isAutosaveRoute, isCampaignComposeRoute, isFocusRoute, resolvePageMeta } from './page-meta.js';
import { isNavItemActive } from './nav-active.js';
import { useSidebarCollapsed, useTheme } from './use-theme.js';
import { useInvalidateSession, useSession } from '../auth/use-session.js';
import { hasPermission } from '../auth/permissions.js';
import { logout as apiLogout } from '../api/auth.js';
import { EntityActionMenu } from '../components/EntityActionMenu.js';
import type { FocusHeaderState, ShellSaveState } from './save-state.js';
import { FocusHeaderContext } from './focus-header-context.js';
import { NotificationPopover } from '../overlays/NotificationPopover.js';
import { listNotifications, notificationUnreadCount } from '../api/notifications.js';
import { socket, subscribeToNotifications } from '../api/realtime.js';
import { shouldRefetchOnReconnect, useRealtimeStatus, type RealtimeStatus } from '../api/realtime-status.js';

/**
 * Ported verbatim (DOM structure + class names) from
 * design-reference/ui-handoff-v2/source/app/page.tsx L277-309 (the
 * authenticated shell). Overlay system (action-overlays.tsx, 39 overlay
 * types), the command palette and the full Composer are out of this slice's
 * scope (M2-M7) — utility actions that would open them show a "coming soon"
 * toast instead of silently doing nothing or faking behaviour. Sign-out is
 * real and wired here directly (see EXECPLAN Decision Log for this node).
 */
export function AppShell() {
  const { theme, setTheme, darkActive } = useTheme();
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();
  const invalidateSession = useInvalidateSession();
  const [toast, setToast] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [saveState, setSaveState] = useState<ShellSaveState>('idle');
  const [focusHeader, setFocusHeader] = useState<FocusHeaderState>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const realtimeStatus = useRealtimeStatus();
  const previousRealtimeStatus = useRef<RealtimeStatus | null>(null);
  const refreshUnread = () => { void listNotifications(true).then((result) => setUnreadNotifications(result.unread)).catch(() => undefined); };
  const retryRealtime = () => {
    refreshUnread();
    if (!socket.connected) socket.connect();
  };
  useEffect(() => {
    const reconcile = (event: unknown) => {
      const unread = notificationUnreadCount(event);
      if (unread !== null) setUnreadNotifications(unread);
      window.dispatchEvent(new CustomEvent('eow:notification-reconcile', { detail: event }));
    };
    refreshUnread();
    subscribeToNotifications();
    socket.on('notification.created', reconcile);
    socket.on('notification.updated', reconcile);
    socket.on('notification.read', reconcile);
    return () => {
      socket.off('notification.created', reconcile);
      socket.off('notification.updated', reconcile);
      socket.off('notification.read', reconcile);
    };
  }, []);
  useEffect(() => {
    if (shouldRefetchOnReconnect(previousRealtimeStatus.current, realtimeStatus)) refreshUnread();
    previousRealtimeStatus.current = realtimeStatus;
  }, [realtimeStatus]);

  const meta = resolvePageMeta(location.pathname);
  const isAutosaveCompose = isAutosaveRoute(location.pathname);
  const isCampaignCompose = isCampaignComposeRoute(location.pathname);
  // ADR-041: layout only -- deliberately not isAutosaveRoute, which answers a
  // different question and only coincides with this route today.
  const focus = isFocusRoute(location.pathname);
  const saveStateText: Record<ShellSaveState, string> = {
    idle: 'Đã đồng bộ', saving: 'Đang tự động lưu…', saved: 'Đã tự động lưu', conflict: 'Xung đột khi lưu', error: 'Không thể tự động lưu',
  };

  // BR-AUTH-003/004 (M1-S2): a role that cannot use a destination does not
  // see it in the sidebar at all -- e.g. Viewer's nav shows only "Lịch sử
  // gửi" (campaign:read). This is presentation only; every route and the
  // API operations behind it are independently enforced server-side
  // regardless of what renders here (RequirePermission / PermissionGuard).
  const visibleNavGroups = navGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => hasPermission(session.data?.permissions, item.requiredPermission)) }))
    .filter((group) => group.items.length > 0);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await apiLogout();
    } finally {
      await invalidateSession();
      setSigningOut(false);
      navigate('/login', { replace: true });
    }
  };

  const initials = (session.data?.displayName ?? '')
    .split(' ')
    .filter(Boolean)
    .slice(-2)
    .map((part: string) => part[0]?.toUpperCase())
    .join('') || '··';

  return (
    <FocusHeaderContext.Provider value={setFocusHeader}>
    <main className={`${collapsed ? 'app-shell collapsed' : 'app-shell'} ${focus ? 'app-shell-focus' : ''} theme-${theme} ${darkActive ? 'theme-dark' : ''}`}>
      {!focus && <>
      <aside className="sidebar">
        {/* Two mark files, not one. The pen runs from #FB8A3C down to #68101F
            at the nib, and that dark end sits at 1.3:1 against the dark
            sidebar's #272226 -- the nib disappears into the panel. The dark
            file redraws the pen in a cream-to-white ramp, the same split the
            source concept sheet uses on its dark tile. An <img> cannot see the
            shell's theme-dark class, so the swap has to happen here.
            `logo-only` stays on the wrapper even though the wordmark is back:
            the border / radius / shadow / object-fit cancellation in
            globals.css is keyed on `.brand.logo-only>img`, and dropping the
            class would draw that box around the transparent SVG again. */}
        <div className="brand logo-only">
          <img src={darkActive ? '/mailspace-mark-dark.svg' : '/mailspace-mark.svg'} alt="MailSpace logo" />
          <div className="brand-copy">
            <b>MailSpace</b>
          </div>
        </div>
        {/* aria-label added (M1-S2 axe finding, zero visual change -- same
            category as M1-S1's tabIndex=-1 fix, not the left-as-is
            color-contrast design-token finding): the handoff has two <nav>
            landmarks (sidebar + footer) with no distinguishing label,
            which axe's landmark-unique rule flags once an authenticated
            page with AppShell is actually scanned (M1-S1 only scanned the
            public /login screen, which has no sidebar). */}
        <nav aria-label="Điều hướng chính">
          {visibleNavGroups.map((group, index) => (
            <div className="nav-group" key={group.label ?? index}>
              {group.label && <span className="nav-label">{group.label}</span>}
              {group.items.map((item) => {
                const active = isNavItemActive(item, location.pathname);
                return (
                  <NavLink
                    key={item.id}
                    to={item.path}
                    className={active ? 'nav-item active' : 'nav-item'}
                    title={collapsed ? item.label : undefined}
                  >
                    <i>
                      <NavIcon name={item.icon} />
                    </i>
                    <span>{item.label}</span>
                    {active && <em />}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <img src={darkActive ? '/mailspace-mark-dark.svg' : '/mailspace-mark.svg'} alt="" />
          <p>
            © 2026 MailSpace
            <br />
            <span>All rights reserved.</span>
          </p>
        </div>
      </aside>
      <button
        className="sidebar-edge-handle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'}
        title={collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'}
        onClick={() => setCollapsed(!collapsed)}
      >
        <UiIcon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
      </button>

      <header className="utility-bar">
        <button className="global-search" onClick={() => showToast('Tìm kiếm trong ứng dụng sẽ sớm ra mắt.')}>
          <UiIcon name="search" size={17} />
          <span>Tìm kiếm trong ứng dụng</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="utility-actions">
          {/* Only the autosave screens have a save state to report. Everywhere
              else this badge used to print a hardcoded "Đã đồng bộ" that tracked
              nothing, which reads as a status claim the shell cannot make. */}
          {isAutosaveCompose && <span className="save-state">
            <i />
            {saveStateText[saveState]}
          </span>}
          {/* Theme could only be changed from /login, so an authenticated user
              had to sign out to change it. Same three states, same glyphs and
              same shape as the login topbar's control, so it reads as the one
              switch in two places. It gets its own class rather than reusing
              .login-theme: those rules sit on approved handoff lines scoped to
              that screen, and wrapping the buttons in a div is also what keeps
              them clear of `.utility-actions>button:not(.profile)`.
              ARCH-HANDOFF: appended element, no approved line is edited. */}
          <div className="theme-switch" role="group" aria-label="Chọn giao diện">
            {(['light', 'system', 'dark'] as const).map((value) => (
              <button
                key={value}
                className={theme === value ? 'active' : ''}
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
                aria-label={value === 'light' ? 'Giao diện sáng' : value === 'dark' ? 'Giao diện tối' : 'Theo hệ thống'}
                title={value === 'light' ? 'Sáng' : value === 'dark' ? 'Tối' : 'Hệ thống'}
              >
                {value === 'light' ? '☀' : value === 'dark' ? '☾' : '◐'}
              </button>
            ))}
          </div>
          <button aria-label="Mở trợ giúp" title="Trợ giúp" onClick={() => showToast('Trung tâm trợ giúp sẽ sớm ra mắt.')}>
            <UiIcon name="help" size={18} />
          </button>
          <button className="notification-trigger" aria-label="Mở thông báo" title="Thông báo" onClick={() => setNotificationsOpen((open) => !open)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8Z" />
              <path d="M10 20h4" />
            </svg>
            {unreadNotifications > 0 && <span className="notification-badge" aria-label={`${unreadNotifications} thông báo chưa đọc`}>{unreadNotifications > 99 ? '99+' : unreadNotifications}</span>}
          </button>
          {/* The chevron promises a menu, so this opens one. It used to sign the
              user out on the first click, with no confirmation and no way back
              except logging in again -- on the most-clicked corner of the header. */}
          <EntityActionMenu
            label="Mở menu tài khoản"
            triggerClassName="profile"
            disabled={signingOut}
            trigger={<>
              <span>{initials}</span>
              <div>
                <b>{session.data?.displayName ?? '...'}</b>
                <small>{signingOut ? 'Đang đăng xuất...' : session.data?.role ?? ''}</small>
              </div>
              <i>
                <UiIcon name="chevronDown" size={15} />
              </i>
            </>}
            items={[{ label: 'Đăng xuất', icon: 'lock', tone: 'danger', disabled: signingOut, onSelect: () => void handleSignOut() }]}
          />
        </div>
      </header>
      </>}

      {/* ADR-041: focus mode swaps the sidebar/utility-bar/page-header/footer
          for this 56px bar. It stays inside AppShell (not a route outside
          it) precisely so theme, auth, notifications, realtime status and
          the save-state channel keep working unmodified -- see the ADR's
          Context section. Content (title/save-state/Preview/Publish) is
          supplied by the routed screen through FocusHeaderContext, since the
          shell has no business knowing what "publish" means for a template. */}
      {/* ADR-044 Task SV-2 ports the prototype's own header DOM onto this one
          (`v3-header` / `v3-brand` / `v3-doc` / `v3-head-actions` /
          `v3-history`). It stays AppShell's element: ADR-041 gives focus mode
          the header because only the shell can replace the sidebar and utility
          bar, and MC-UI-001's header is that header. Two prototype classes are
          deliberately absent -- see the ARCH-MAILCRAFT-DOM register. */}
      {focus && <header className="focus-header v3-header">
        {/* The prototype's brand is a <button> that opens the template
            library, and the port had flattened it to an aria-hidden <span>:
            the destination was gone and a screen reader could not read the
            product name at all. It is a button again wherever the screen
            offers somewhere to go, and a labelled span where it does not. */}
        {/* The Georgia "M" in a green box was the prototype's own Mailcraft
            brand, and it had no formal relationship to the MailSpace mark
            beside it in every other surface -- a letter in a box next to a
            drawn pen reads as two unrelated products, not a sub-brand. The mark
            is the MailSpace pen in Mailcraft green with three squares where
            MailSpace has three dots. Deviation from the prototype, registered
            in ARCH-MAILCRAFT-DOM against the 2026-09-10 spec. */}
        {focusHeader?.onBrand
          ? <button className="v3-brand" onClick={() => focusHeader.onBrand?.()} title="Mailcraft — mở kho mẫu">
              <img src={darkActive ? '/mailcraft-mark-white.svg' : '/mailcraft-mark.svg'} alt="" />
              <span className="visually-hidden">Mailcraft</span>
            </button>
          : <span className="v3-brand">
              <img src={darkActive ? '/mailcraft-mark-white.svg' : '/mailcraft-mark.svg'} alt="" />
              <span className="visually-hidden">Mailcraft</span>
            </span>}
        <div className="focus-header-title v3-doc">
          {/* Back belongs inside `v3-doc`, as its first child, which is where
              the prototype puts it: it navigates away from the document, so it
              reads as part of the document group rather than as a third thing
              wedged between the brand and the title. `.v3-doc>button` -- the
              borderless chevron -- is already in globals.css from studio.css
              and until now styled nothing in this position, because the port
              had made Back a sibling with an invented `focus-header-back`
              box instead. */}
          <button className="focus-header-back" aria-label="Quay lại" title="Quay lại" onClick={() => focusHeader?.onBack()}>‹</button>
          {/* The title and its save state go in their own column, which is what
              the prototype does -- `v3-doc` is a row holding Back and one block
              of document text. Without this wrapper the element carries both
              `focus-header-title` (a column) and `v3-doc` (a row), the column
              wins, and Back stacks ON TOP of the title instead of sitting
              beside it. That is what it did on first run here. */}
          <div className="focus-header-doc-body">
          {/* `builder-title-field` is kept on the editable form deliberately: six
              e2e specs use `.builder-title-field input` as their "the builder is
              up" signal, and the header is the one surface visible at every
              width -- which the inspector is not (`.builder-workspace` is
              display:none below 1024px). */}
          {focusHeader?.onTitleChange
            ? <div className="builder-title-field focus-header-title-field">
                <input
                  value={focusHeader.titleValue ?? ''}
                  readOnly={focusHeader.titleReadOnly}
                  maxLength={160}
                  aria-label="Tên template"
                  placeholder="Template chưa đặt tên"
                  onChange={(event) => focusHeader.onTitleChange?.(event.target.value)}
                />
              </div>
            : <b>{focusHeader?.title || 'Mailcraft'}</b>}
          <span className="save-state"><i />{focusHeader?.saveStatusText ?? ''}</span>
          </div>
        </div>
        <div className="focus-header-actions v3-head-actions">
          {/* `v3-history`: undo/redo, which the builder engine has supported
              since S2 without anything on screen able to call it. */}
          <span className="v3-history">
            <button className="icon-action" aria-label="Hoàn tác" title="Hoàn tác" disabled={!focusHeader || focusHeader.undoDisabled} onClick={() => focusHeader?.onUndo()}>↶</button>
            <button className="icon-action" aria-label="Làm lại" title="Làm lại" disabled={!focusHeader || focusHeader.redoDisabled} onClick={() => focusHeader?.onRedo()}>↷</button>
          </span>
          {/* ADR-044 Task SV-6: `focus-header-preview` is a hook for one CSS
              addition, not styling of its own. The copied `studio.css` hides
              every header action below 720px -- correct for a desktop-only
              prototype, wrong here, because EOW's narrow-viewport notice tells
              the reader to use this very button. See the SV-6 block in
              globals.css. */}
          <button className="secondary-button focus-header-preview" onClick={() => focusHeader?.onPreviewToggle()}>{focusHeader?.previewOpen ? 'Đóng xem trước' : 'Xem trước'}</button>
          {/* S9 Task 52 (MC-UI-010.validate): this used to post the template
              straight away; it now only opens BuilderScreen's pre-publish
              summary sheet (`onPublish` === `openPublishSheet`) -- the actual
              `POST /publish` moved to that sheet's own confirm button
              (`MC-UI-010.publish`). No other screen wires `onPublish`
              (grep confirms), so this data attribute is unambiguous here. */}
          <button className="primary-button" data-mc-action="MC-UI-010.validate" disabled={!focusHeader || focusHeader.publishDisabled} onClick={() => focusHeader?.onPublish()}>{focusHeader?.publishBusy ? 'Đang xử lý…' : 'Xuất bản'}</button>
          {/* `v3-avatar`: focus mode hides the utility bar (ADR-041), which is
              where the account menu lives, so signing out meant leaving the
              editor first. The prototype puts an avatar in this corner; this is
              that avatar opening the menu EOW already has, not a second one. */}
          <EntityActionMenu
            label="Mở menu tài khoản"
            triggerClassName="v3-avatar"
            disabled={signingOut}
            trigger={<span>{initials}</span>}
            items={[{ label: 'Đăng xuất', icon: 'lock', tone: 'danger', disabled: signingOut, onSelect: () => void handleSignOut() }]}
          />
        </div>
      </header>}

      <section className={focus ? 'workspace workspace-focus' : 'workspace'}>
        {realtimeStatus !== 'live' && <div className={`connection-banner ${realtimeStatus}`} role="status" aria-live="polite">
          <span aria-hidden="true">{realtimeStatus === 'offline' ? '!' : '↻'}</span>
          <div>
            <b>{realtimeStatus === 'offline' ? 'Bạn đang ngoại tuyến' : 'Đang kết nối lại dữ liệu trực tiếp'}</b>
            <small>{realtimeStatus === 'offline' ? 'Thay đổi chưa gửi lên máy chủ có thể cần thử lại khi có mạng.' : 'Dữ liệu bền vững vẫn được đối soát qua API; các cập nhật mới có thể đến chậm.'}</small>
          </div>
          <button className="secondary-button" onClick={retryRealtime}>Thử kết nối lại</button>
        </div>}
        {!focus && <div className="page-header">
          <div>
            <h1>{meta.title}</h1>
            <p>{meta.description}</p>
          </div>
          {/* The compose screen owns its own send actions ("Hẹn giờ" and
              "Xem lại & xác nhận gửi") at the foot of the form. A second
              action row here held a permanently disabled "Gửi ngay" styled as
              the page's primary button, so the most prominent control on the
              screen did nothing while the real one sat below the fold -- and
              its tooltip leaked roadmap wording into the product. "Gửi ngay"
              is not a missing feature either: sending already exists, and a
              one-click path around the confirmation step would bypass the
              recipient counts and the real-recipient preview that step exists
              to show. */}
        </div>}
        <div className={focus ? 'content-stage content-stage-focus' : 'content-stage'}>
          <Outlet context={setSaveState} />
        </div>
        {!focus && <footer className="app-footer">
          <nav aria-label="Điều hướng chân trang">
            <a>Hướng dẫn</a>
            <a>Bảo mật</a>
            <a>Điều khoản</a>
          </nav>
        </footer>}
      </section>
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <span>✓</span>
          {toast}
        </div>
      )}
      {notificationsOpen && <NotificationPopover onClose={() => setNotificationsOpen(false)} onUnreadChange={setUnreadNotifications} />}
    </main>
    </FocusHeaderContext.Provider>
  );
}
