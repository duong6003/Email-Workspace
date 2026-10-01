> **Status: shipped. The checkboxes below were never ticked.**
>
> Verified 2026-08-26: `apps/web/src/components/SettingsTabs.tsx` exists and is
> used by `SenderSettingsScreen`, `CustomFieldsScreen` and
> `GlobalVariablesScreen`; `apps/web/src/app/nav-active.ts` exists with its
> test; and `nav.ts` carries a single `Cấu hình` entry whose `activePaths`
> lists the three sibling settings routes. The plan file was simply never
> committed while the work was being done. Kept as the record of why the
> consolidation was built the way it was — do not re-execute it.

# Settings Navigation Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the sidebar's three configuration destinations (`Cấu hình email`, `Dữ liệu người nhận`, `Biến dùng chung`) into one `Cấu hình` entry backed by a shared 4-tab strip, per `docs/superpowers/specs/2026-08-25-settings-nav-consolidation-design.md`.

**Architecture:** `SenderSettingsScreen.tsx` already renders a 2-tab strip for senders/policy using the `.settings-tabs.workspace-tabs` CSS classes — that markup is extracted into a new shared `apps/web/src/components/SettingsTabs.tsx` and reused by all four settings screens. The sidebar's active-item matching moves from `NavLink`'s built-in (path-prefix-only) `isActive` to an explicit, unit-tested `isNavItemActive` helper, because the consolidated nav item must light up for four sibling routes, not just its own path. No route, permission, or API surface changes.

**Tech Stack:** React + react-router-dom (web), Vitest for pure-logic tests (this codebase has no React component-testing library — component wiring is verified by typecheck, the `ARCH-NO-ORPHANS` architecture test, and a manual browser pass, matching how every prior `.tsx` change in this repo was verified).

---

## Investigation notes (read before starting — these correct or add to the spec)

1. **A real, verifiable bug exists in the code being touched.** Every `.settings-tabs`/`.workspace-tabs` CSS rule in `apps/web/src/app/globals.css` targets the `button` element specifically (`.settings-tabs button{...}`) — there is no rule for `a`. The current inactive tab, `<a href="/settings/policy">Chính sách gửi mặc định</a>`, therefore renders as a bare unstyled browser link inside a container styled for pill buttons. The spec proposed fixing this with `<Link>`; that would keep the bug (a `<Link>` renders an `<a>` tag, same selector mismatch). **This plan uses `<button onClick={() => navigate(tab.path)}>` instead** — it matches the CSS selectors, and matches how every other tab/pill-style control in this codebase already works (`DraftsScreen`'s `pill-filter`, `TemplatesScreen`'s status filter, etc. are all `<button onClick>`, never `<a>`/`<Link>`).
2. **The spec's "Housekeeping" bullet about `CustomFieldsScreen.tsx`'s doc comment is stale.** That comment was already removed in a prior session (verified 2026-08-25: `grep -n "DEC-034" apps/web/src/screens/settings/CustomFieldsScreen.tsx` returns nothing). Only `nav.ts` still carries a DEC-034/ADR-033 comment, and it is attached to the exact `custom-fields`/`global-variables` array entries this plan deletes — no separate edit needed, the comment goes with the deleted lines.
3. **The existing "Cấu hình gửi" tab shows a live count badge** (`<span>{items?.length ?? 0}</span>`, styled as a pill via `.settings-tabs button span`). The shared component preserves this via an optional `counts` prop rather than dropping it — the other three tabs simply don't pass one.

## File structure

**Create:**
- `apps/web/src/app/nav-active.ts` — pure `isNavItemActive` helper.
- `apps/web/src/app/nav-active.test.ts` — its test.
- `apps/web/src/components/SettingsTabs.tsx` — shared 4-tab strip.

**Modify:**
- `apps/web/src/app/nav.ts` — add `activePaths?: string[]` to `NavItem`; collapse the `HỆ THỐNG` group to `Cấu hình` + `Lịch sử gửi`; unify `pageMeta` titles for all four settings paths.
- `apps/web/src/app/AppShell.tsx` — use `isNavItemActive` instead of `NavLink`'s built-in matching.
- `apps/web/src/screens/settings/SenderSettingsScreen.tsx:191,194` — replace both inline tab-strip headers with `<SettingsTabs>`.
- `apps/web/src/screens/settings/CustomFieldsScreen.tsx:59` — replace the `module-frame-toolbar` header with a `settings-topbar` header containing `<SettingsTabs>`.
- `apps/web/src/screens/settings/GlobalVariablesScreen.tsx:42` — same treatment.
- `apps/web/e2e/custom-fields.spec.ts:26` — fix the already-stale `.page-header h1` assertion text (see Investigation notes; this is pre-existing drift, corrected because the plan changes the exact line it depends on).

