import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackFixture } from './fixture-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Visual evidence capture for M1-S1 per design-reference/visual-acceptance.md:
 * handoff baseline + production render at 1440x900 / 768x1024 / 390x844 for
 * /login and the authenticated shell. Stored under the run's evidence/visual/
 * directory (never under design-reference/), per §12.
 *
 * The 768px viewport is *above* the handoff's 760px breakpoint, so it
 * renders the desktop grid — that is the expected baseline, not a bug (A-10).
 */
const EVIDENCE_ROOT = resolve(
  __dirname,
  '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M1-S1-signin',
);

// M1-S2 (Roles and access): the permission_denied state does not exist in
// the handoff (design-reference/ui-source-contract.yaml required_states
// gap, confirmed by ui_intake), so there is no handoff-baseline to compare
// against for this one -- only a production render, per screen-catalog.yaml
// diff_notes.
const M1_S2_EVIDENCE_ROOT = resolve(
  __dirname,
  '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M1-S2-rbac',
);

const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
];

const HANDOFF_BASE_URL = process.env.HANDOFF_BASE_URL ?? 'http://localhost:4173';
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';
const VIEWER_EMAIL = 'demo-viewer@acme.vn';

test.describe('Visual evidence: production', () => {
  for (const viewport of VIEWPORTS) {
    test(`login screen — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.waitForSelector('.login-card');
      mkdirSync(resolve(EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(EVIDENCE_ROOT, 'production', `login-${viewport.name}.png`), fullPage: true });
    });

    test(`shell (compose) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
      await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
      await page.locator('button.login-submit').click();
      await page.waitForURL(/\/campaigns$/);
      await page.waitForSelector('.app-shell');
      mkdirSync(resolve(EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(EVIDENCE_ROOT, 'production', `shell-${viewport.name}.png`), fullPage: true });
    });
  }
});

test.describe('Visual evidence: M1-S2 permission_denied (production only, no handoff baseline exists for this state)', () => {
  for (const viewport of VIEWPORTS) {
    test(`permission_denied — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByPlaceholder('name@mailspace.vn').fill(VIEWER_EMAIL);
      await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
      await page.locator('button.login-submit').click();
      await page.waitForURL(/\/campaigns$/);
      await page.goto('/settings/senders');
      await page.waitForSelector('.permission-denied-card');
      mkdirSync(resolve(M1_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M1_S2_EVIDENCE_ROOT, 'production', `permission-denied-${viewport.name}.png`), fullPage: true });
    });
  }
});

// M1-GATE: UI-SHELL-001's `error` state was implemented by M1-S3
// (SystemErrorScreen.tsx, apps/web/e2e/errors.spec.ts) but no visual
// evidence was ever captured for it -- screen-catalog.yaml still said
// `deferred_to_M1-S3` after M1-S3 completed. Closing that gap here, in the
// same production-only pattern as M1-S2's permission_denied block (no
// handoff baseline exists for this state either).
const M1_GATE_EVIDENCE_ROOT = resolve(
  __dirname,
  '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M1-GATE',
);

test.describe('Visual evidence: M1-S3 system-error (production only, no handoff baseline exists for this state)', () => {
  for (const viewport of VIEWPORTS) {
    test(`system-error — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
      await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
      await page.locator('button.login-submit').click();
      await page.waitForURL(/\/campaigns$/);
      await page.waitForSelector('.sidebar');
      await page.route('**/api/v1/auth/me', (route) =>
        route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Internal Server Error', status: 500 }) }),
      );
      await page.reload();
      await page.waitForSelector('.permission-denied-card');
      mkdirSync(resolve(M1_GATE_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M1_GATE_EVIDENCE_ROOT, 'production', `system-error-${viewport.name}.png`), fullPage: true });
    });
  }
});

// M2-S1 (Recipient directory): production-only, no handoff baseline exists
// for the loading/empty/error states (absent from the handoff per
// ui_intake's required-state gap finding, same pattern as M1-S2/M1-S3's
// blocks above). Success state IS present in the handoff's Recipients "all"
// view, but the handoff's own login form doesn't survive a real client-side
// submit in its dev runtime (see the handoff-baseline note at the bottom of
// this file), so no handoff-baseline shell/recipients screenshot exists
// either -- DOM/class-name equivalence is by construction (ported verbatim,
// see state.json evidence), matching M1-S1's shell precedent.
const M2_S1_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M2-S1-recipients');

test.describe('Visual evidence: M2-S1 recipients (production only, no handoff baseline exists for any of these states)', () => {
  for (const viewport of VIEWPORTS) {
    test(`recipients — success (with data) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
      await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
      await page.locator('button.login-submit').click();
      await page.waitForURL(/\/campaigns$/);
      const seeded = await page.request.post('/api/v1/recipients', {
        data: { email: `visual-${viewport.name}-${Date.now()}@acme.vn`, firstName: 'Minh An', lastName: 'Nguyễn', department: 'Marketing' },
      });
      trackFixture('recipients', ((await seeded.json()) as { id?: string }).id);
      await page.goto('/recipients');
      await page.waitForSelector('.recipients-module table tbody tr');
      mkdirSync(resolve(M2_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S1_EVIDENCE_ROOT, 'production', `recipients-success-${viewport.name}.png`), fullPage: true });
    });

    test(`recipients — success (empty) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
      await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
      await page.locator('button.login-submit').click();
      await page.waitForURL(/\/campaigns$/);
      await page.goto('/recipients');
      // A search token nothing can match, on top of the status filter. Filtering
      // by status alone used to be the whole trick -- "no recipient is `bounced`
      // in a fresh seed" -- but the demo tenant is shared and the M5-S4 webhook
      // fixture genuinely bounces recipients, so by 2026-08-26 six of them were
      // real rows and this capture stopped being empty. The real API still
      // returns a real zero-row page here; only the query is deterministic now.
      await page.getByPlaceholder('Tìm theo tên, email, phòng ban').fill(`no-such-recipient-${Date.now()}`);
      await page.locator('.filter-button').click();
      await page.locator('.action-overlay').getByText('Không gửi được').click();
      await page.locator('.action-overlay .primary-button', { hasText: 'Áp dụng bộ lọc' }).click();
      await page.waitForSelector('.recipients-module .module-card');
      mkdirSync(resolve(M2_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S1_EVIDENCE_ROOT, 'production', `recipients-empty-${viewport.name}.png`), fullPage: true });
    });

    test(`recipients — error — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
      await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
      await page.locator('button.login-submit').click();
      await page.waitForURL(/\/campaigns$/);
      await page.route('**/api/v1/recipients*', (route) =>
        route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Internal Server Error', status: 500 }) }),
      );
      await page.goto('/recipients');
      await page.waitForSelector('.recipients-module .permission-denied-card');
      mkdirSync(resolve(M2_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S1_EVIDENCE_ROOT, 'production', `recipients-error-${viewport.name}.png`), fullPage: true });
    });
  }
});

// M2-S3 (Custom fields): no handoff screen owns this destination (see
// CustomFieldsScreen.tsx's own comment / EXECPLAN DEC-034) -- production
// only, same "no handoff baseline for a state absent from the handoff"
// pattern M1-S2/M2-S1 already established.
const M2_S3_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M2-S3-custom-fields');

// M2-S2 (lists and tags): the handoff's authenticated area cannot be
// automated through its own runtime, so these are production-only captures,
// following the established M2-S1/M2-S3 precedent.
const M2_S2_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M2-S2-lists-tags');

test.describe('Visual evidence: M2-S3 custom fields (production only, no handoff baseline exists)', () => {
  for (const viewport of VIEWPORTS) {
    test(`custom fields admin — success (with data) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
      await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
      await page.locator('button.login-submit').click();
      await page.waitForURL(/\/campaigns$/);
      const seededField = await page.request.post('/api/v1/custom-fields', {
        data: { key: `visual_${viewport.name.replace(/[^a-z0-9]/g, '_')}_${Date.now()}`, label: 'Ngày sinh', type: 'date', required: false },
      });
      trackFixture('custom-fields', ((await seededField.json()) as { id?: string }).id);
      await page.goto('/settings/custom-fields');
      await page.waitForSelector('.custom-fields-module table tbody tr');
      mkdirSync(resolve(M2_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S3_EVIDENCE_ROOT, 'production', `custom-fields-admin-success-${viewport.name}.png`), fullPage: true });
    });

    test(`custom fields admin — empty — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
      await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
      await page.locator('button.login-submit').click();
      await page.waitForURL(/\/campaigns$/);
      await page.route('**/api/v1/custom-fields', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
      await page.goto('/settings/custom-fields');
      await page.waitForSelector('.custom-fields-module .module-card');
      mkdirSync(resolve(M2_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S3_EVIDENCE_ROOT, 'production', `custom-fields-admin-empty-${viewport.name}.png`), fullPage: true });
    });

    test(`recipient add form with custom fields — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
      await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
      await page.locator('button.login-submit').click();
      await page.waitForURL(/\/campaigns$/);
      const seededFormField = await page.request.post('/api/v1/custom-fields', {
        data: { key: `visual_form_${viewport.name.replace(/[^a-z0-9]/g, '_')}_${Date.now()}`, label: 'Sở thích', type: 'text', required: false },
      });
      trackFixture('custom-fields', ((await seededFormField.json()) as { id?: string }).id);
      await page.goto('/recipients');
      await page.locator('.primary-button', { hasText: 'Thêm người nhận' }).click();
      await page.locator('.action-overlay b', { hasText: 'Trường tùy chỉnh' }).waitFor();
      mkdirSync(resolve(M2_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S3_EVIDENCE_ROOT, 'production', `recipient-form-with-custom-fields-${viewport.name}.png`), fullPage: true });
    });
  }
});

test.describe('Visual evidence: M2-S2 lists and tags (production only, no handoff baseline exists)', () => {
  for (const viewport of VIEWPORTS) {
    test(`recipient lists — success — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
      await page.locator('input[type="password"]').fill(DEMO_PASSWORD);
      await page.locator('button.login-submit').click();
      await page.waitForURL(/\/campaigns$/);
      const response = await page.evaluate(async (name) => {
        const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
        return fetch('/api/v1/recipient-lists', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ name, description: 'Visual-evidence list' }),
        }).then(async (result) => ({ status: result.status, body: await result.text() }));
      }, `visual-list-${viewport.name}-${Date.now()}`);
      if (response.status !== 201) throw new Error(`Could not create visual list: ${response.status} ${response.body}`);
      trackFixture('recipient-lists', (JSON.parse(response.body) as { id?: string }).id);
      await page.goto('/recipients');
      await page.locator('[role="tab"]').nth(1).click();
      await page.locator('.recipient-list-grid article').first().waitFor();
      mkdirSync(resolve(M2_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S2_EVIDENCE_ROOT, 'production', `recipient-lists-success-${viewport.name}.png`), fullPage: true });
    });

    test(`recipient tags — success — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
      await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
      await page.locator('input[type="password"]').fill(DEMO_PASSWORD);
      await page.locator('button.login-submit').click();
      await page.waitForURL(/\/campaigns$/);
      const response = await page.evaluate(async (name) => {
        const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
        return fetch('/api/v1/tags', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ name, color: '#278b6e' }),
        }).then(async (result) => ({ status: result.status, body: await result.text() }));
      }, `visual-tag-${viewport.name}-${Date.now()}`);
      if (response.status !== 201) throw new Error(`Could not create visual tag: ${response.status} ${response.body}`);
      trackFixture('tags', (JSON.parse(response.body) as { id?: string }).id);
      await page.goto('/recipients');
      await page.locator('[role="tab"]').nth(2).click();
      await page.locator('.tag-directory-grid article').first().waitFor();
      mkdirSync(resolve(M2_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S2_EVIDENCE_ROOT, 'production', `recipient-tags-success-${viewport.name}.png`), fullPage: true });
    });
  }
});

/**
 * M2-S2's remaining required_states. The block above captured `success` only,
 * which left UI-REC-002/003 short of screen-catalog.yaml's
 * `required_states: [loading, empty, error, success, permission_denied]` and so
 * short of M2-GATE.
 *
 * `loading`, `empty` and `error` are driven through page.route rather than
 * through real data. That is deliberate and matches the M2-S1/M2-S3 precedent:
 * these three states are properties of the *client* render path, and the only
 * way to hold `loading` still long enough to photograph — or to produce a
 * server 500 on demand — is to control the response. The `success` captures
 * above remain backed by real API writes against real PostgreSQL, so the
 * happy path is never mocked.
 *
 * `permission_denied` is NOT mocked: demo-viewer@acme.vn genuinely lacks
 * `recipient:read` (granted to admin and operator only by
 * 006_recipient_extensions.sql), so RequirePermission denies the real route.
 *
 * One honest limitation is recorded in screen-catalog.yaml rather than papered
 * over: lists and tags are tabs inside the single `/recipients` route, so the
 * permission_denied render is the route's, shared by UI-REC-001/002/003. There
 * is no lists-specific or tags-specific denied screen to capture, because the
 * guard runs before the tabstrip exists.
 */
const EMPTY_SEGMENT_PAGE = JSON.stringify({ items: [], nextCursor: null, total: 0 });
const SERVER_PROBLEM = JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', status: 500 });

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('name@mailspace.vn').fill(email);
  await page.locator('input[type="password"]').fill(DEMO_PASSWORD);
  await page.locator('button.login-submit').click();
  await page.waitForURL(/\/campaigns$/);
}

