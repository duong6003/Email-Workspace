import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * M1-S2 E2E: roles and access (BR-AUTH-003/004). Exercises the same
 * scenario EXECPLAN §7.4 states as the milestone's acceptance example --
 * "A Viewer navigating to /settings/senders sees the permission_denied
 * state, and the API returns RFC 9457 403 for the same call" -- plus
 * TC-AUTH-009 exactly (Viewer calling POST /campaigns/:id/send directly,
 * bypassing any UI hiding).
 *
 * Fixtures: apps/api/scripts/seed-demo-user.mjs (demo@acme.vn = admin,
 * demo-viewer@acme.vn = viewer; same tenant as the M1-S1 e2e/auth.spec.ts
 * fixture).
 */
const ADMIN_EMAIL = 'demo@acme.vn';
const VIEWER_EMAIL = 'demo-viewer@acme.vn';
const PASSWORD = 'Demo!Passw0rd';

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('name@mailspace.vn').fill(email);
  await page.getByPlaceholder('Nhập mật khẩu').fill(PASSWORD);
  await page.locator('button.login-submit').click();
  await page.waitForURL(/\/campaigns$/);
  // RequireAuth renders a loading state until GET /auth/me resolves, before
  // which the sidebar (and its permission-filtered nav items) don't exist
  // in the DOM yet.
  await page.waitForSelector('.sidebar');
}

/** The read-only assertions need a real template id; the viewer can list them now. */
async function firstTemplateId(page: import('@playwright/test').Page): Promise<string> {
  const response = await page.request.get('/api/v1/templates?limit=1');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.items.length, 'seeded fixtures must contain at least one template').toBeGreaterThan(0);
  return body.items[0].id;
}

test.describe('Roles and access (M1-S2)', () => {
  test("Viewer's sidebar shows only nav destinations covered by campaign:read/notification:read/session:manage (BR-AUTH-003)", async ({ page }) => {
    await signIn(page, VIEWER_EMAIL);

    const navLabels = await page.locator('.sidebar .nav-item span').allTextContents();
    // Since the Chiến dịch restructure the viewer reaches the campaign list:
    // campaign:read gets them there, and the server keeps drafts out of the
    // rows (ADR-034).
    expect(navLabels).toContain('Chiến dịch');
    // Email template joined that list with content:read
    // (073_content_read_permission.sql). The destination has to be visible or
    // the read-only editor state §5.1 requires would be unreachable; what the
    // viewer cannot do there is enforced inside the screens and by the API.
    expect(navLabels).toContain('Email template');
    expect(navLabels).not.toContain('Người nhận');
    expect(navLabels).not.toContain('Cấu hình');
  });

  test("Admin's sidebar shows every nav destination, including settings (content:manage + settings:manage)", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);

    const navLabels = await page.locator('.sidebar .nav-item span').allTextContents();
    expect(navLabels).toContain('Chiến dịch');
    expect(navLabels).toContain('Người nhận');
    expect(navLabels).toContain('Email template');
    expect(navLabels).toContain('Cấu hình');
    expect(navLabels).not.toContain('Lịch sử gửi');
  });

  test('Viewer navigating directly to /settings/senders (typed URL, not a nav click) sees the permission_denied state', async ({ page }) => {
    await signIn(page, VIEWER_EMAIL);

    await page.goto('/settings/senders');
    await expect(page.locator('.permission-denied-card')).toBeVisible();
    await expect(page.locator('.permission-denied-card .status.danger')).toContainText('Không đủ quyền truy cập');
    // The route did not silently redirect or blank-render; it stayed put
    // and rendered the denied state in place.
    await expect(page).toHaveURL(/\/settings\/senders$/);
  });

  test('Admin navigating to /settings/senders sees the normal (not denied) placeholder screen -- gating is role-specific, not blanket', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);

    await page.goto('/settings/senders');
    await expect(page.locator('.permission-denied-card')).toHaveCount(0);
    // Asserts the screen's own tab strip rather than a copy string. The old
    // assertion looked for 'Cấu hình email', a heading removed by the Cấu hình
    // consolidation (63e0aad) -- so this test was already failing before the
    // Chiến dịch work touched it.
    await expect(page.locator('.settings-tabs')).toBeVisible();
  });

  test('TC-AUTH-009: Viewer calling POST /campaigns/:id/send directly via the API (bypassing any UI hiding) gets a real RFC 9457 403, never a UI-only block', async ({ page }) => {
    await signIn(page, VIEWER_EMAIL);

    const response = await page.request.post('/api/v1/campaigns/00000000-0000-4000-8000-000000000001/send');

    expect(response.status()).toBe(403);
    expect(response.headers()['content-type']).toContain('application/problem+json');
    const body = await response.json();
    expect(body.traceId).toBeDefined();
    expect(body.status).toBe(403);
  });

  test('GET /auth/me returns a real, role-specific permission list (never client-inferred)', async ({ page }) => {
    await signIn(page, VIEWER_EMAIL);

    const response = await page.request.get('/api/v1/auth/me');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.permissions.sort()).toEqual(['campaign:read', 'content:read', 'notification:read', 'session:manage']);
  });

  test('Viewer opening the template editor sees the §5.1 read-only state -- content rendered, every editing control inert', async ({ page }) => {
    await signIn(page, VIEWER_EMAIL);

    await page.goto('/templates');
    const firstCard = page.locator('.template-card').first();
    await expect(firstCard).toBeVisible();
    // Import/drop-zone affordances are content:manage; they must not be offered.
    await expect(page.locator('.drop-zone')).toHaveCount(0);

    await page.goto(`/templates/${await firstTemplateId(page)}/edit`);

    // The explanation, and the content it explains -- not a blank screen.
    await expect(page.locator('.template-readonly-notice')).toBeVisible();
    await expect(page.locator('.template-readonly-notice b')).toContainText('chế độ chỉ đọc');
    await expect(page.locator('.template-editor-fields input').first()).toHaveJSProperty('readOnly', true);
    await expect(page.getByRole('button', { name: 'Xuất bản' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Lưu trữ' })).toBeDisabled();
  });

  test('TC-AUTH-009 for templates: a Viewer PATCHing a template directly still gets a real 403 -- content:read never implies write', async ({ page }) => {
    await signIn(page, VIEWER_EMAIL);

    const templateId = await firstTemplateId(page);
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'eow_csrf')!.value;
    const response = await page.request.patch(`/api/v1/templates/${templateId}`, {
      headers: { 'x-csrf-token': csrf, 'if-match': '"1"' },
      data: { name: 'viewer should not be able to write this' },
    });

    expect(response.status()).toBe(403);
    expect(response.headers()['content-type']).toContain('application/problem+json');
  });

  test('axe accessibility scan on the permission_denied state: no violations beyond the known pre-existing handoff contrast issue', async ({ page }) => {
    await signIn(page, VIEWER_EMAIL);
    await page.goto('/settings/senders');
    await page.waitForSelector('.permission-denied-card');

    const results = await new AxeBuilder({ page }).analyze();
    // Same pre-existing --color-text-subtle contrast finding tracked by
    // apps/web/e2e/auth.spec.ts (inherited from the handoff design tokens,
    // not introduced by this screen); tracked as the sole allowed
    // violation type here too so any *other* regression still fails.
    const unexpectedViolations = results.violations.filter((v) => v.id !== 'color-contrast');
    expect(unexpectedViolations, JSON.stringify(unexpectedViolations, null, 2)).toEqual([]);
  });
});