⚠️ `packages/architecture-tests/src/structure.test.ts` (`ARCH-NO-ORPHANS`) requires every production web module to be reachable from `apps/web/src/main.tsx`. `SettingsTabs.tsx` and `nav-active.ts` are reachable because the screens/AppShell that import them already are — no extra wiring needed, but re-run that test after Task 4 to confirm.

---

### Task 1: `isNavItemActive` — pure helper + test

**Files:**
- Create: `apps/web/src/app/nav-active.ts`
- Test: `apps/web/src/app/nav-active.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/app/nav-active.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isNavItemActive } from './nav-active.js';

describe('sidebar nav active matching', () => {
  it('matches the item\'s own path', () => {
    expect(isNavItemActive({ path: '/settings/senders' }, '/settings/senders')).toBe(true);
  });

  it('matches a listed sibling path', () => {
    expect(isNavItemActive(
      { path: '/settings/senders', activePaths: ['/settings/policy', '/settings/custom-fields', '/settings/global-variables'] },
      '/settings/custom-fields',
    )).toBe(true);
  });

  it('does not match an unrelated path', () => {
    expect(isNavItemActive(
      { path: '/settings/senders', activePaths: ['/settings/policy'] },
      '/history',
    )).toBe(false);
  });

  it('does not match a sibling path when activePaths is absent', () => {
    expect(isNavItemActive({ path: '/settings/senders' }, '/settings/policy')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && npx vitest run src/app/nav-active.test.ts
```

Expected: FAIL — `Cannot find module './nav-active.js'`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/app/nav-active.ts`:

```ts
/**
 * A consolidated nav entry (e.g. "Cấu hình") must light up on every one of
 * its sibling routes, not just its own `to` path. react-router's NavLink
 * only matches a path and its descendants, so the shell computes this
 * itself instead of relying on NavLink's isActive.
 */
