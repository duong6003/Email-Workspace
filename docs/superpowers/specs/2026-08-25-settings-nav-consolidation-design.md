# Settings Navigation Consolidation — Design

## Context

The `HỆ THỐNG` sidebar group grew from 2 nav items to 4 over the last two sessions (`Cấu hình email`, `Dữ liệu người nhận`, `Biến dùng chung`, `Lịch sử gửi`) as configured-variable ownership was split across surfaces (ADR-032, ADR-033). The user asked for the configuration-flavoured items to stop dominating the sidebar and to only surface when actually needed.

Three approaches were compared with the user via mockups (accordion group, header gear-icon popover, single "Cấu hình" entry with internal tabs). The user chose the tab-based consolidation.

## Decision

Collapse the three configuration destinations — `Cấu hình email`, `Dữ liệu người nhận`, `Biến dùng chung` — into one sidebar entry, **"Cấu hình"**, which opens a shared 4-tab strip. `Lịch sử gửi` stays a separate top-level item; it is operational (viewing send history), not configuration.

### Sidebar

```
HỆ THỐNG
  Cấu hình         (was "Cấu hình email")
  Lịch sử gửi      (unchanged)
```

`Cấu hình` links to `/settings/senders` (today's default) and must render as the active nav item on all four of its sub-routes, not just `/settings/senders`. `NavLink`'s built-in `isActive` only matches a path and its children, so siblings need explicit handling: add `activePaths?: string[]` to `NavItem` in `nav.ts`, and in `AppShell.tsx` compute the active class as `location.pathname === item.path || item.activePaths?.includes(location.pathname)` instead of relying solely on `NavLink`'s render-prop `isActive`.

### Shared tab strip

`SenderSettingsScreen.tsx` already renders a two-tab strip (`Cấu hình gửi` / `Chính sách gửi mặc định`) using the existing `.settings-tabs.workspace-tabs` CSS classes — this is the pattern to extend, not a new one to invent. Extract it into `apps/web/src/components/SettingsTabs.tsx`:

```tsx
export type SettingsTabKey = 'senders' | 'policy' | 'custom-fields' | 'global-variables';

const TABS: Array<{ key: SettingsTabKey; label: string; path: string }> = [
  { key: 'senders', label: 'Cấu hình gửi', path: '/settings/senders' },
  { key: 'policy', label: 'Chính sách gửi mặc định', path: '/settings/policy' },
  { key: 'custom-fields', label: 'Dữ liệu người nhận', path: '/settings/custom-fields' },
  { key: 'global-variables', label: 'Biến dùng chung', path: '/settings/global-variables' },
];

export function SettingsTabs({ active }: { active: SettingsTabKey }) { /* renders the 4 tabs */ }
```

Each tab is a react-router `<Link>` (its `active` state is passed in explicitly by the caller, so no `NavLink`-style path matching is needed inside the component itself), not the current raw `<a href>`. The existing markup does full-page navigation between `/settings/senders` and `/settings/policy` today — a pre-existing inefficiency directly inside the code this work already touches, so it gets fixed as part of this change (not scope creep: it's the same three lines being rewritten).

All four screens render `<SettingsTabs active="…">` inside the existing `.settings-topbar.workspace-module-topbar` header pattern:
- `SenderSettingsScreen.tsx` — replace its inline 2-tab markup (both `policyOnly` and default branches) with `<SettingsTabs active="senders">` / `<SettingsTabs active="policy">`.
- `CustomFieldsScreen.tsx` — replace the current `<header className="module-frame-toolbar standard-filter-bar">` (with its own `<h2>Dữ liệu người nhận</h2>`) with a `.settings-topbar.workspace-module-topbar` header containing `<SettingsTabs active="custom-fields">` plus the existing "Tạo trường người nhận" primary button. The `<h2>` is dropped — the highlighted tab now carries that context, mirroring how `SenderSettingsScreen` already has no local `<h2>`. The existing `info-banner` explanatory line stays.
- `GlobalVariablesScreen.tsx` — same treatment: `<SettingsTabs active="global-variables">`, drop its `<h2>Biến dùng chung</h2>`, keep its `info-banner` and "Tạo biến dùng chung" button.

### Unified page title

`pageMeta['/settings/senders']` and `pageMeta['/settings/policy']` already share one title today (`Cấu hình email` / same description) — the tab strip is what currently distinguishes them, not the page header. Extend that same convention to all four paths:

```ts
'/settings/senders': { title: 'Cấu hình', description: 'Quản lý cấu hình gửi, dữ liệu người nhận và biến dùng chung.' },
'/settings/policy': { title: 'Cấu hình', description: 'Quản lý cấu hình gửi, dữ liệu người nhận và biến dùng chung.' },
'/settings/custom-fields': { title: 'Cấu hình', description: 'Quản lý cấu hình gửi, dữ liệu người nhận và biến dùng chung.' },
'/settings/global-variables': { title: 'Cấu hình', description: 'Quản lý cấu hình gửi, dữ liệu người nhận và biến dùng chung.' },
```

## Explicitly unchanged

- All four URLs (`/settings/senders`, `/settings/policy`, `/settings/custom-fields`, `/settings/global-variables`) — no redirects, no route nesting change.
- All API calls, business logic, and state inside each screen.
- `settings:manage` permission requirement — identical across all four routes already, so consolidating the nav entry changes nothing about who can see what; `RequirePermission` still independently guards each route.
- `Lịch sử gửi` stays where it is.

## Known pre-existing test debt (discovered, not introduced)

`apps/web/e2e/custom-fields.spec.ts` asserts `.page-header h1` equals `'Trường tùy chỉnh'` against `/settings/custom-fields` — already stale (the current title is `'Dữ liệu người nhận'`, set in a prior session; this spec was not caught by `pnpm check`, since Playwright e2e specs run only via the separate `pnpm --filter @eow/web e2e` command against a live dev server + seeded `demo@acme.vn` account that doesn't exist in the current local database). This design's title change makes the same assertion expect `'Cấu hình'` instead. Since the plan is already touching this exact line's surface, the assertion gets corrected as part of this work — verified by reading, not by running Playwright (no `demo@acme.vn` seed is available locally, and provisioning one is out of scope for a nav-only change).

## Housekeeping

Two stale comments reference decisions this design supersedes and should be updated to avoid misleading future readers:
- `nav.ts`: the `custom-fields` item's comment citing "no handoff screen owns this destination... DEC-034" — still true of the underlying screen, but the nav entry itself is being restructured.
- `CustomFieldsScreen.tsx`'s doc comment block making the same DEC-034 argument for why the screen exists as a standalone destination — the screen still exists, only its nav entry and header change.

## Out of scope

- Consolidating `.settings-tabs` and `.workspace-tabs` CSS (near-duplicate rules) — pre-existing, unrelated to this change.
- Any change to `globals.css` lines protected by `ARCH-HANDOFF` (packages/architecture-tests/src/handoff-fidelity.test.ts) — only additive CSS, if any is needed at all (the tab strip reuses existing classes; no new CSS is currently expected).
- Deduplicating `SenderSettingsScreen`'s two render branches (`policyOnly` true/false) — unrelated to nav/tab consolidation.