/** `loadSegments` fetches lists and tags together, so both tabs share one outcome. */
const SEGMENT_ENDPOINTS = ['**/api/v1/recipient-lists?*', '**/api/v1/recipient-lists', '**/api/v1/tags?*', '**/api/v1/tags'];

const SEGMENT_TABS = [
  { name: 'lists', tabIndex: 1, loadingText: 'Đang tải danh sách…', emptyHeading: 'Chưa có danh sách' },
  { name: 'tags', tabIndex: 2, loadingText: 'Đang tải tag…', emptyHeading: 'Chưa có tag' },
] as const;

test.describe('Visual evidence: M2-S2 remaining required states (loading, empty, error, permission_denied)', () => {
  for (const viewport of VIEWPORTS) {
    for (const tab of SEGMENT_TABS) {
      test(`recipient ${tab.name} — loading — production — ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await signIn(page, DEMO_EMAIL);
        // Hold the response open so the loading card is still on screen when the
        // shutter fires; the handler never resolves within the test's lifetime.
        for (const endpoint of SEGMENT_ENDPOINTS) {
          await page.route(endpoint, async () => {
            await new Promise((keepPending) => setTimeout(keepPending, 30_000));
          });
        }
        await page.goto('/recipients');
        await page.locator('[role="tab"]').nth(tab.tabIndex).click();
        await page.getByText(tab.loadingText).waitFor();
        mkdirSync(resolve(M2_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
        await page.screenshot({ path: resolve(M2_S2_EVIDENCE_ROOT, 'production', `recipient-${tab.name}-loading-${viewport.name}.png`), fullPage: true });
      });

      test(`recipient ${tab.name} — empty — production — ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await signIn(page, DEMO_EMAIL);
        for (const endpoint of SEGMENT_ENDPOINTS) {
          await page.route(endpoint, (route) =>
            route.request().method() === 'GET'
              ? route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_SEGMENT_PAGE })
              : route.continue(),
          );
        }
        await page.goto('/recipients');
        await page.locator('[role="tab"]').nth(tab.tabIndex).click();
        await page.getByRole('heading', { name: tab.emptyHeading }).waitFor();
        mkdirSync(resolve(M2_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
        await page.screenshot({ path: resolve(M2_S2_EVIDENCE_ROOT, 'production', `recipient-${tab.name}-empty-${viewport.name}.png`), fullPage: true });
      });

      test(`recipient ${tab.name} — error — production — ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await signIn(page, DEMO_EMAIL);
        for (const endpoint of SEGMENT_ENDPOINTS) {
          await page.route(endpoint, (route) =>
            route.request().method() === 'GET'
              ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: SERVER_PROBLEM })
              : route.continue(),
          );
        }
        await page.goto('/recipients');
        await page.locator('[role="tab"]').nth(tab.tabIndex).click();
        await page.locator('.recipients-module .permission-denied-card').waitFor();
        mkdirSync(resolve(M2_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
        await page.screenshot({ path: resolve(M2_S2_EVIDENCE_ROOT, 'production', `recipient-${tab.name}-error-${viewport.name}.png`), fullPage: true });
      });
    }

    test(`recipients route — permission_denied (real viewer role) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, VIEWER_EMAIL);
      await page.goto('/recipients');
      await page.locator('.permission-denied-card').waitFor();
      mkdirSync(resolve(M2_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S2_EVIDENCE_ROOT, 'production', `recipients-permission-denied-${viewport.name}.png`), fullPage: true });
    });
  }
});

/**
 * M2-GATE found two gaps in UI-REC-001..004's own required_states
 * (screen-catalog.yaml: [loading, empty, error, success, permission_denied]):
 *
 * UI-REC-004 (Recipients — imports, /recipients/imports) had NO visual evidence
 * at all — screen-catalog status was still `not_inventoried`. Its tab is index 3
 * in the same [role="tab"] tablist M2-S2 already uses (all/lists/tags/imports).
 * loading/empty/error use the same page.route-hold/empty-array/500 technique as
 * M2-S2's lists/tags block, for the same reason: they are properties of the
 * client render path, not of any particular dataset, so the only way to
 * photograph "loading" is to hold the response open and the only way to
 * photograph "error" is to induce one. success stays backed by a real import
 * job created through the actual API, never mocked.
 *
 * UI-REC-001 (Recipients — all, /recipients) already had success/empty/error
 * (M2-S1) but was missing `loading` and `permission_denied` from its own
 * required_states list — closed the same way here rather than left as a
 * silent gap in an already-"migrated" screen.
 */
const M2_S4_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M2-S4-import-bulk');
const IMPORT_JOBS_ENDPOINT = '**/api/v1/import-jobs*';
const RECIPIENTS_ENDPOINT = '**/api/v1/recipients*';
// listImportJobs() returns a bare ImportJob[], unlike segments' {items, nextCursor, total} page shape.
const EMPTY_IMPORT_JOBS = JSON.stringify([]);

test.describe('Visual evidence: UI-REC-004 imports (production only, no handoff baseline exists)', () => {
  for (const viewport of VIEWPORTS) {
    test(`recipients imports — loading — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route(IMPORT_JOBS_ENDPOINT, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        await new Promise((keepPending) => setTimeout(keepPending, 30_000));
      });
      await page.goto('/recipients');
      await page.locator('[role="tab"]').nth(3).click();
      await page.getByText('Đang tải lịch sử import…').waitFor();
      mkdirSync(resolve(M2_S4_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S4_EVIDENCE_ROOT, 'production', `recipients-imports-loading-${viewport.name}.png`), fullPage: true });
    });

    test(`recipients imports — empty — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route(IMPORT_JOBS_ENDPOINT, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_IMPORT_JOBS })
          : route.continue(),
      );
      await page.goto('/recipients');
      await page.locator('[role="tab"]').nth(3).click();
      await page.getByRole('heading', { name: 'Chưa có lần import nào' }).waitFor();
      mkdirSync(resolve(M2_S4_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S4_EVIDENCE_ROOT, 'production', `recipients-imports-empty-${viewport.name}.png`), fullPage: true });
    });

    test(`recipients imports — error — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route(IMPORT_JOBS_ENDPOINT, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: SERVER_PROBLEM })
          : route.continue(),
      );
      await page.goto('/recipients');
      await page.locator('[role="tab"]').nth(3).click();
      await page.locator('.recipients-module .permission-denied-card').waitFor();
      mkdirSync(resolve(M2_S4_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S4_EVIDENCE_ROOT, 'production', `recipients-imports-error-${viewport.name}.png`), fullPage: true });
    });

    test(`recipients imports — success — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const response = await page.evaluate(async () => {
        const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
        return fetch('/api/v1/import-jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({
            fileName: 'visual-evidence.csv',
            fileSizeBytes: 42,
            mode: 'upsert',
            mapping: { email: 'Email' },
            rows: [{ rowNumber: 2, rawData: { Email: `visual-import-${Date.now()}@acme.vn` } }],
          }),
        }).then(async (result) => ({ status: result.status, body: await result.text() }));
      });
      if (response.status !== 202) throw new Error(`Could not create visual import job: ${response.status} ${response.body}`);
      await page.goto('/recipients');
      await page.locator('[role="tab"]').nth(3).click();
      await page.locator('.recipients-module table tbody tr').first().waitFor();
      mkdirSync(resolve(M2_S4_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S4_EVIDENCE_ROOT, 'production', `recipients-imports-success-${viewport.name}.png`), fullPage: true });
    });

    test(`recipients imports — permission_denied (real viewer role) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, VIEWER_EMAIL);
      await page.goto('/recipients');
      await page.locator('.permission-denied-card').waitFor();
      mkdirSync(resolve(M2_S4_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S4_EVIDENCE_ROOT, 'production', `recipients-imports-permission-denied-${viewport.name}.png`), fullPage: true });
    });
  }
});

test.describe('Visual evidence: UI-REC-001 remaining required states (loading, permission_denied)', () => {
  for (const viewport of VIEWPORTS) {
    test(`recipients all — loading — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route(RECIPIENTS_ENDPOINT, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        await new Promise((keepPending) => setTimeout(keepPending, 30_000));
      });
      await page.goto('/recipients');
      await page.locator('.recipients-module [role="status"]').waitFor();
      mkdirSync(resolve(M2_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S1_EVIDENCE_ROOT, 'production', `recipients-loading-${viewport.name}.png`), fullPage: true });
    });

    test(`recipients all — permission_denied (real viewer role) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, VIEWER_EMAIL);
      await page.goto('/recipients');
      await page.locator('.permission-denied-card').waitFor();
      mkdirSync(resolve(M2_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M2_S1_EVIDENCE_ROOT, 'production', `recipients-permission-denied-${viewport.name}.png`), fullPage: true });
    });
  }
});

test.describe('Visual evidence: handoff baseline', () => {
  for (const viewport of VIEWPORTS) {
    test(`login screen — handoff baseline — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(HANDOFF_BASE_URL);
      await page.waitForSelector('.login-card');
      mkdirSync(resolve(EVIDENCE_ROOT, 'handoff-baseline'), { recursive: true });
      await page.screenshot({ path: resolve(EVIDENCE_ROOT, 'handoff-baseline', `login-${viewport.name}.png`), fullPage: true });
    });
  }

  // NOTE: a handoff-shell screenshot is intentionally not captured here.
  // The handoff's login form submit falls back to a native full-page
  // navigation in this Next.js/vinext/Cloudflare-Workers RSC dev runtime
  // (observed: "navigated to http://localhost:4173/?" instead of the
  // client-side onSubmit firing) before React hydration finishes wiring the
  // handler — a runtime/tooling quirk of the handoff's stack, not something
  // this node can or should fix (out of scope: apps/web is the port target,
  // not the handoff source). Shell visual equivalence is still evidenced by:
  // (1) the production shell screenshots above at all 3 viewports, and
  // (2) DOM structure + globals.css being byte-identical to
  // design-reference/ui-handoff-v2/source/app/page.tsx L277-309 and
  // app/globals.css by construction (verified via `diff`, see state.json
  // evidence) — visual equivalence holds by construction per EXECPLAN §12.
});

// M3-S1 (Templates): no handoff screen owns /templates (same class of gap as
// M2-S3/M2-S2 above) -- production-only. loading/empty/error are client
// render-path states held open with page.route(), matching the established
// M2-S1/M2-S3/M2-S4 pattern; success writes a real template through a real
// POST; permission_denied is NOT mocked -- demo-viewer@acme.vn genuinely
// lacks content:manage (004_rbac.sql grants it to admin/operator only), so
// RequirePermission denies the real route.
const M3_S1_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M3-S1-templates');
const TEMPLATES_ENDPOINT = '**/api/v1/templates*';
const EMPTY_TEMPLATES = JSON.stringify({ items: [] });

test.describe('Visual evidence: UI-TPL-001 templates (production only, no handoff baseline exists)', () => {
  for (const viewport of VIEWPORTS) {
    test(`templates — loading — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route(TEMPLATES_ENDPOINT, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        await new Promise((keepPending) => setTimeout(keepPending, 30_000));
      });
      await page.goto('/templates');
      await page.locator('.template-grid[aria-busy="true"]').waitFor();
      mkdirSync(resolve(M3_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M3_S1_EVIDENCE_ROOT, 'production', `templates-loading-${viewport.name}.png`), fullPage: true });
    });

    test(`templates — empty — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route(TEMPLATES_ENDPOINT, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_TEMPLATES })
          : route.continue(),
      );
      await page.goto('/templates');
      await page.getByRole('heading', { name: 'Chưa có template phù hợp' }).waitFor();
      mkdirSync(resolve(M3_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M3_S1_EVIDENCE_ROOT, 'production', `templates-empty-${viewport.name}.png`), fullPage: true });
    });

    test(`templates — error — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route(TEMPLATES_ENDPOINT, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: SERVER_PROBLEM })
          : route.continue(),
      );
      await page.goto('/templates');
      await page.locator('.permission-denied-card').waitFor();
      mkdirSync(resolve(M3_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M3_S1_EVIDENCE_ROOT, 'production', `templates-error-${viewport.name}.png`), fullPage: true });
    });

    test(`templates — success — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const response = await page.evaluate(async (name) => {
        const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
        return fetch('/api/v1/templates', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ name, subject: 'Chào mừng', html: '<p>Nội dung chào mừng an toàn</p>' }),
        }).then(async (result) => ({ status: result.status, body: await result.text() }));
      }, `visual-template-${viewport.name}-${Date.now()}`);
      if (response.status !== 201) throw new Error(`Could not create visual template: ${response.status} ${response.body}`);
      trackFixture('templates', (JSON.parse(response.body) as { id?: string }).id);
      await page.goto('/templates');
      await page.locator('.template-card:not(.template-skeleton)').first().waitFor();
      mkdirSync(resolve(M3_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M3_S1_EVIDENCE_ROOT, 'production', `templates-success-${viewport.name}.png`), fullPage: true });
    });

    // M6: template editing is a route now, not the TemplateActionsOverlay modal
    // this block used to reach through the card menu. Captured with a real
    // template rather than a mocked one for the same reason `templates —
    // success` above is: the screen's whole point is the live GET
    // /templates/:id, the POST /templates/analyze diagnostics and the
    // server-rendered preview, and mocking any of them would photograph a
    // screen the app never actually renders. The render-path states
    // (loading/error) stay mocked above, where mocking is the only way to hold
    // them open.
    test(`templates — routed editor — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const created = await page.evaluate(async (name) => {
        const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
        const response = await fetch('/api/v1/templates', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ name, subject: 'Chào {{first_name}}', html: '<p>Xin chào {{first_name}}, xem <a href="https://example.test/a">hướng dẫn</a>.</p>' }),
        });
        return { status: response.status, body: await response.text() };
      }, `visual-editor-${viewport.name}-${Date.now()}`);
      if (created.status !== 201) throw new Error(`Could not create visual template: ${created.status} ${created.body}`);
      const { id } = JSON.parse(created.body) as { id: string };
      trackFixture('templates', id);
      await page.goto(`/templates/${id}/edit`);
      // The frame alone renders before the GET lands; the preview iframe is
      // what proves the draft loaded and the server rendered it, so the
      // screenshot cannot catch "Đang tải template…" under the editor's name.
      await page.locator('.template-editor-workspace').waitFor();
      await page.locator('.mail-preview-stage iframe').waitFor();
      mkdirSync(resolve(M3_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M3_S1_EVIDENCE_ROOT, 'production', `templates-editor-${viewport.name}.png`), fullPage: true });
    });

    test(`templates — permission_denied (real viewer role) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, VIEWER_EMAIL);
      await page.goto('/templates');
      await page.locator('.permission-denied-card').waitFor();
      mkdirSync(resolve(M3_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M3_S1_EVIDENCE_ROOT, 'production', `templates-permission-denied-${viewport.name}.png`), fullPage: true });
    });
  }
});