export function isNavItemActive(item: { path: string; activePaths?: string[] }, pathname: string): boolean {
  return pathname === item.path || (item.activePaths?.includes(pathname) ?? false);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && npx vitest run src/app/nav-active.test.ts
```

Expected: `Tests 4 passed (4)`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/nav-active.ts apps/web/src/app/nav-active.test.ts
git commit -m "feat(web): add isNavItemActive helper for multi-route sidebar entries"
```

---

### Task 2: Collapse the sidebar entries and unify page titles

**Files:**
- Modify: `apps/web/src/app/nav.ts`

- [ ] **Step 1: Add `activePaths` to the `NavItem` type**

In `apps/web/src/app/nav.ts`, extend the type:

```ts
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
```

- [ ] **Step 2: Collapse the HỆ THỐNG group**

Replace the `HỆ THỐNG` group's `items` array:

```ts
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
      { id: 'history', label: 'Lịch sử gửi', icon: 'history', path: '/history', requiredPermission: 'campaign:read' },
    ],
  },
```

This deletes the `custom-fields` and `global-variables` entries (and their DEC-034/ADR-033 comments) along with the array elements they were attached to — see Investigation note 2.

- [ ] **Step 3: Unify the four settings page titles**

In `pageMeta`, replace the four `/settings/*` entries:

```ts
  '/settings/senders': { title: 'Cấu hình', description: 'Quản lý cấu hình gửi, dữ liệu người nhận và biến dùng chung.' },
  '/settings/policy': { title: 'Cấu hình', description: 'Quản lý cấu hình gửi, dữ liệu người nhận và biến dùng chung.' },
  '/settings/custom-fields': { title: 'Cấu hình', description: 'Quản lý cấu hình gửi, dữ liệu người nhận và biến dùng chung.' },
  '/settings/global-variables': { title: 'Cấu hình', description: 'Quản lý cấu hình gửi, dữ liệu người nhận và biến dùng chung.' },
```

`routePermissions` is untouched — it already lists all four paths independently and still gates direct-URL access regardless of nav grouping.

- [ ] **Step 4: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: fails at this point — `AppShell.tsx` still destructures `isActive` from `NavLink`'s render prop and nothing references `activePaths` yet. That's expected; Task 3 fixes it. Confirm the *only* errors are in `AppShell.tsx` (none in `nav.ts` itself), then continue.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/nav.ts
git commit -m "feat(web): collapse the sidebar's config destinations into one Cấu hình entry"
```

(A red typecheck between commits is fine here — the next task is a direct continuation and both land before any shared verification gate.)

---

### Task 3: Wire the active-matching helper into `AppShell.tsx`

**Files:**
- Modify: `apps/web/src/app/AppShell.tsx`

- [ ] **Step 1: Import the helper**

```tsx
import { isNavItemActive } from './nav-active.js';
```

- [ ] **Step 2: Replace the NavLink rendering**

Replace this block:

```tsx
              {group.items.map((item) => (
                <NavLink
                  key={item.id}
                  to={item.path}
                  className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
                  title={collapsed ? item.label : undefined}
                >
                  {({ isActive }) => (
                    <>
                      <i>
                        <NavIcon name={item.icon} />
                      </i>
                      <span>{item.label}</span>
                      {isActive && <em />}
                    </>
                  )}
                </NavLink>
              ))}
```

with:

```tsx
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
```

`location` is already in scope (`const location = useLocation();` earlier in the component).

- [ ] **Step 3: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: clean (this resolves the red state from Task 2 Step 4).

- [ ] **Step 4: Run the full web test suite**

```bash
cd apps/web && npx vitest run
```

Expected: all files pass, 0 skipped.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/AppShell.tsx
git commit -m "fix(web): highlight the Cấu hình nav item on all four of its sub-routes"
```

---

### Task 4: `SettingsTabs` shared component

**Files:**
- Create: `apps/web/src/components/SettingsTabs.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/SettingsTabs.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';

export type SettingsTabKey = 'senders' | 'policy' | 'custom-fields' | 'global-variables';

const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTabKey; label: string; path: string }> = [
  { key: 'senders', label: 'Cấu hình gửi', path: '/settings/senders' },
  { key: 'policy', label: 'Chính sách gửi mặc định', path: '/settings/policy' },
  { key: 'custom-fields', label: 'Dữ liệu người nhận', path: '/settings/custom-fields' },
  { key: 'global-variables', label: 'Biến dùng chung', path: '/settings/global-variables' },
];

/**
 * Shared tab strip for the consolidated "Cấu hình" nav entry (see
 * docs/superpowers/specs/2026-08-25-settings-nav-consolidation-design.md).
 * Every non-active tab is a <button onClick={navigate}> rather than a real
 * link: .settings-tabs/.workspace-tabs CSS in globals.css only styles
 * `button` children, matching how every other tab/pill control in this
 * codebase already works.
 */
export function SettingsTabs({ active, counts }: { active: SettingsTabKey; counts?: Partial<Record<SettingsTabKey, number>> }) {
  const navigate = useNavigate();
  return <div className="settings-tabs workspace-tabs">
    {SETTINGS_TABS.map((tab) => {
      const count = counts?.[tab.key];
      const label = <>{tab.label}{count !== undefined && <span>{count}</span>}</>;
      return tab.key === active
        ? <button key={tab.key} className="active">{label}</button>
        : <button key={tab.key} onClick={() => navigate(tab.path)}>{label}</button>;
    })}
  </div>;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: clean (the component isn't used anywhere yet, but it must still type-check standalone).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/SettingsTabs.tsx
git commit -m "feat(web): add shared SettingsTabs component"
```

---

### Task 5: Wire `SettingsTabs` into `SenderSettingsScreen.tsx`

**Files:**
- Modify: `apps/web/src/screens/settings/SenderSettingsScreen.tsx:191,194`

- [ ] **Step 1: Import the component**

Add to the top of `apps/web/src/screens/settings/SenderSettingsScreen.tsx`:

```tsx
import { SettingsTabs } from '../../components/SettingsTabs.js';
```

- [ ] **Step 2: Replace the `policyOnly` branch's header (line 191)**

Find:

```tsx
<header className="settings-topbar workspace-module-topbar"><div className="settings-tabs workspace-tabs"><a href="/settings/senders">Cấu hình gửi</a><button className="active">Chính sách gửi mặc định</button></div></header>
```

Replace with:

```tsx
<header className="settings-topbar workspace-module-topbar"><SettingsTabs active="policy" /></header>
```

- [ ] **Step 3: Replace the default branch's header (line 194)**

Find:

```tsx
<header className="settings-topbar workspace-module-topbar"><div className="settings-tabs workspace-tabs"><button className="active">Cấu hình gửi <span>{items?.length ?? 0}</span></button><a href="/settings/policy">Chính sách gửi mặc định</a></div><button className="primary-button" onClick={() => setCreateOpen(true)}>＋ Thêm cấu hình</button></header>
```

Replace with:

```tsx
<header className="settings-topbar workspace-module-topbar"><SettingsTabs active="senders" counts={{ senders: items?.length ?? 0 }} /><button className="primary-button" onClick={() => setCreateOpen(true)}>＋ Thêm cấu hình</button></header>
```

- [ ] **Step 4: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/settings/SenderSettingsScreen.tsx
git commit -m "refactor(web): use the shared SettingsTabs strip in SenderSettingsScreen"
```

---

### Task 6: Wire `SettingsTabs` into `CustomFieldsScreen.tsx`

**Files:**
- Modify: `apps/web/src/screens/settings/CustomFieldsScreen.tsx:59`

- [ ] **Step 1: Import the component**

```tsx
import { SettingsTabs } from '../../components/SettingsTabs.js';
```

- [ ] **Step 2: Replace the header**

Find (the full header block starting at line 59):

```tsx
    <header className="module-frame-toolbar standard-filter-bar">
      <div><h2 style={{ margin: 0 }}>Dữ liệu người nhận</h2><small>Các trường này thuộc từng người nhận và có thể dùng trong mọi template.</small></div>
      <button className="primary-button" onClick={() => setOverlay('create')}><UiIcon name="plus" size={16} /> Tạo trường người nhận</button>
    </header>
```

Replace with:

```tsx
    <header className="settings-topbar workspace-module-topbar">
      <SettingsTabs active="custom-fields" />
      <button className="primary-button" onClick={() => setOverlay('create')}><UiIcon name="plus" size={16} /> Tạo trường người nhận</button>
    </header>
```

The `<h2>`/`<small>` pair is dropped — the highlighted "Dữ liệu người nhận" tab now carries that context, matching how `SenderSettingsScreen` has no local `<h2>` either. The `info-banner` line lower in the screen (unaffected by this edit) keeps the explanatory copy.

- [ ] **Step 3: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/screens/settings/CustomFieldsScreen.tsx
git commit -m "refactor(web): use the shared SettingsTabs strip in CustomFieldsScreen"
```

---

### Task 7: Wire `SettingsTabs` into `GlobalVariablesScreen.tsx`

**Files:**
- Modify: `apps/web/src/screens/settings/GlobalVariablesScreen.tsx:42`

- [ ] **Step 1: Import the component**

```tsx
import { SettingsTabs } from '../../components/SettingsTabs.js';
```

- [ ] **Step 2: Replace the header**

Find (the full header block starting at line 42):

```tsx
    <header className="module-frame-toolbar standard-filter-bar">
      <div><h2 style={{ margin: 0 }}>Biến dùng chung</h2><small>Giá trị áp dụng cho toàn hệ thống và có thể chèn vào mọi template.</small></div>
      <button className="primary-button" onClick={() => setOverlay('create')}><UiIcon name="plus" size={16} /> Tạo biến dùng chung</button>
    </header>
```

Replace with:

```tsx
    <header className="settings-topbar workspace-module-topbar">
      <SettingsTabs active="global-variables" />
      <button className="primary-button" onClick={() => setOverlay('create')}><UiIcon name="plus" size={16} /> Tạo biến dùng chung</button>
    </header>
```

- [ ] **Step 3: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/screens/settings/GlobalVariablesScreen.tsx
git commit -m "refactor(web): use the shared SettingsTabs strip in GlobalVariablesScreen"
```

---

### Task 8: Fix the stale e2e title assertion

**Files:**
- Modify: `apps/web/e2e/custom-fields.spec.ts:26`

- [ ] **Step 1: Update the assertion**

In `apps/web/e2e/custom-fields.spec.ts`, find:

```ts
    await expect(page.locator('.page-header h1')).toHaveText('Trường tùy chỉnh');
```

Replace with:

```ts
    await expect(page.locator('.page-header h1')).toHaveText('Cấu hình');
```

This assertion was already stale before this plan (the title had already changed to `'Dữ liệu người nhận'` in a prior session — see Investigation note 1's sibling context in the design doc). This plan does not attempt a full Playwright run: doing so needs a `demo@acme.vn` / `Demo!Passw0rd` account this local database doesn't have, and provisioning one is out of scope for a nav/title change. Verify by reading, not by running.

- [ ] **Step 2: Confirm no other e2e spec references the old titles or the removed nav items**

```bash
grep -rn "Cấu hình email\|Trường tùy chỉnh\|Dữ liệu người nhận\|Biến dùng chung" apps/web/e2e
```

Expected: no output (only the line just fixed referenced any of these, and it's now `'Cấu hình'`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/custom-fields.spec.ts
git commit -m "test(e2e): fix the custom-fields page-title assertion for the Cấu hình consolidation"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run the complete gate**

```bash
pnpm check
```

Expected: typecheck, build and tests all pass. Baseline before this plan was **1284 passed / 0 skipped / 215 files**; this plan adds 4 tests (Task 1) and touches no other test counts, so expect **1288 passed / 0 skipped**. Report the real number.

- [ ] **Step 2: Confirm the architecture tests still pass**

```bash
cd packages/architecture-tests && npx vitest run src/structure.test.ts
```

Expected: `ARCH-NO-ORPHANS` and the other 4 structure tests pass — `SettingsTabs.tsx` and `nav-active.ts` are reachable via the screens/`AppShell` that import them.

- [ ] **Step 3: Rebuild the local Docker stack**

```bash
docker compose --env-file .env up -d --build --wait
```

Expected: all services healthy; migrate container exits 0 with no new migration (this plan touches no schema).

- [ ] **Step 4: Manually verify in the running app**

Using the seeded local account (`admin@example.test` / `Admin@123`, recorded in memory `local-dev-admin-seed.md`):

1. Log in. In the sidebar's `HỆ THỐNG` group, confirm exactly two items: `Cấu hình` and `Lịch sử gửi`.
2. Click `Cấu hình` → lands on `/settings/senders`, sidebar item is highlighted active, tab strip shows 4 tabs with `Cấu hình gửi` active and its count badge showing the real sender count.
3. Click the `Chính sách gửi mặc định` tab → URL changes to `/settings/policy` **without a full page reload** (check `read_network_requests` shows no fresh HTML document request, or watch that React state elsewhere in the shell — e.g. sidebar collapsed state — survives the switch); sidebar `Cấu hình` item stays highlighted active; tab strip shows `Chính sách gửi mặc định` as the active pill-styled button (not a bare blue link — this is the bug fix from Investigation note 1).
4. Click the `Dữ liệu người nhận` tab → lands on `/settings/custom-fields`, tab strip highlights correctly, existing custom-fields table still renders, `Tạo trường người nhận` button still works.
5. Click the `Biến dùng chung` tab → lands on `/settings/global-variables`, tab strip highlights correctly, the variable created in the prior session (`company_name` / "Alta Software") is still listed.
6. Confirm the page header (`h1`) reads `Cấu hình` on all four tabs.
7. Confirm `Lịch sử gửi` is unaffected — still a direct top-level link, unrelated to the tab strip.

- [ ] **Step 5: Check runtime logs**

```bash
docker compose logs api web --since 5m | grep -iE "error|fatal|unhandled" | grep -v "ESOCKET|test_send"
```

Expected: no output.

- [ ] **Step 6: Report**

State the final test count, whether every item in Step 4's manual checklist passed, and confirm the tab-click-triggers-full-reload bug is gone (Step 4.3). If any expectation was not met, say which and stop rather than closing the task.

---

## Self-review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| Sidebar: `HỆ THỐNG` → `Cấu hình` + `Lịch sử gửi` | 2 |
| `Cấu hình` nav item active on all 4 sub-routes | 1, 3 |
| Shared 4-tab `SettingsTabs` component, reused by all 4 screens | 4, 5, 6, 7 |
| Tab switching is client-side, not full-page `<a href>` reload | 4 (also fixes the unstyled-link bug found during investigation) |
| Unified page title/description across the 4 settings routes | 2 |
| Preserve the sender-count badge | 4, 5 |
| URLs, permissions, business logic unchanged | Verified in Task 9 Step 4; no task touches `AppRoutes.tsx`, DTOs, or API code |
| Stale comments removed | Task 2 (deleted with the array entries); `CustomFieldsScreen.tsx` comment already gone (Investigation note 2) |
| Pre-existing e2e test debt | Task 8 |

**Type consistency:** `SettingsTabKey` is defined once in `SettingsTabs.tsx` and used identically as the `active` prop value in Tasks 5–7 (`"senders"`, `"policy"`, `"custom-fields"`, `"global-variables"` match the screens' own route names). `isNavItemActive(item, pathname)` argument order matches its single call site in `AppShell.tsx`. `activePaths` is defined on `NavItem` in Task 2 and consumed by `isNavItemActive` (Task 1) via a structurally-compatible subset type (`{ path: string; activePaths?: string[] }`), so passing a full `NavItem` satisfies it without a cast.

**Known limits, stated rather than hidden:**
- No automated test proves the "no full-page reload on tab click" fix — this codebase has no component-testing library, so it's a manual browser check (Task 9 Step 4.3), consistent with how every other `.tsx`-only change in this repo has been verified.
- Task 8 corrects one assertion by reading, not by running Playwright — running the full e2e suite would require seeding a second demo account, which is out of scope for a navigation/title change.