// M3-GATE condition-3 fix: composePreview and sendTest had no UI at all after
// M3-S3 shipped their API. Built as new overlays on /templates (triggered from
// templateActions' "Xem trước" button, published templates only); captured
// here rather than under M3-S3-preview's own directory since the gate is what
// required them, and to keep this fix's evidence provenance separate from
// M3-S3's own (already-closed) checkpoint evidence.
const M3_GATE_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M3-GATE');

const M4_S1_EVIDENCE_ROOT = process.env.M4_S1_EVIDENCE_ROOT
  ? resolve(process.env.M4_S1_EVIDENCE_ROOT)
  : resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M4-S1-campaign-draft');
/** GET /campaigns/history's page shape, which carries serverTime and nextCursor alongside items. */
const EMPTY_CAMPAIGNS = JSON.stringify({ serverTime: '2026-08-25T00:00:00.000Z', items: [], nextCursor: null });

/**
 * Opening one template's action menu, then choosing its preview item.
 *
 * Both halves used to be written loosely, and both were wrong the moment the
 * demo tenant held more than one template. `getByRole('button', { name:
 * /Tùy chọn template/ }).first()` reached whatever card happened to sort first
 * rather than the one the test had just published, and `getByRole('button',
 * { name: 'Xem trước' })` substring-matched every card's own
 * `aria-label="Xem trước template <name>"` preview button -- 100 of them on
 * 2026-08-25, the grid's full page (listTemplates caps at 100), which is the
 * strict-mode violation that failed these six tests. It never matched the menu
 * item it was aiming at at all: that item carries `role="menuitem"`, not
 * `button`, and reads "Xem trước email".
 */
async function openTemplatePreview(page: import('@playwright/test').Page, templateName: string): Promise<void> {
  await page.getByRole('button', { name: `Tùy chọn template ${templateName}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Xem trước email', exact: true }).click();
}

test.describe('Visual evidence: M3-GATE composePreview/sendTest overlays (production only, no handoff baseline exists)', () => {
  for (const viewport of VIEWPORTS) {
    test(`composePreview overlay — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const templateName = `gate-preview-${viewport.name}-${Date.now()}`;
      const created = await page.evaluate(async (name) => {
        const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
        const draft = await fetch('/api/v1/templates', {
          method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ name, subject: 'Chào {{first_name}}', html: '<p>Xin chào {{first_name}}, xem <a href="https://example.test/a">hướng dẫn</a>.</p>' }),
        }).then((result) => result.json() as Promise<{ id: string }>);
        const published = await fetch(`/api/v1/templates/${draft.id}/publish`, { method: 'POST', credentials: 'include', headers: { 'x-csrf-token': csrf } });
        return { status: published.status, id: draft.id };
      }, templateName);
      if (created.status !== 201) throw new Error(`Could not publish visual-evidence template: ${created.status}`);
      trackFixture('templates', created.id);
      await page.goto('/templates');
      await openTemplatePreview(page, templateName);
      await page.getByRole('heading', { name: 'Xem trước email' }).waitFor();
      await page.locator('.mail-preview-stage article').waitFor();
      mkdirSync(resolve(M3_GATE_EVIDENCE_ROOT, 'production'), { recursive: true });
      // fullPage: false -- a fixed-position modal over an unbounded template list otherwise
      // captures a tall, mostly-background image with the dialog compressed into a sliver.
      await page.screenshot({ path: resolve(M3_GATE_EVIDENCE_ROOT, 'production', `compose-preview-${viewport.name}.png`) });
    });

    test(`sendTest overlay — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const templateName = `gate-sendtest-${viewport.name}-${Date.now()}`;
      const created = await page.evaluate(async (name) => {
        const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
        const draft = await fetch('/api/v1/templates', {
          method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ name, subject: 'Chào {{first_name}}', html: '<p>Xin chào {{first_name}}</p>' }),
        }).then((result) => result.json() as Promise<{ id: string }>);
        const published = await fetch(`/api/v1/templates/${draft.id}/publish`, { method: 'POST', credentials: 'include', headers: { 'x-csrf-token': csrf } });
        return { status: published.status, id: draft.id };
      }, templateName);
      if (created.status !== 201) throw new Error(`Could not publish visual-evidence template: ${created.status}`);
      trackFixture('templates', created.id);
      await page.goto('/templates');
      await openTemplatePreview(page, templateName);
      await page.getByRole('button', { name: 'Gửi thử email này' }).click();
      await page.getByRole('heading', { name: 'Gửi email thử' }).waitFor();
      await page.locator('.info-banner').waitFor();
      mkdirSync(resolve(M3_GATE_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M3_GATE_EVIDENCE_ROOT, 'production', `send-test-${viewport.name}.png`) });
    });
  }
});

/**
 * Every compose capture below waits on `.compose-grid` rather than the
 * `.editor-shell` it used to wait on. The composer's dead editor shell was a
 * placeholder with no behaviour behind it; the template editor now owns the
 * real one at /templates/:id/edit, and the composer's context panel grew a
 * working "Xem trước" tab in its place. `.compose-grid` is the same signal the
 * old selector actually carried here -- it exists only once ComposeDraftScreen
 * has a loaded draft, never in its "Đang tải trình soạn thảo…" state.
 */
test.describe('Visual evidence: M4-S1 campaign draft screens (production)', () => {
  for (const viewport of VIEWPORTS) {
    test(`compose success — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.goto('/campaigns/new');
      await page.locator('.compose-fields label.field.full input').first().fill(`Visual campaign ${viewport.name} ${Date.now()}`);
      await page.locator('.compose-card .primary-button').click();
      await page.waitForSelector('.compose-grid');
      mkdirSync(resolve(M4_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S1_EVIDENCE_ROOT, 'production', `compose-success-${viewport.name}.png`), fullPage: true });
    });

    test(`drafts success — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.goto('/campaigns');
      // A real row, not just the frame: waiting for the card alone races the
      // fetch and can screenshot the loading state under the name "success"
      // (that happened before, and was only caught by opening the saved PNGs).
      // The preceding "compose success" test in this describe block already
      // created a campaign as the same demo user, so a row is guaranteed.
      await page.waitForSelector('.history-table tbody tr');
      mkdirSync(resolve(M4_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S1_EVIDENCE_ROOT, 'production', `drafts-success-${viewport.name}.png`), fullPage: true });
    });

    test(`drafts empty — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route('**/api/v1/campaigns/history*', (route) => route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_CAMPAIGNS }) : route.continue());
      await page.goto('/campaigns');
      await page.getByText('Chưa có chiến dịch nào.').waitFor();
      mkdirSync(resolve(M4_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S1_EVIDENCE_ROOT, 'production', `drafts-empty-${viewport.name}.png`), fullPage: true });
    });

    test(`drafts error — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route('**/api/v1/campaigns/history*', (route) => route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: SERVER_PROBLEM }) : route.continue());
      await page.goto('/campaigns');
      await page.locator('.permission-denied-card').waitFor();
      mkdirSync(resolve(M4_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S1_EVIDENCE_ROOT, 'production', `drafts-error-${viewport.name}.png`), fullPage: true });
    });

    test(`drafts permission_denied — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, VIEWER_EMAIL);
      // Since the Chiến dịch restructure the list itself is viewer-readable
      // (campaign:read, ADR-034) -- the server simply returns no draft rows.
      // The composer is what a viewer cannot reach, so that is where the
      // permission_denied state now lives.
      await page.goto('/campaigns/new');
      await page.locator('.permission-denied-card').waitFor();
      mkdirSync(resolve(M4_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S1_EVIDENCE_ROOT, 'production', `drafts-permission-denied-${viewport.name}.png`), fullPage: true });
    });
  }
});

// M4-S2 (Audience resolution): the recipientPicker overlay resolves a real
// audience through previewCampaignAudience — every capture here is backed by
// real recipients/lists/memberships created through the actual API in the
// test itself (never mocked), so the numbers on screen are the numbers the
// resolver actually computed, matching A9/A10's own requirement that the
// preview be the real computation, not a good-looking estimate. Production
// only: recipientPicker has no handoff DOM for its Include/Exclude toggle
// (§CP5 scoping decision — the handoff has no exclusion affordance at all),
// so there is nothing to diff against a baseline for that part of the screen.
const M4_S2_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M4-S2-audience');

async function seedAudienceFixture(page: import('@playwright/test').Page, label: string) {
  // Same-origin `/api/v1`, the one contract every fixture in this file follows
  // (playwright.config.ts): Nginx fronts both the SPA and the API in the
  // packaged stack, so a relative path is all a browser-side fetch ever needs.
  const fixture = await page.evaluate(async (label) => {
    const base = '/api/v1';
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
    // Every write is checked. Left unchecked, a rejected POST returns a problem
    // body with no `id`, the fixture hands back `undefined`, and the failure
    // surfaces 30 seconds later as a locator timeout in the test that used it.
    const created = async (path: string, body: unknown) => {
      const response = await fetch(`${base}/${path}`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
      const text = await response.text();
      if (response.status !== 201) throw new Error(`POST /${path} -> ${response.status} ${text}`);
      return JSON.parse(text) as { id: string };
    };
    const recipient = await created('recipients', { email: `${label}@acme.vn`, firstName: 'Minh An', lastName: 'Nguyễn' });
    // GET /recipient-lists sorts `ORDER BY name ASC` and the picker overlay
    // fetches only the first 100, filtering client-side over that page --
    // it never re-queries the server as the search box is typed. A name
    // starting with a digit sorts before every letter (ASCII), so a fixture
    // list lands in that first page regardless of how many `visual-`/`gate-`/
    // `Import list <uuid>`/... lists the shared demo tenant has accumulated.
    // Without this, `recipientPicker — resolved summary` (the third of these
    // three tests, so the one most exposed to lists this same run has already
    // created) intermittently could not find its own list at all.
    const includeList = await created('recipient-lists', { name: `0-${label}-include` });
    const excludeList = await created('recipient-lists', { name: `0-${label}-exclude` });
    await fetch(`${base}/recipient-lists/${includeList.id}/members`, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify({ recipientIds: [recipient.id] }),
    });
    await fetch(`${base}/recipient-lists/${excludeList.id}/members`, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify({ recipientIds: [recipient.id] }),
    });
    return { recipientId: recipient.id, label, includeListId: includeList.id, includeListName: `0-${label}-include`, excludeListId: excludeList.id, excludeListName: `0-${label}-exclude` };
  }, label);
  trackFixture('recipients', fixture.recipientId);
  trackFixture('recipient-lists', fixture.includeListId);
  trackFixture('recipient-lists', fixture.excludeListId);
  return fixture;
}

test.describe('Visual evidence: M4-S2 recipientPicker overlay (production only, no handoff baseline for the Include/Exclude toggle)', () => {
  for (const viewport of VIEWPORTS) {
    test(`recipientPicker — resolved audience — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedAudienceFixture(page, `visual-audience-${viewport.name}-${Date.now()}`);
      await page.goto('/campaigns/new');
      await page.locator('.compose-fields label.field.full input').first().fill(`Visual audience ${viewport.name} ${Date.now()}`);
      await page.locator('.compose-card .primary-button').click();
      await page.waitForSelector('.compose-grid');
      await page.locator('.recipient-field button').click();
      await page.getByRole('heading', { name: 'Chọn người nhận' }).waitFor();
      // The demo tenant accumulates lists across every visual-evidence run;
      // filter to this fixture's own two lists so the capture below doesn't
      // scroll the "Đã chọn" summary out of frame behind a long list panel.
      await page.getByPlaceholder('Tìm danh sách người nhận').fill(fixture.label);
      await page.getByText(fixture.includeListName).click();
      await page.getByText('1 / 1 người đủ điều kiện').waitFor();
      mkdirSync(resolve(M4_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S2_EVIDENCE_ROOT, 'production', `recipient-picker-resolved-${viewport.name}.png`) });
    });

    test(`recipientPicker — exclusion applied — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedAudienceFixture(page, `visual-exclude-${viewport.name}-${Date.now()}`);
      await page.goto('/campaigns/new');
      await page.locator('.compose-fields label.field.full input').first().fill(`Visual exclude ${viewport.name} ${Date.now()}`);
      await page.locator('.compose-card .primary-button').click();
      await page.waitForSelector('.compose-grid');
      await page.locator('.recipient-field button').click();
      await page.getByRole('heading', { name: 'Chọn người nhận' }).waitFor();
      await page.getByPlaceholder('Tìm danh sách người nhận').fill(fixture.label);
      await page.getByText(fixture.includeListName).click();
      await page.getByText('1 / 1 người đủ điều kiện').waitFor();
      await page.getByRole('button', { name: 'Loại trừ' }).click();
      await page.getByText(fixture.excludeListName).click();
      await page.getByText('Bị loại trừ theo danh sách: 1').waitFor();
      mkdirSync(resolve(M4_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S2_EVIDENCE_ROOT, 'production', `recipient-picker-exclusion-${viewport.name}.png`) });
    });

    test(`compose recipient field — resolved summary replaces placeholder — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedAudienceFixture(page, `visual-summary-${viewport.name}-${Date.now()}`);
      await page.goto('/campaigns/new');
      await page.locator('.compose-fields label.field.full input').first().fill(`Visual summary ${viewport.name} ${Date.now()}`);
      await page.locator('.compose-card .primary-button').click();
      await page.waitForSelector('.compose-grid');
      await page.locator('.recipient-field button').click();
      await page.getByRole('heading', { name: 'Chọn người nhận' }).waitFor();
      // Same accumulation reason as the sibling tests above: filter to this
      // fixture's own list so it isn't scrolled out of frame by every other
      // list this demo tenant has accumulated across visual-evidence runs.
      await page.getByPlaceholder('Tìm danh sách người nhận').fill(fixture.label);
      await page.getByText(fixture.includeListName).click();
      await page.getByText('1 / 1 người đủ điều kiện').waitFor();
      await page.getByRole('button', { name: /Áp dụng \d+ người/ }).click();
      await page.getByText('1 người nhận').waitFor();
      mkdirSync(resolve(M4_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S2_EVIDENCE_ROOT, 'production', `compose-recipient-resolved-${viewport.name}.png`), fullPage: true });
    });
  }
});

// M4-S3 (Variable policy): templatePicker and sendConfirm resolve real data
// through validateCampaignAudience/acceptCampaignAudienceWaiver -- every
// capture here is backed by a real published template, custom field and
// recipient created through the actual API, never mocked. Production only:
// neither overlay has a handoff DOM for the real gating/waiver behavior
// (the handoff's sendConfirm shows fixed "121 gửi · 7 tạm loại" numbers with
// no real backing computation), so there is nothing to diff against.
const M4_S3_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M4-S3-variable-policy');

async function seedVariablePolicyFixture(page: import('@playwright/test').Page, label: string, requireField: boolean) {
  const fixture = await page.evaluate(async ({ label, requireField }) => {
    const base = '/api/v1';
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
    const fieldKey = `${label.replace(/[^a-z0-9]/gi, '_')}_field`;
    const field = await fetch(`${base}/custom-fields`, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ key: fieldKey, label: 'Khu vực', type: 'text', required: requireField }),
    }).then((result) => result.json() as Promise<{ id: string }>);
    const draft = await fetch(`${base}/templates`, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ name: `${label}-template`, subject: 'Hi {{first_name}}', html: `<p>{{first_name}} in {{${fieldKey}}}</p>` }),
    }).then((result) => result.json() as Promise<{ id: string }>);
    const published = await fetch(`${base}/templates/${draft.id}/publish`, { method: 'POST', credentials: 'include', headers })
      .then((result) => result.json() as Promise<{ id: string }>);
    const recipient = await fetch(`${base}/recipients`, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify({ email: `${label}@acme.vn`, firstName: 'Minh An' }),
    }).then((result) => result.json() as Promise<{ id: string }>);
    const list = await fetch(`${base}/recipient-lists`, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify({ name: `${label}-list` }),
    }).then((result) => result.json() as Promise<{ id: string }>);
    await fetch(`${base}/recipient-lists/${list.id}/members`, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify({ recipientIds: [recipient.id] }),
    });
    return { templateId: draft.id, templateVersionId: published.id, listId: list.id, templateName: `${label}-template`, fieldId: field.id, recipientId: recipient.id };
  }, { label, requireField });
  trackFixture('templates', fixture.templateId);
  trackFixture('recipient-lists', fixture.listId);
  trackFixture('recipients', fixture.recipientId);
  trackFixture('custom-fields', fixture.fieldId);
  return fixture;
}

/**
 * One verified sender config per worker, shared by every draft fixture below.
 *
 * `localComposeValidation` gates "Xem lại & xác nhận gửi" (and "Hẹn giờ") on
 * name + subject + `sender.senderConfigId` + `templateVersionId`, so a draft
 * missing any of them quietly focuses the offending field instead of opening
 * the overlay -- which is what left every M4-S3/M4-S4/M5-S2 capture waiting on
 * a dialog that was never going to appear. The id cannot be invented either:
 * campaigns.service's `resolveDraftSender` rejects anything that is not a
 * verified active config (SENDER_NOT_USABLE), so this runs the real SMTP probe
 * against Mailpit, exactly as the M5-S1 policy capture does.
 */
let verifiedSenderConfigId: string | null = null;

async function ensureVerifiedSender(page: import('@playwright/test').Page): Promise<string> {
  if (verifiedSenderConfigId) return verifiedSenderConfigId;
  const created = await createVisualSender(page, `e2e-draft-sender-${Date.now()}`);
  await probeSenderConfig(page, created.id);
  verifiedSenderConfigId = created.id;
  return created.id;
}

async function createDraftWithFixture(page: import('@playwright/test').Page, name: string, fixture: { templateId: string; templateVersionId: string; listId: string }) {
  const senderConfigId = await ensureVerifiedSender(page);
  return page.evaluate(async ({ name, fixture, senderConfigId }) => {
    const base = '/api/v1';
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
    const draft = await fetch(`${base}/campaigns`, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({
        name,
        subject: 'Bản tin nội bộ',
        templateId: fixture.templateId,
        templateVersionId: fixture.templateVersionId,
        sender: { senderConfigId },
        audience: { listIds: [fixture.listId] },
      }),
    }).then((result) => result.json() as Promise<{ id: string; version: number }>);
    return draft;
  }, { name, fixture, senderConfigId });
}

test.describe('Visual evidence: M4-S3 templatePicker + sendConfirm (production only, no handoff baseline for the real gating behavior)', () => {
  for (const viewport of VIEWPORTS) {
    test(`templatePicker — real published templates — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-tplpicker-${viewport.name}-${Date.now()}`, false);
      await page.goto('/campaigns/new');
      await page.locator('.compose-fields label.field.full input').first().fill(`Visual template picker ${viewport.name} ${Date.now()}`);
      await page.locator('.compose-card .primary-button').click();
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Chọn template' }).click();
      await page.getByRole('heading', { name: 'Chọn HTML template' }).waitFor();
      await page.getByPlaceholder('Tìm template').fill(fixture.templateName);
      await page.getByText(fixture.templateName).waitFor();
      mkdirSync(resolve(M4_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S3_EVIDENCE_ROOT, 'production', `template-picker-${viewport.name}.png`) });
    });

    test(`sendConfirm — complete audience, CTA gated on confirm-check — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-complete-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual complete ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Xem lại & xác nhận gửi' }).click();
      await page.getByRole('heading', { name: 'Xác nhận gửi email' }).waitFor();
      await page.getByText('1 địa chỉ đủ điều kiện gửi').waitFor();
      mkdirSync(resolve(M4_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S3_EVIDENCE_ROOT, 'production', `send-confirm-complete-${viewport.name}.png`) });
    });

    test(`sendConfirm — missing required variable, CTA blocked — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-missing-${viewport.name}-${Date.now()}`, true);
      const draft = await createDraftWithFixture(page, `Visual missing ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Xem lại & xác nhận gửi' }).click();
      await page.getByRole('heading', { name: 'Xác nhận gửi email' }).waitFor();
      await expect(page.locator('.variable-resolution header b')).toContainText('người nhận thiếu biến bắt buộc');
      mkdirSync(resolve(M4_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S3_EVIDENCE_ROOT, 'production', `send-confirm-missing-${viewport.name}.png`) });
    });

    test(`sendConfirm — waiver accepted, CTA unblocked — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-waived-${viewport.name}-${Date.now()}`, true);
      const draft = await createDraftWithFixture(page, `Visual waived ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Xem lại & xác nhận gửi' }).click();
      await page.getByRole('heading', { name: 'Xác nhận gửi email' }).waitFor();
      await page.getByRole('button', { name: 'Chấp nhận loại trừ và tiếp tục' }).click();
      await page.getByText('đã được xác nhận loại khỏi lần gửi').waitFor();
      await page.locator('.confirm-check input').click();
      mkdirSync(resolve(M4_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S3_EVIDENCE_ROOT, 'production', `send-confirm-waived-${viewport.name}.png`) });
    });
  }
});

// M4-S4 (Campaign snapshot): sendConfirm's primary CTA is now a real
// terminal action (BR-CMP-007/010) and the compose screen shows a frozen
// banner with cancel-to-refresh once a campaign is queued (BR-CF-008).
// Production only, same reasoning as the M4-S3 block above: neither state
// exists in the handoff DOM. Reuses seedVariablePolicyFixture/
// createDraftWithFixture verbatim -- a real published template, custom
// field and recipient, never mocked.
const M4_S4_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M4-S4-snapshot');

test.describe('Visual evidence: M4-S4 sendConfirm terminal action + frozen banner (production only, no handoff baseline exists)', () => {
  for (const viewport of VIEWPORTS) {
    test(`sendConfirm — idle, awaiting confirm-check — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-idle-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual idle ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Xem lại & xác nhận gửi' }).click();
      await page.getByRole('heading', { name: 'Xác nhận gửi email' }).waitFor();
      await page.getByText('1 địa chỉ đủ điều kiện gửi').waitFor();
      mkdirSync(resolve(M4_S4_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S4_EVIDENCE_ROOT, 'production', `send-confirm-idle-${viewport.name}.png`) });
    });

    test(`sendConfirm — send failed, CTA re-enabled for retry — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-error-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual error ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Xem lại & xác nhận gửi' }).click();
      await page.getByRole('heading', { name: 'Xác nhận gửi email' }).waitFor();
      await page.getByText('1 địa chỉ đủ điều kiện gửi').waitFor();
      await page.locator('.confirm-check input').click();
      await page.route('**/api/v1/campaigns/*/send', (route) =>
        route.fulfill({ status: 500, contentType: 'application/problem+json', body: SERVER_PROBLEM }));
      await page.getByRole('button', { name: /^Gửi \d+ email$/ }).click();
      await page.getByText('Hệ thống gặp lỗi tạm thời. Vui lòng thử lại sau.').waitFor();
      // The CTA must re-enable for a retry with the same Idempotency-Key,
      // not stay stuck in the disabled "sending" state after a failure.
      await expect(page.getByRole('button', { name: /^Gửi \d+ email$/ })).toBeEnabled();
      mkdirSync(resolve(M4_S4_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S4_EVIDENCE_ROOT, 'production', `send-confirm-error-${viewport.name}.png`) });
    });

    test(`sendConfirm — sending, CTA disabled and busy — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-sending-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual sending ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Xem lại & xác nhận gửi' }).click();
      await page.getByRole('heading', { name: 'Xác nhận gửi email' }).waitFor();
      await page.getByText('1 địa chỉ đủ điều kiện gửi').waitFor();
      await page.locator('.confirm-check input').click();
      // Hold the send request open so the "Đang gửi…" frame is still on
      // screen when the shutter fires -- BR-CMP-010's disabled/busy state,
      // not the resolved outcome.
      await page.route('**/api/v1/campaigns/*/send', async () => {
        await new Promise((keepPending) => setTimeout(keepPending, 30_000));
      });
      await page.getByRole('button', { name: /^Gửi \d+ email$/ }).click();
      await page.getByRole('button', { name: 'Đang gửi…' }).waitFor();
      mkdirSync(resolve(M4_S4_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S4_EVIDENCE_ROOT, 'production', `send-confirm-sending-${viewport.name}.png`) });
    });

    test(`sendConfirm — sent successfully, frozen counts shown — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-sent-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual sent ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Xem lại & xác nhận gửi' }).click();
      await page.getByRole('heading', { name: 'Xác nhận gửi email' }).waitFor();
      await page.getByText('1 địa chỉ đủ điều kiện gửi').waitFor();
      await page.locator('.confirm-check input').click();
      await page.getByRole('button', { name: /^Gửi \d+ email$/ }).click();
      await page.getByRole('heading', { name: 'Đã gửi thành công' }).waitFor();
      mkdirSync(resolve(M4_S4_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M4_S4_EVIDENCE_ROOT, 'production', `send-confirm-success-${viewport.name}.png`) });
    });

    test(`compose — frozen banner after send, cancel-to-refresh returns to editable — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-frozen-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual frozen ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Xem lại & xác nhận gửi' }).click();
      await page.getByRole('heading', { name: 'Xác nhận gửi email' }).waitFor();
      await page.locator('.confirm-check input').click();
      await page.getByRole('button', { name: /^Gửi \d+ email$/ }).click();
      await page.getByRole('heading', { name: 'Đã gửi thành công' }).waitFor();
      await page.getByRole('button', { name: 'Đóng' }).click();
      await page.getByText('Chiến dịch đã được đóng băng để gửi.').waitFor();
      await expect(page.locator('.compose-fields label.field.full input').first()).toBeDisabled();
      mkdirSync(resolve(M4_S4_EVIDENCE_ROOT, 'production'), { recursive: true });
      // Not fullPage: .compose-card scrolls internally (globals.css line ~165,
      // pre-existing since M4-S1's own compose-success capture), and Playwright's
      // fullPage screenshot does not unroll a nested overflow:auto region -- it
      // misrepresents already-correct content as clipped/overlapping. A plain
      // viewport screenshot is what a real user actually sees on load.
      await page.screenshot({ path: resolve(M4_S4_EVIDENCE_ROOT, 'production', `compose-frozen-banner-${viewport.name}.png`) });

      await page.getByRole('button', { name: 'Hủy để chỉnh sửa lại' }).click();
      await page.getByRole('button', { name: 'Xem lại & xác nhận gửi' }).waitFor();
      await expect(page.locator('.compose-fields label.field.full input').first()).toBeEnabled();
      await page.screenshot({ path: resolve(M4_S4_EVIDENCE_ROOT, 'production', `compose-cancelled-editable-${viewport.name}.png`) });
    });
  }
});

// M5-S1 (Sender configuration): production-only, no handoff screen owns
// /settings/senders or /settings/policy (same class of gap as M2-S3/M3-S1
// above). Both routes share one screen component (SenderSettingsScreen,
// `policyOnly` toggling which half renders) and one `Promise.all([list, policy])`
// fetch, so loading/error mocks must intercept both endpoints together or the
// combined fetch resolves/rejects on the wrong one. permission_denied is NOT
// mocked: demo-viewer@acme.vn genuinely lacks settings:manage (004_rbac.sql
// grants it to admin only), so RequirePermission denies the real route,
// exactly like the M1-S2/M2-S1/M3-S1 precedent.
const M5_S1_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M5-S1-sender-config');
const SENDER_CONFIGS_ENDPOINT = '**/api/v1/sender-configs*';
const SENDING_POLICY_ENDPOINT = '**/api/v1/sending-policy*';
const EMPTY_SENDER_LIST = JSON.stringify({ items: [] });
const EMPTY_POLICY = JSON.stringify({ defaultSenderConfigId: null, replyTo: null });

/**
 * The suite's single API contract (playwright.config.ts): a relative path,
 * same-origin with the page, which the packaged stack's Nginx proxies to the
 * api container. Kept as a named constant only so the marshalled
 * `page.evaluate` fixtures below read the same way as the inline `/api/v1`
 * literals elsewhere in this file -- there is no absolute-origin variant.
 */
const E2E_API_BASE = '/api/v1';
/**
 * The SMTP host a sender-config fixture points at. It is dialled by the *api
 * container*, not by the test runner, so it is the compose service name --
 * `127.0.0.1` would be the API's own loopback, where nothing is listening, and
 * the verification probe below would never promote a config to `verified`.
 */
const E2E_SMTP_HOST = 'mailpit';

async function createVisualSender(page: import('@playwright/test').Page, name: string) {
  const response = await page.evaluate(async ({ senderName, apiBase, smtpHost }) => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    return fetch(`${apiBase}/sender-configs`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ name: senderName, fromName: 'Visual Evidence', fromEmail: `${senderName.replace(/[^a-z0-9]/gi, '-')}@example.test`, host: smtpHost, port: 1025, username: '', secret: 'visual-evidence-not-a-real-secret' }),
    }).then(async (result) => ({ status: result.status, body: await result.text() }));
  }, { senderName: name, apiBase: E2E_API_BASE, smtpHost: E2E_SMTP_HOST });
  if (response.status !== 201) throw new Error(`Could not create visual-evidence sender: ${response.status} ${response.body}`);
  const sender = JSON.parse(response.body) as { id: string };
  trackFixture('sender-configs', sender.id);
  return sender;
}

/**
 * The policy screen's default-sender `<select>` lists only `status === 'verified'`
 * configs, so a freshly created (`pending`) sender leaves the dropdown showing
 * "Chưa chọn" — a "success" capture built on create alone is indistinguishable
 * from the empty one (the D-42 failure mode). This drives the real state
 * transition instead: the real SMTP probe against Mailpit promotes the config
 * to `verified`, then a real PUT makes it the tenant default, so the captured
 * frame shows an actually-populated policy.
 */
/** The real SMTP probe against Mailpit -- the only thing that moves a config from `pending` to `verified`. */
async function probeSenderConfig(page: import('@playwright/test').Page, senderId: string): Promise<void> {
  const outcome = await page.evaluate(async ({ id, apiBase }) => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const probe = await fetch(`${apiBase}/sender-configs/${id}/test-connection`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': `visual-evidence-${id}` },
      body: JSON.stringify({}),
    });
    return { status: probe.status, body: await probe.text() };
  }, { id: senderId, apiBase: E2E_API_BASE });
  if (!String(outcome.body).includes('"ok":true')) throw new Error(`SMTP probe did not verify the sender: ${outcome.status} ${outcome.body}`);
}

async function verifyAndSetDefaultSender(page: import('@playwright/test').Page, senderId: string, replyTo: string) {
  await probeSenderConfig(page, senderId);
  const outcome = await page.evaluate(async ({ id, apiBase, replyToAddress }) => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const policy = await fetch(`${apiBase}/sending-policy`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ defaultSenderConfigId: id, replyTo: replyToAddress }),
    });
    return { policyStatus: policy.status, policyBody: await policy.text() };
  }, { id: senderId, apiBase: E2E_API_BASE, replyToAddress: replyTo });
  if (outcome.policyStatus >= 400) throw new Error(`Could not set the default sending policy: ${outcome.policyStatus} ${outcome.policyBody}`);
}

test.describe('Visual evidence: M5-S1 sender configuration (production only, no handoff baseline exists)', () => {
  for (const viewport of VIEWPORTS) {
    test(`sender configs — loading — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      for (const endpoint of [SENDER_CONFIGS_ENDPOINT, SENDING_POLICY_ENDPOINT]) {
        await page.route(endpoint, async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          await new Promise((keepPending) => setTimeout(keepPending, 30_000));
        });
      }
      await page.goto('/settings/senders');
      await page.getByText('Đang tải…').waitFor();
      mkdirSync(resolve(M5_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S1_EVIDENCE_ROOT, 'production', `sender-configs-loading-${viewport.name}.png`), fullPage: true });
    });

    test(`sender configs — empty — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route(SENDER_CONFIGS_ENDPOINT, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_SENDER_LIST }) : route.continue()));
      await page.route(SENDING_POLICY_ENDPOINT, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_POLICY }) : route.continue()));
      await page.goto('/settings/senders');
      await page.getByRole('heading', { name: 'Chưa có cấu hình gửi' }).waitFor();
      mkdirSync(resolve(M5_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S1_EVIDENCE_ROOT, 'production', `sender-configs-empty-${viewport.name}.png`), fullPage: true });
    });

    test(`sender configs — error — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      for (const endpoint of [SENDER_CONFIGS_ENDPOINT, SENDING_POLICY_ENDPOINT]) {
        await page.route(endpoint, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: SERVER_PROBLEM }) : route.continue()));
      }
      await page.goto('/settings/senders');
      await page.locator('.permission-denied-card').waitFor();
      mkdirSync(resolve(M5_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S1_EVIDENCE_ROOT, 'production', `sender-configs-error-${viewport.name}.png`), fullPage: true });
    });

    test(`sender configs — success (with data) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await createVisualSender(page, `visual-sender-${viewport.name}-${Date.now()}`);
      await page.goto('/settings/senders');
      await page.locator('.config-master-list button').first().waitFor();
      mkdirSync(resolve(M5_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S1_EVIDENCE_ROOT, 'production', `sender-configs-success-${viewport.name}.png`), fullPage: true });
    });

    test(`sender configs — create overlay — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.goto('/settings/senders');
      await page.getByRole('button', { name: 'Thêm cấu hình' }).click();
      await page.getByRole('heading', { name: 'Thêm cấu hình gửi' }).waitFor();
      mkdirSync(resolve(M5_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S1_EVIDENCE_ROOT, 'production', `sender-configs-create-overlay-${viewport.name}.png`), fullPage: true });
    });

    test(`sender configs — permission_denied (real viewer role) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, VIEWER_EMAIL);
      await page.goto('/settings/senders');
      await page.locator('.permission-denied-card').waitFor();
      mkdirSync(resolve(M5_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S1_EVIDENCE_ROOT, 'production', `sender-configs-permission-denied-${viewport.name}.png`), fullPage: true });
    });

    test(`sending policy — loading — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      for (const endpoint of [SENDER_CONFIGS_ENDPOINT, SENDING_POLICY_ENDPOINT]) {
        await page.route(endpoint, async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          await new Promise((keepPending) => setTimeout(keepPending, 30_000));
        });
      }
      await page.goto('/settings/policy');
      await page.getByRole('status').getByText('Đang tải…').waitFor();
      mkdirSync(resolve(M5_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S1_EVIDENCE_ROOT, 'production', `sending-policy-loading-${viewport.name}.png`), fullPage: true });
    });

    test(`sending policy — empty (no default set) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route(SENDER_CONFIGS_ENDPOINT, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_SENDER_LIST }) : route.continue()));
      await page.route(SENDING_POLICY_ENDPOINT, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_POLICY }) : route.continue()));
      await page.goto('/settings/policy');
      await page.getByRole('heading', { name: 'Chính sách gửi mặc định' }).waitFor();
      mkdirSync(resolve(M5_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S1_EVIDENCE_ROOT, 'production', `sending-policy-empty-${viewport.name}.png`), fullPage: true });
    });

    test(`sending policy — error — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      for (const endpoint of [SENDER_CONFIGS_ENDPOINT, SENDING_POLICY_ENDPOINT]) {
        await page.route(endpoint, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: SERVER_PROBLEM }) : route.continue()));
      }
      await page.goto('/settings/policy');
      await page.locator('.permission-denied-card').waitFor();
      mkdirSync(resolve(M5_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S1_EVIDENCE_ROOT, 'production', `sending-policy-error-${viewport.name}.png`), fullPage: true });
    });

    test(`sending policy — success (with sender data) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const created = await createVisualSender(page, `visual-policy-sender-${viewport.name}-${Date.now()}`);
      await verifyAndSetDefaultSender(page, created.id, `policy-reply-${viewport.name}@example.test`);
      await page.goto('/settings/policy');
      // Wait on the SELECTED default, not just the heading: the heading renders
      // even while the fetch is pending, so waiting on it would photograph the
      // empty form and label it success.
      await expect(page.locator('.default-policy-grid select')).not.toHaveValue('');
      mkdirSync(resolve(M5_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S1_EVIDENCE_ROOT, 'production', `sending-policy-success-${viewport.name}.png`), fullPage: true });
    });

    test(`sending policy — permission_denied (real viewer role) — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, VIEWER_EMAIL);
      await page.goto('/settings/policy');
      await page.locator('.permission-denied-card').waitFor();
      mkdirSync(resolve(M5_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S1_EVIDENCE_ROOT, 'production', `sending-policy-permission-denied-${viewport.name}.png`), fullPage: true });
    });
  }
});

// M5-S2 (Campaign scheduling): scheduleSend overlay ported from the handoff
// with real zone list/preview/audience counts (BR-SCH-001..004, BR-GEN-003)
// and the compose screen's `scheduled` banner with a lock-window countdown
// (BR-SCH-005/008). Production only -- the handoff's scheduleSend is a
// static mock with two hardcoded zones and a toast-only CTA, so none of
// this node's real states exist in its DOM, same reasoning as M4-S3/M4-S4
// above. Reuses seedVariablePolicyFixture/createDraftWithFixture verbatim.
const M5_S2_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M5-S2-schedule');

async function scheduleDraftViaApi(page: import('@playwright/test').Page, draftId: string, localDateTime: string, timeZone: string) {
  return page.evaluate(async ({ draftId, localDateTime, timeZone }) => {
    const base = '/api/v1';
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() };
    const response = await fetch(`${base}/campaigns/${draftId}/schedule`, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify({ localDateTime, timeZone }),
    });
    return response.json() as Promise<{ scheduledAtUtc: string }>;
  }, { draftId, localDateTime, timeZone });
}

/** `YYYY-MM-DDTHH:mm` in UTC, minutesFromNow ahead -- safely clear of the default 120s min lead. */
function nearFutureLocalDateTimeUtc(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString().slice(0, 16);
}

test.describe('Visual evidence: M5-S2 scheduleSend overlay + compose scheduled banner (production only, no handoff baseline for the real behavior)', () => {
  for (const viewport of VIEWPORTS) {
    test(`scheduleSend — idle, real zone list and live preview — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-sched-idle-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual sched idle ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Hẹn giờ' }).click();
      await page.getByRole('heading', { name: 'Hẹn thời gian gửi' }).waitFor();
      await page.locator('.schedule-grid input[type="date"]').fill('2026-12-24');
      await page.locator('.schedule-grid input[type="time"]').fill('08:30');
      await page.locator('.schedule-grid select').selectOption('Asia/Ho_Chi_Minh');
      await page.getByText('Giờ UTC: 2026-12-24 01:30', { exact: false }).waitFor();
      mkdirSync(resolve(M5_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S2_EVIDENCE_ROOT, 'production', `schedule-send-idle-${viewport.name}.png`) });
    });

    test(`scheduleSend — submitting, CTA disabled and busy — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-sched-busy-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual sched busy ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Hẹn giờ' }).click();
      await page.getByRole('heading', { name: 'Hẹn thời gian gửi' }).waitFor();
      await page.locator('.schedule-grid input[type="date"]').fill('2026-12-24');
      await page.locator('.schedule-grid input[type="time"]').fill('08:30');
      await page.locator('.schedule-grid select').selectOption('UTC');
      await page.locator('.confirm-check input').click();
      // Same technique as M4-S4's sendConfirm-sending capture: hold the
      // request open so "Đang lên lịch…" is still on screen at shutter time.
      await page.route('**/api/v1/campaigns/*/schedule', async () => {
        await new Promise((keepPending) => setTimeout(keepPending, 30_000));
      });
      await page.getByRole('button', { name: /^Lên lịch gửi \d+ email$/ }).click();
      await page.getByRole('button', { name: 'Đang lên lịch…' }).waitFor();
      mkdirSync(resolve(M5_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S2_EVIDENCE_ROOT, 'production', `schedule-send-submitting-${viewport.name}.png`) });
    });

    test(`scheduleSend — DST gap refused, human copy with one-click suggested time — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-sched-dst-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual sched dst ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Hẹn giờ' }).click();
      await page.getByRole('heading', { name: 'Hẹn thời gian gửi' }).waitFor();
      // Europe/Berlin's 2024 spring-forward gap -- same fixture as
      // apps/api's schedule-time.test.ts and campaign-schedule-http.test.ts.
      await page.locator('.schedule-grid input[type="date"]').fill('2024-03-31');
      await page.locator('.schedule-grid input[type="time"]').fill('02:30');
      await page.locator('.schedule-grid select').selectOption('Europe/Berlin');
      await page.locator('.confirm-check input').click();
      await page.getByRole('button', { name: /^Lên lịch gửi \d+ email$/ }).click();
      await page.getByText('không tồn tại do chuyển giờ mùa hè').waitFor();
      await page.getByRole('button', { name: /^Dùng giờ gợi ý: 2024-03-31 01:30$/ }).waitFor();
      mkdirSync(resolve(M5_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S2_EVIDENCE_ROOT, 'production', `schedule-send-dst-error-${viewport.name}.png`) });
    });

    test(`scheduleSend — inside the minimum lead, human copy with the computed window — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-sched-lead-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual sched lead ${viewport.name} ${Date.now()}`, fixture);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.waitForSelector('.compose-grid');
      await page.getByRole('button', { name: 'Hẹn giờ' }).click();
      await page.getByRole('heading', { name: 'Hẹn thời gian gửi' }).waitFor();
      const tooSoon = nearFutureLocalDateTimeUtc(0); // now, in UTC -- inside the 2-minute minimum lead
      await page.locator('.schedule-grid input[type="date"]').fill(tooSoon.slice(0, 10));
      await page.locator('.schedule-grid input[type="time"]').fill(tooSoon.slice(11, 16));
      await page.locator('.schedule-grid select').selectOption('UTC');
      await page.locator('.confirm-check input').click();
      await page.getByRole('button', { name: /^Lên lịch gửi \d+ email$/ }).click();
      await page.getByText('Thời gian gửi phải từ').waitFor();
      mkdirSync(resolve(M5_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S2_EVIDENCE_ROOT, 'production', `schedule-send-lead-time-error-${viewport.name}.png`) });
    });

    test(`compose — scheduled banner shows time, zone and a live lock countdown — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-sched-banner-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual sched banner ${viewport.name} ${Date.now()}`, fixture);
      const localDateTime = nearFutureLocalDateTimeUtc(20);
      const { scheduledAtUtc } = await scheduleDraftViaApi(page, draft.id, localDateTime, 'UTC');
      // Fixed 10 minutes before the send instant -- well outside the 120s
      // lock window, so both actions stay enabled with a deterministic label.
      await page.clock.setFixedTime(new Date(new Date(scheduledAtUtc).getTime() - 10 * 60_000));
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.getByText('Chiến dịch đã được lên lịch gửi.').waitFor();
      await expect(page.getByRole('button', { name: 'Đổi giờ' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Hủy lịch' })).toBeEnabled();
      mkdirSync(resolve(M5_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S2_EVIDENCE_ROOT, 'production', `compose-scheduled-banner-${viewport.name}.png`) });
    });

    test(`compose — inside the lock window, "Đổi giờ"/"Hủy lịch" disable themselves — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const fixture = await seedVariablePolicyFixture(page, `visual-sched-locked-${viewport.name}-${Date.now()}`, false);
      const draft = await createDraftWithFixture(page, `Visual sched locked ${viewport.name} ${Date.now()}`, fixture);
      const localDateTime = nearFutureLocalDateTimeUtc(20);
      const { scheduledAtUtc } = await scheduleDraftViaApi(page, draft.id, localDateTime, 'UTC');
      // Fixed 60 seconds before the send instant -- inside the default
      // 120s SCHEDULE_LOCK_WINDOW_SECONDS -- BR-SCH-005: the client must not
      // offer an action the server would 409.
      await page.clock.setFixedTime(new Date(new Date(scheduledAtUtc).getTime() - 60_000));
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.getByText('Đã trong thời gian khóa lịch').waitFor();
      await expect(page.getByRole('button', { name: 'Đổi giờ' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Hủy lịch' })).toBeDisabled();
      mkdirSync(resolve(M5_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S2_EVIDENCE_ROOT, 'production', `compose-scheduled-locked-${viewport.name}.png`) });
    });
  }
});

// M5-S3 (campaign send): production-only capture of the compose screen's
// sending/completed/partial_failed/failed banners and the stop-send
// confirmation. No HTTP endpoint can drive a campaign into these states --
// M5-S3 owns the validate/partition/send/aggregate transition, not the API
// surface -- so this reuses M6-S2's out-of-process-script precedent
// (seed-notification-fixture.mjs) instead of page.evaluate(fetch): see
// apps/worker/scripts/seed-campaign-send-fixture.mjs, which runs the real
// DAG functions against the same PostgreSQL/Redis/Mailpit the stack
// uses. No handoff baseline exists for any of these states (the handoff's
// compose screen has no send-progress banner at all), so every capture here
// is "production only", matching M4-S4/M5-S2 above.
const M5_S3_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M5-S3-send');
const WORKER_ROOT = resolve(__dirname, '../../worker');

async function seedSendFixture(page: import('@playwright/test').Page, label: string, count: number) {
  const fixture = await page.evaluate(async ({ label, count }) => {
    const base = '/api/v1';
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
    const template = await fetch(`${base}/templates`, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ name: `${label}-template`, subject: 'Hi {{first_name}}', html: '<p>{{first_name}}</p>' }),
    }).then((result) => result.json() as Promise<{ id: string }>);
    const published = await fetch(`${base}/templates/${template.id}/publish`, { method: 'POST', credentials: 'include', headers })
      .then((result) => result.json() as Promise<{ id: string }>);
    const list = await fetch(`${base}/recipient-lists`, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify({ name: `${label}-list` }),
    }).then((result) => result.json() as Promise<{ id: string }>);
    const recipientIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const recipient = await fetch(`${base}/recipients`, {
        method: 'POST', credentials: 'include', headers, body: JSON.stringify({ email: `${label}-r${i}@acme.vn`, firstName: 'Minh An' }),
      }).then((result) => result.json() as Promise<{ id: string }>);
      recipientIds.push(recipient.id);
    }
    await fetch(`${base}/recipient-lists/${list.id}/members`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ recipientIds }) });
    return { templateId: template.id, templateVersionId: published.id, listId: list.id, templateName: `${label}-template`, recipientIds };
  }, { label, count });
  trackFixture('templates', fixture.templateId);
  trackFixture('recipient-lists', fixture.listId);
  for (const recipientId of fixture.recipientIds) trackFixture('recipients', recipientId);
  return fixture;
}

/**
 * A known, low-frequency race, not something this function can close on its
 * own: this genuinely queues the campaign (createDraftWithFixture now always
 * gives the draft a real verified sender, so this POST actually validates and
 * freezes it -- it used to fail silently since nothing checked the response),
 * and the packaged stack's own scheduler+worker containers are live the whole
 * time this suite runs against them. `queued_campaign_executions()` resumes
 * ANY due execution, including one this suite deliberately left half-sent to
 * photograph the "sending" banner (seedCampaignSend below never calls
 * aggregateExecution for that target state on purpose) -- so if a scheduler
 * tick (EOW_SCHEDULER_TICK_MS, 60s by default) lands in the narrow window
 * before the assertion/screenshot, the real worker can finish the campaign
 * out from under the test, and a "sending" capture reads "completed" instead.
 * Observed twice in ~40 send-state tests across one full run; not something a
 * fixed sleep or a bigger timeout closes, since the tick is on its own clock.
 */
async function sendDraftViaApi(page: import('@playwright/test').Page, draftId: string) {
  return page.evaluate(async (draftId) => {
    const base = '/api/v1';
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() };
    await fetch(`${base}/campaigns/${draftId}/send`, { method: 'POST', credentials: 'include', headers });
  }, draftId);
}

/** Spawns `process.execPath --import tsx` for the same Windows/pnpm-shim reason M6-S2's seedNotification does. */
function seedCampaignSend(campaignId: string, targetState: 'sending' | 'completed' | 'partial_failed' | 'failed', failEmailPrefix?: string) {
  const args = ['--import', 'tsx', 'scripts/seed-campaign-send-fixture.mjs', campaignId, targetState, ...(failEmailPrefix ? [failEmailPrefix] : [])];
  execFileSync(process.execPath, args, { cwd: WORKER_ROOT, stdio: 'pipe' });
}

test.describe('Visual evidence: M5-S3 compose send banners + stop-send confirmation (production only, no handoff baseline exists)', () => {
  // The two "sending" captures race the real worker, which can finish the
  // campaign between the fixture forcing `sending` and the page rendering --
  // the failure shows "Đã gửi xong." where the test waits for "Đang gửi
  // email…". Confirmed from the error-context artifact on 2026-08-26, when the
  // failing viewport moved between runs (tablet, then mobile), which is what a
  // race looks like and what a viewport-specific defect does not.
  //
  // Retry rather than a longer timeout: the worker tick is on its own clock,
  // so waiting longer only makes the wrong state more certain, as the note
  // above sendDraftViaApi already says. The three terminal-state captures in
  // this block are not racy and simply never use the retries.
  test.describe.configure({ retries: 2 });
  for (const viewport of VIEWPORTS) {
    test(`compose — sending banner, real mid-flight counts and stop-send action — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const label = `visual-send-sending-${viewport.name}-${Date.now()}`;
      const fixture = await seedSendFixture(page, label, 4);
      const draft = await createDraftWithFixture(page, `Visual send sending ${viewport.name} ${Date.now()}`, fixture);
      await sendDraftViaApi(page, draft.id);
      seedCampaignSend(draft.id, 'sending');
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.getByText('Đang gửi email…').waitFor();
      await expect(page.getByRole('button', { name: 'Dừng gửi' })).toBeEnabled();
      // getCampaignProgress resolves asynchronously after the static status
      // label already renders (D-78: a green wait-for-text alone captured an
      // empty banner here on the first pass) -- wait for the real counts
      // themselves, not just the label, before the shutter.
      await page.locator('.frozen-banner .send-summary').waitFor();
      mkdirSync(resolve(M5_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S3_EVIDENCE_ROOT, 'production', `compose-sending-banner-${viewport.name}.png`) });
    });

    test(`compose — completed banner, no stop-send action — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const label = `visual-send-completed-${viewport.name}-${Date.now()}`;
      const fixture = await seedSendFixture(page, label, 2);
      const draft = await createDraftWithFixture(page, `Visual send completed ${viewport.name} ${Date.now()}`, fixture);
      await sendDraftViaApi(page, draft.id);
      seedCampaignSend(draft.id, 'completed');
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.getByText('Đã gửi xong.').waitFor();
      await expect(page.getByRole('button', { name: 'Dừng gửi' })).toHaveCount(0);
      await page.locator('.frozen-banner .send-summary').waitFor();
      mkdirSync(resolve(M5_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S3_EVIDENCE_ROOT, 'production', `compose-completed-banner-${viewport.name}.png`) });
    });

    test(`compose — partial_failed banner, failed count visible — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const label = `visual-send-partial-${viewport.name}-${Date.now()}`;
      const fixture = await seedSendFixture(page, label, 3);
      const draft = await createDraftWithFixture(page, `Visual send partial ${viewport.name} ${Date.now()}`, fixture);
      await sendDraftViaApi(page, draft.id);
      seedCampaignSend(draft.id, 'partial_failed', `${label}-r0`);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.getByText('Đã gửi xong, có một phần lỗi.').waitFor();
      await page.locator('.frozen-banner .send-summary').waitFor();
      mkdirSync(resolve(M5_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S3_EVIDENCE_ROOT, 'production', `compose-partial-failed-banner-${viewport.name}.png`) });
    });

    test(`compose — failed banner — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const label = `visual-send-failed-${viewport.name}-${Date.now()}`;
      const fixture = await seedSendFixture(page, label, 2);
      const draft = await createDraftWithFixture(page, `Visual send failed ${viewport.name} ${Date.now()}`, fixture);
      await sendDraftViaApi(page, draft.id);
      seedCampaignSend(draft.id, 'failed', `${label}-r`);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.getByText('Gửi thất bại.').waitFor();
      await page.locator('.frozen-banner .send-summary').waitFor();
      mkdirSync(resolve(M5_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S3_EVIDENCE_ROOT, 'production', `compose-failed-banner-${viewport.name}.png`) });
    });

    test(`compose — stop-send confirmation warns already-sent email cannot be recalled — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const label = `visual-send-stop-${viewport.name}-${Date.now()}`;
      const fixture = await seedSendFixture(page, label, 4);
      const draft = await createDraftWithFixture(page, `Visual send stop ${viewport.name} ${Date.now()}`, fixture);
      await sendDraftViaApi(page, draft.id);
      seedCampaignSend(draft.id, 'sending');
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.getByText('Đang gửi email…').waitFor();
      await page.getByRole('button', { name: 'Dừng gửi' }).click();
      await page.getByRole('heading', { name: 'Dừng gửi chiến dịch?' }).waitFor();
      await page.getByText('không thể thu hồi', { exact: false }).waitFor();
      mkdirSync(resolve(M5_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S3_EVIDENCE_ROOT, 'production', `stop-send-confirm-${viewport.name}.png`) });
    });
  }
});

// M6-S2 (notification center): production-only capture of the AppShell bell
// and NotificationPopover overlay per PARALLEL-EXECUTION-PROTOCOL.md CP7 —
// Codex leaves this block unrun; Claude captures and individually inspects
// every image before any BR-NOT-* rule can close. No handoff baseline exists
// for this overlay (design-reference has a static mock only), so every state
// is "production only", matching the M3-GATE/M4-S1 overlay blocks above.
const M6_S2_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M6-S2-notification-center');
const NOTIFICATIONS_ENDPOINT = '**/api/v1/notifications*';
const EMPTY_NOTIFICATIONS_PAGE = JSON.stringify({ items: [], unread: 0, nextCursor: null });
const API_ROOT = resolve(__dirname, '../../api');
// Scoped away from `.notification-list`: each unread row carries an
// `<i aria-label="Chưa đọc"/>` dot and a body that can itself contain the words
// "đánh dấu đã đọc", so a by-role name lookup for either control is ambiguous.
const UNREAD_FILTER_TAB = '.notification-toolbar [role="tablist"] button:last-child';
const MARK_ALL_READ_BUTTON = '.notification-toolbar .mark-read-button';
// `is-unread` sits on the <article class="notification-card"> wrapper, not on
// the row button it contains -- and that article also carries a footer button
// ("Đánh dấu đã xử lý"), so the row itself is the article's direct child.
const UNREAD_CARD = '.notification-list .notification-card.is-unread';
const UNREAD_ROW_BUTTON = `${UNREAD_CARD} > button`;

/**
 * Notifications have no public create endpoint (BR-NOT-002: recipients are
 * resolved server-side from real trigger events, never client-supplied), so
 * unlike other overlay blocks this can't seed through `page.evaluate(fetch)`.
 * Runs the real NotificationsService out-of-process against the same
 * PostgreSQL the stack uses -- see apps/api/scripts/seed-notification-fixture.mjs.
 *
 * Plain `process.execPath`, with no `--import tsx`: that script loads apps/api's
 * *tsc build*, because D-22 applies to it exactly as it does to the API itself
 * (esbuild emits no decorator metadata, so TypeORM cannot type the entities).
 * `pnpm build` is therefore a prerequisite of this suite -- see
 * playwright.config.ts. Not `pnpm exec` either: on Windows pnpm is a .CMD shim,
 * which execFileSync cannot resolve from a bare name in the Playwright worker's
 * environment (spawnSync pnpm ENOENT).
 */
function seedNotification(overrides: { type: string; severity: 'info' | 'success' | 'warning' | 'critical'; title: string; body: string; category: string; messageKey?: string; deepLinkRoute?: string | null; email?: string }) {
  execFileSync(process.execPath, ['scripts/seed-notification-fixture.mjs', JSON.stringify({ email: DEMO_EMAIL, ...overrides })], { cwd: API_ROOT, stdio: 'pipe' });
}

test.describe('Visual evidence: M6-S2 notification center (production only, no handoff baseline exists)', () => {
  for (const viewport of VIEWPORTS) {
    test(`notification popover — loading — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route(NOTIFICATIONS_ENDPOINT, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        await new Promise((keepPending) => setTimeout(keepPending, 30_000));
      });
      await page.locator('.notification-trigger').click();
      await page.getByText('Đang tải thông báo…').waitFor();
      mkdirSync(resolve(M6_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_S2_EVIDENCE_ROOT, 'production', `popover-loading-${viewport.name}.png`), animations: 'disabled' });
    });

    test(`notification popover — empty — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      await page.route(NOTIFICATIONS_ENDPOINT, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_NOTIFICATIONS_PAGE })
          : route.continue(),
      );
      await page.locator('.notification-trigger').click();
      await page.getByText('Chưa có thông báo nào').waitFor();
      mkdirSync(resolve(M6_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_S2_EVIDENCE_ROOT, 'production', `popover-empty-${viewport.name}.png`), animations: 'disabled' });
    });

    test(`notification popover — unread badge + all/unread filters — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      seedNotification({ type: 'import_completed', severity: 'success', title: `Import xong ${viewport.name}`, body: 'Đã xử lý xong tệp người nhận visual-evidence.csv.', category: 'import', messageKey: 'import.completed', deepLinkRoute: null });
      seedNotification({ type: 'bulk_update_failed', severity: 'critical', title: `Cập nhật hàng loạt thất bại ${viewport.name}`, body: 'Không thể hoàn tất cho 2 người nhận.', category: 'critical_delivery_failure', messageKey: 'bulk_update.failed', deepLinkRoute: null });
      await page.reload();
      await page.locator('.notification-badge').waitFor();
      await page.locator('.notification-trigger').click();
      await page.locator('.notification-list button').first().waitFor();
      mkdirSync(resolve(M6_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_S2_EVIDENCE_ROOT, 'production', `popover-all-unread-badge-${viewport.name}.png`), animations: 'disabled' });

      await page.locator(UNREAD_FILTER_TAB).click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: resolve(M6_S2_EVIDENCE_ROOT, 'production', `popover-unread-filter-${viewport.name}.png`), animations: 'disabled' });
    });

    test(`notification popover — mark one then mark all read is idempotent — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      seedNotification({ type: 'import_completed', severity: 'success', title: `Mark-one ${viewport.name}`, body: 'Không có deep link, ở lại popover sau khi đọc.', category: 'import', messageKey: 'import.completed', deepLinkRoute: null });
      seedNotification({ type: 'import_completed', severity: 'success', title: `Mark-all ${viewport.name}`, body: 'Sẽ được đánh dấu đã đọc hàng loạt.', category: 'import', messageKey: 'import.completed', deepLinkRoute: null });
      await page.reload();
      await page.locator('.notification-badge').waitFor();
      await page.locator('.notification-trigger').click();
      await page.locator(UNREAD_ROW_BUTTON).first().click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: resolve(M6_S2_EVIDENCE_ROOT, 'production', `popover-mark-one-read-${viewport.name}.png`), animations: 'disabled' });

      await page.locator(MARK_ALL_READ_BUTTON).click();
      await page.waitForTimeout(200);
      // BR-NOT-004: mark-all is idempotent. Once every row is read the control
      // disables itself, so a second real click is impossible through the UI —
      // fire the same request again directly to prove the second call is a no-op.
      const secondCall = await page.evaluate(async () => {
        const csrf = document.cookie.split('; ').find((part) => part.startsWith('eow_csrf='))?.split('=')[1] ?? '';
        const response = await fetch('/api/v1/notifications/read-all', { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
        return response.status;
      });
      expect(secondCall).toBe(204);
      await page.reload();
      await page.locator('.notification-trigger').click();
      await page.locator(MARK_ALL_READ_BUTTON).waitFor();
      await expect(page.locator(MARK_ALL_READ_BUTTON)).toBeDisabled();
      await expect(page.locator(UNREAD_CARD)).toHaveCount(0);
      await page.waitForTimeout(200);
      await expect(page.locator('.notification-badge')).toHaveCount(0);
      await page.screenshot({ path: resolve(M6_S2_EVIDENCE_ROOT, 'production', `popover-mark-all-read-${viewport.name}.png`), animations: 'disabled' });
    });

    test(`notification deep link — navigates and closes the popover — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const deepLinkTitle = `Deep link ${viewport.name}`;
      seedNotification({ type: 'import_completed', severity: 'success', title: deepLinkTitle, body: 'Điều hướng tới route ổn định.', category: 'import', messageKey: 'import.completed', deepLinkRoute: '/recipients' });
      await page.reload();
      await page.locator('.notification-badge').waitFor();
      await page.locator('.notification-trigger').click();
      // Target this run's own row by title: earlier states in this block leave
      // unread rows behind, and only this one carries a deep_link_route.
      await page.locator('.notification-list button').filter({ hasText: deepLinkTitle }).first().click();
      await page.waitForURL(/\/recipients$/);
      await expect(page.locator('.notification-popover')).toHaveCount(0);
      mkdirSync(resolve(M6_S2_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_S2_EVIDENCE_ROOT, 'production', `popover-deep-link-navigated-${viewport.name}.png`), fullPage: true, animations: 'disabled' });
    });
  }
});

const M5_S4_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M5-S4-webhook');

/** Spawns `process.execPath --import tsx`, same reason seedCampaignSend does. */
function seedCampaignWebhookDelivered(campaignId: string, deliveredCount?: number) {
  const args = ['scripts/seed-campaign-webhook-fixture.mjs', campaignId, ...(deliveredCount !== undefined ? [String(deliveredCount)] : [])];
  execFileSync(process.execPath, args, {
    cwd: WORKER_ROOT,
    stdio: 'pipe',
    env: { ...process.env, PROVIDER_WEBHOOK_SECRET: 'm5s4-e2e-visual-evidence-webhook-secret-32chars' },
  });
}

test.describe('Visual evidence: M5-S4 delivered/bounced counts on the compose banner (production only, no handoff baseline exists)', () => {
  for (const viewport of VIEWPORTS) {
    test(`compose — completed banner with real delivered and bounced counts from the webhook route — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const label = `visual-webhook-${viewport.name}-${Date.now()}`;
      const fixture = await seedSendFixture(page, label, 4);
      const draft = await createDraftWithFixture(page, `Visual webhook ${viewport.name} ${Date.now()}`, fixture);
      await sendDraftViaApi(page, draft.id);
      seedCampaignSend(draft.id, 'completed');
      // A18/D-105: 2 of the 4 submitted messages are marked delivered, 2
      // bounced, through the REAL webhook HTTP route (signed HMAC, exactly
      // as a provider would call it) -- not a raw status UPDATE. This is
      // what proves the "Da nhan" tile and the still-correct "Da gui" tile
      // (which must NOT have dropped now that these rows left 'submitted').
      seedCampaignWebhookDelivered(draft.id, 2);
      await page.goto(`/campaigns/${draft.id}/edit`);
      await page.getByText('Đã gửi xong.').waitFor();
      await page.locator('.frozen-banner .send-summary').waitFor();
      // D-105's own regression, made visible on screen: "Da gui" must read 4
      // (every message that ever left the building, including the 2 that
      // later bounced), not 2 (which is what a naive counts.submitted
      // passthrough would show now that those rows are 'delivered'/'bounced').
      await expect(page.locator('.send-summary').getByText('Đã gửi', { exact: true }).locator('xpath=following-sibling::b')).toHaveText('4');
      await expect(page.locator('.send-summary').getByText('Đã nhận', { exact: true }).locator('xpath=following-sibling::b')).toHaveText('2');
      await expect(page.locator('.send-summary').getByText('Thất bại', { exact: true }).locator('xpath=following-sibling::b')).toHaveText('2');
      mkdirSync(resolve(M5_S4_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M5_S4_EVIDENCE_ROOT, 'production', `compose-completed-delivered-bounced-${viewport.name}.png`) });
    });
  }
});

// M6-S1 (BR-HIS-002, UI-HIS-002): the /history/:campaignId progress drawer,
// production only (the approved handoff's historyDetail overlay has no
// counterpart at a real route -- this node rebuilt its content as a page,
// design-reference/visual-acceptance.md §12). Same real-DAG fixture
// precedent as M5-S3/M5-S4 above (seed-campaign-send-fixture.mjs), not a
// mocked state.
const M6_S1_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M6-S1-realtime-progress');

test.describe('Visual evidence: M6-S1 campaign progress drawer (production only, no handoff baseline exists)', () => {
  for (const viewport of VIEWPORTS) {
    test(`history drawer — real mid-flight counts and ETA — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const label = `visual-history-${viewport.name}-${Date.now()}`;
      const fixture = await seedSendFixture(page, label, 6);
      const draft = await createDraftWithFixture(page, `Visual history ${viewport.name} ${Date.now()}`, fixture);
      await sendDraftViaApi(page, draft.id);
      seedCampaignSend(draft.id, 'sending');
      await page.goto(`/campaigns/${draft.id}`);
      await page.locator('.live-send-state').waitFor();
      await page.locator('.history-stats.four').waitFor();
      mkdirSync(resolve(M6_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_S1_EVIDENCE_ROOT, 'production', `history-drawer-${viewport.name}.png`), fullPage: true });
    });
  }

  test('history drawer — reconnecting state — production — desktop-1440x900', async ({ page, context }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, DEMO_EMAIL);
    const label = `visual-history-reconnect-${Date.now()}`;
    const fixture = await seedSendFixture(page, label, 3);
    const draft = await createDraftWithFixture(page, `Visual history reconnect ${Date.now()}`, fixture);
    await sendDraftViaApi(page, draft.id);
    seedCampaignSend(draft.id, 'sending');
    // Armed before the drawer is opened: the route has to exist before
    // subscribeToCampaigns dials, so the live connection runs through it.
    const dropSocket = await armSocketDrop(page, context);
    await page.goto(`/campaigns/${draft.id}`);
    await page.locator('.live-send-state').waitFor();
    await dropSocket();
    mkdirSync(resolve(M6_S1_EVIDENCE_ROOT, 'production'), { recursive: true });
    await page.screenshot({ path: resolve(M6_S1_EVIDENCE_ROOT, 'production', 'history-drawer-reconnecting-desktop-1440x900.png'), fullPage: true });
    await context.unroute('**/socket.io/**');
  });
});

// M6-S3 (BR-HIS-001/003/004/005/007, UI-HIS-001): the /history list,
// production only (the approved handoff's History component has no real
// route counterpart before this node -- ComingSoon stood in its place).
// Same real-DAG fixture precedent as M6-S1 above (seed-campaign-send-fixture.mjs
// -- a genuinely completed/partial_failed campaign with real
// campaign_recipient rows, not a raw status UPDATE), so the resend button
// this section also exercises has real failed rows to act on.
const M6_S3_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M6-S3-history-recovery');

test.describe('Visual evidence: M6-S3 send history list (production only, no handoff baseline exists)', () => {
  for (const viewport of VIEWPORTS) {
    test(`history list — mixed real statuses — production — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const label = `visual-hislist-${viewport.name}-${Date.now()}`;
      const fixture = await seedSendFixture(page, label, 4);
      const draft = await createDraftWithFixture(page, `Visual hislist ${viewport.name} ${Date.now()}`, fixture);
      await sendDraftViaApi(page, draft.id);
      seedCampaignSend(draft.id, 'partial_failed', `${label}-r0`);
      await page.goto('/campaigns');
      await page.locator('.history-table').waitFor();
      await page.getByText('Visual hislist').first().waitFor();
      mkdirSync(resolve(M6_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_S3_EVIDENCE_ROOT, 'production', `history-list-${viewport.name}.png`), fullPage: true });
    });
  }

  test('history list — empty state — production — desktop-1440x900', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, DEMO_EMAIL);
    await page.goto('/campaigns');
    await page.route('**/api/v1/campaigns/history*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ serverTime: new Date().toISOString(), items: [], nextCursor: null }) }));
    await page.reload();
    await page.getByText('Chưa có chiến dịch nào.').waitFor();
    mkdirSync(resolve(M6_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
    await page.screenshot({ path: resolve(M6_S3_EVIDENCE_ROOT, 'production', 'history-list-empty-desktop-1440x900.png'), fullPage: true });
  });

  test('history list — error state — production — desktop-1440x900', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, DEMO_EMAIL);
    await page.route('**/api/v1/campaigns/history*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ title: 'Internal error' }) }));
    await page.goto('/campaigns');
    await page.getByText('Không thể tải lịch sử gửi').waitFor();
    mkdirSync(resolve(M6_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
    await page.screenshot({ path: resolve(M6_S3_EVIDENCE_ROOT, 'production', 'history-list-error-desktop-1440x900.png'), fullPage: true });
  });

  test('history list — filter dialog open — production — desktop-1440x900', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, DEMO_EMAIL);
    await page.goto('/campaigns');
    await page.locator('.history-table, .module-card').first().waitFor();
    await page.getByRole('button', { name: 'Bộ lọc' }).click();
    await page.getByRole('dialog', { name: 'Bộ lọc chiến dịch' }).waitFor();
    mkdirSync(resolve(M6_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
    await page.screenshot({ path: resolve(M6_S3_EVIDENCE_ROOT, 'production', 'history-filter-dialog-desktop-1440x900.png'), fullPage: true });
  });

  test('history list — resend confirm and success — production — desktop-1440x900', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, DEMO_EMAIL);
    const label = `visual-resend-${Date.now()}`;
    const fixture = await seedSendFixture(page, label, 3);
    const draft = await createDraftWithFixture(page, `Visual resend ${Date.now()}`, fixture);
    await sendDraftViaApi(page, draft.id);
    seedCampaignSend(draft.id, 'partial_failed', `${label}-r0`);
    await page.goto('/campaigns');
    await page.getByText('Visual resend').first().locator('..').locator('..').getByRole('button', { name: 'Gửi lại' }).click();
    await page.getByRole('dialog', { name: 'Gửi lại email' }).waitFor();
    mkdirSync(resolve(M6_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
    await page.screenshot({ path: resolve(M6_S3_EVIDENCE_ROOT, 'production', 'history-resend-confirm-desktop-1440x900.png'), fullPage: true });
    await page.getByRole('button', { name: /Gửi lại \d+ email/ }).click();
    await page.getByText('Đã gửi lại email').waitFor();
    await page.screenshot({ path: resolve(M6_S3_EVIDENCE_ROOT, 'production', 'history-resend-success-desktop-1440x900.png'), fullPage: true });
  });

  test('history list — permission_denied (viewer, no campaign:read) — production — desktop-1440x900', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, VIEWER_EMAIL);
    await page.goto('/campaigns');
    // The viewer role holds campaign:read (BR-AUTH-003), so /campaigns itself
    // is reachable -- the permission boundary this node adds is history:export
    // specifically. Captured here: a viewer sees the drawer's stat tiles
    // without the drill-down/export affordances at all (hidden, not merely
    // disabled), the real BR-HIS-007 boundary this node introduces.
    await page.locator('.history-table').waitFor();
    const firstRow = page.locator('.history-table tbody tr').first();
    await firstRow.click();
    await page.locator('.live-send-state, .module-card').first().waitFor();
    await expect(page.getByRole('button', { name: 'Tải báo cáo' })).toHaveCount(0);
    mkdirSync(resolve(M6_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
    await page.screenshot({ path: resolve(M6_S3_EVIDENCE_ROOT, 'production', 'history-drawer-viewer-no-export-desktop-1440x900.png'), fullPage: true });
  });

  test('history list — export drill-down and download link — production — desktop-1440x900', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, DEMO_EMAIL);
    const label = `visual-export-${Date.now()}`;
    const fixture = await seedSendFixture(page, label, 3);
    const draft = await createDraftWithFixture(page, `Visual export ${Date.now()}`, fixture);
    await sendDraftViaApi(page, draft.id);
    seedCampaignSend(draft.id, 'partial_failed', `${label}-r0`);
    await page.goto(`/campaigns/${draft.id}`);
    await page.locator('.history-stats.four').waitFor();
    await page.getByText(/Lỗi \(tải danh sách\)/).locator('..').click();
    await page.getByText(/Tải xuống báo cáo/).waitFor();
    mkdirSync(resolve(M6_S3_EVIDENCE_ROOT, 'production'), { recursive: true });
    await page.screenshot({ path: resolve(M6_S3_EVIDENCE_ROOT, 'production', 'history-drawer-export-drilldown-desktop-1440x900.png'), fullPage: true });
  });
});

// M6-GATE (condition 3): the reconnecting state at all three viewports for
// every surface the condition names. M6-S1 captured the drawer's reconnecting
// state at desktop only; the history list and the notifications popover were
// never captured in that state at all (the popover did not have the state
// until this gate's own CP5). Same deterministic-disconnect technique as
// M6-S1's own desktop capture above -- block the transport, force the socket
// closed, wait for the real indicator.
const M6_GATE_EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M6-GATE');

/**
 * Arms a deterministic socket drop and returns the trigger. Call it before the
 * page that subscribes is opened -- the route has to be in place before
 * socket.io dials, so that the real connection is proxied through it.
 *
 * This used to reach for `window.__eowSocket`. That hatch is installed under
 * `import.meta.env.DEV` (api/realtime.ts) and is genuinely tree-shaken out of
 * the packaged bundle this suite runs against, so every reconnecting capture
 * died on "Cannot read properties of undefined". Routing the websocket needs
 * nothing from the app: `connectToServer()` proxies the real connection (the
 * socket does go live, exactly as a user's would), and closing it is the same
 * event socket.io would see if the server went away.
 *
 * `context.setOffline` is deliberately not used: it also flips
 * `navigator.onLine`, and connectionStatus() maps that to `offline`
 * ("Bạn đang ngoại tuyến") -- a different state from this one.
 */
async function armSocketDrop(
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext,
): Promise<() => Promise<void>> {
  const live: import('@playwright/test').WebSocketRoute[] = [];
  let dropped = false;
  await page.routeWebSocket(/socket\.io/, (ws) => {
    if (dropped) {
      ws.close();
      return;
    }
    ws.connectToServer();
    live.push(ws);
  });
  return async () => {
    dropped = true;
    // Also block the polling transport, or socket.io quietly re-establishes the
    // connection while the shutter is open.
    await context.route('**/socket.io/**', (route) => route.abort());
    for (const ws of live) ws.close();
    // .first(): when the notifications popover is open over the history list,
    // both independently subscribe to the same useRealtimeStatus() and both
    // correctly render their own banner -- two real elements, not ambiguity.
    await page.getByText('Đang kết nối lại…').first().waitFor({ timeout: 15_000 });
  };
}

/**
 * D-138 (M6-GATE CP6): neither HistoryScreen nor NotificationPopover nor
 * AppShell itself ever calls subscribeToCampaigns/subscribeToJobs, so on those
 * two surfaces the shared socket is only ever connected as a side effect of the
 * user having visited a campaign page first in the same session. That is
 * disclosed rather than papered over -- wiring AppShell to connect a baseline
 * socket proactively touches the already-closed subscribeToCampaigns/
 * subscribeToJobs reconnect semantics, and is a follow-up.
 *
 * So this walks the side effect the disclosure names, instead of forcing a
 * connection through a hatch that does not exist in the packaged bundle: open a
 * campaign's drawer (CampaignDetailScreen calls subscribeToCampaigns, which
 * connects the shared socket), then go back. `goBack` is a history navigation,
 * not a reload, so the socket module -- and its live connection -- survives it.
 */
async function connectSocketViaCampaignDrawer(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.history-table tbody tr').first().click();
  await page.locator('.live-send-state, .history-stats, .module-card').first().waitFor();
  await page.goBack();
  await page.locator('.history-table, .module-card').first().waitFor();
}

test.describe('Visual evidence: M6-GATE reconnecting at 3 viewports (production only)', () => {
  for (const viewport of VIEWPORTS) {
    test(`history list — reconnecting — production — ${viewport.name}`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const dropSocket = await armSocketDrop(page, context);
      await page.goto('/campaigns');
      await page.locator('.history-table, .module-card').first().waitFor();
      await connectSocketViaCampaignDrawer(page);
      await dropSocket();
      mkdirSync(resolve(M6_GATE_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_GATE_EVIDENCE_ROOT, 'production', `history-list-reconnecting-${viewport.name}.png`), fullPage: true });
      await context.unroute('**/socket.io/**');
    });

    test(`campaign drawer — reconnecting — production — ${viewport.name}`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const label = `gate-reconnect-${viewport.name}-${Date.now()}`;
      const fixture = await seedSendFixture(page, label, 3);
      const draft = await createDraftWithFixture(page, `Gate reconnect ${viewport.name} ${Date.now()}`, fixture);
      await sendDraftViaApi(page, draft.id);
      seedCampaignSend(draft.id, 'sending');
      const dropSocket = await armSocketDrop(page, context);
      await page.goto(`/campaigns/${draft.id}`);
      await page.locator('.live-send-state').waitFor();
      await dropSocket();
      mkdirSync(resolve(M6_GATE_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_GATE_EVIDENCE_ROOT, 'production', `history-drawer-reconnecting-${viewport.name}.png`), fullPage: true });
      await context.unroute('**/socket.io/**');
    });

    test(`notifications popover — reconnecting — production — ${viewport.name}`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const dropSocket = await armSocketDrop(page, context);
      await page.goto('/campaigns');
      await page.locator('.history-table, .module-card').first().waitFor();
      await connectSocketViaCampaignDrawer(page);
      await page.locator('.notification-trigger').click();
      await page.locator('.notification-toolbar').waitFor();
      await dropSocket();
      mkdirSync(resolve(M6_GATE_EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(M6_GATE_EVIDENCE_ROOT, 'production', `notifications-popover-reconnecting-${viewport.name}.png`), fullPage: true });
      await context.unroute('**/socket.io/**');
    });
  }
});
