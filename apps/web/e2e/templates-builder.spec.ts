import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackFixture } from './fixture-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * S3 (route builder + focus mode, ADR-041). Exercises the plan's Task 15
 * acceptance: opening the builder from the library, Back's four-layer
 * confirmation never silently dropping a draft, and an imported-origin
 * template staying on /edit rather than being swept into /build.
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
];
const EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-31-mailcraft-builder/evidence/s3-visual');

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('name@mailspace.vn').fill(email);
  await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
  await page.locator('button.login-submit').click();
  await page.waitForURL(/\/campaigns$/);
  await page.waitForSelector('.sidebar');
}

/** Raw POST rather than the api/templates.ts client: that client's createTemplate() has no `origin` param (S4 will add a "Tạo bằng Mailcraft" flow that needs it) -- the server already accepts it (S1), which is all this fixture needs. */
async function createBuilderTemplate(page: import('@playwright/test').Page, name: string): Promise<string> {
  const response = await page.evaluate(async (templateName) => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const result = await fetch('/api/v1/templates', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ name: templateName, subject: 'Chào mừng', origin: 'builder' }),
    });
    return { status: result.status, body: await result.text() };
  }, name);
  if (response.status !== 201) throw new Error(`Could not create builder-origin fixture: ${response.status} ${response.body}`);
  return (JSON.parse(response.body) as { id: string }).id;
}

test.describe('S3: builder route and focus mode', () => {
  test('opening a builder-origin template from the library goes to /build, not /edit', async ({ page }) => {
    await signIn(page, DEMO_EMAIL);
    const name = `s3-open-${Date.now()}`;
    const id = await createBuilderTemplate(page, name);
    trackFixture('templates', id);
    await page.goto('/templates');
    await page.getByRole('button', { name: `Tùy chọn template ${name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Chỉnh sửa template', exact: true }).click();
    await page.waitForURL(new RegExp(`/templates/${id}/build$`));
    await page.locator('.focus-header').waitFor();
    // Focus mode: no sidebar, no page-header -- the whole point of ADR-041.
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await expect(page.locator('.page-header')).toHaveCount(0);
  });

  test('Back with an unsaved edit shows the Save/Discard/Stay dialog, and "Ở lại" keeps the draft', async ({ page }) => {
    await signIn(page, DEMO_EMAIL);
    const name = `s3-back-${Date.now()}`;
    const id = await createBuilderTemplate(page, name);
    trackFixture('templates', id);
    await page.goto(`/templates/${id}/build`);
    await page.locator('.focus-header').waitFor();

    const nameInput = page.locator('.builder-title-field input');
    await nameInput.fill(`${name}-edited`);
    // Give the debounce a moment to queue the patch as `pending` without
    // letting it flush to `saved` -- the dialog only appears while dirty.
    await expect(page.locator('.focus-header-title .save-state')).toHaveText(/Đang chờ lưu…|Đang lưu…/);

    await page.locator('.focus-header-back').click();
    await page.getByRole('heading', { name: 'Bỏ thay đổi chưa lưu?' }).waitFor();
    await page.getByRole('button', { name: 'Ở lại' }).click();
    await expect(page.locator('.action-overlay')).toHaveCount(0);
    // Still on /build, and the edited name survived -- Back never silently discards.
    await expect(page).toHaveURL(new RegExp(`/templates/${id}/build$`));
    await expect(nameInput).toHaveValue(`${name}-edited`);
  });

  test('an imported-origin template still opens at /edit, never redirected to /build', async ({ page }) => {
    await signIn(page, DEMO_EMAIL);
    const name = `s3-imported-${Date.now()}`;
    const created = await page.evaluate(async (templateName) => {
      const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
      const result = await fetch('/api/v1/templates', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ name: templateName, subject: 'Chào mừng', html: '<p>Nội dung an toàn</p>' }),
      });
      return { status: result.status, body: await result.text() };
    }, name);
    if (created.status !== 201) throw new Error(`Could not create imported fixture: ${created.status} ${created.body}`);
    const { id } = JSON.parse(created.body) as { id: string };
    trackFixture('templates', id);

    await page.goto('/templates');
    await page.getByRole('button', { name: `Tùy chọn template ${name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Chỉnh sửa template', exact: true }).click();
    await page.waitForURL(new RegExp(`/templates/${id}/edit$`));
    await page.locator('.template-editor-workspace').waitFor();

    // The safety-net redirect the other direction: visiting /edit directly
    // for a builder-origin template must bounce to /build, never the reverse.
    const builderId = await createBuilderTemplate(page, `s3-redirect-${Date.now()}`);
    trackFixture('templates', builderId);
    await page.goto(`/templates/${builderId}/edit`);
    await page.waitForURL(new RegExp(`/templates/${builderId}/build$`));
  });

  test('dark mode: focus-mode chrome goes dark, the email canvas stays light', async ({ page }) => {
    await signIn(page, DEMO_EMAIL);
    await page.evaluate(() => window.localStorage.setItem('ecs-theme', 'dark'));
    const id = await createBuilderTemplate(page, `s3-dark-${Date.now()}`);
    trackFixture('templates', id);
    await page.goto(`/templates/${id}/build`);
    await page.reload();
    await page.locator('.focus-header').waitFor();
    await expect(page.locator('.app-shell')).toHaveClass(/theme-dark/);
    const headerBg = await page.locator('.focus-header').evaluate((element) => getComputedStyle(element).backgroundColor);
    // S4 replaced the S3 placeholder (.builder-canvas-area, centered flex row
    // for one line of text) with the real canvas (.builder-canvas, spec §2.5:
    // change the class rather than repurpose the old rule) -- same .email-canvas
    // light-surface treatment either way.
    const canvasBg = await page.locator('.v3-canvas').evaluate((element) => getComputedStyle(element).backgroundColor);
    // Chrome is dark, the email surface stays light -- conventions spec §2.3.
    // ".email-canvas" in dark mode resolves via the pre-existing rule at
    // globals.css's "Softer, consistent dark surfaces" block (#f4f1f2, not
    // literal #fff -- an earlier #fff rule for the same selector is shadowed
    // by a later one in the cascade, both pre-existing) -- still light, which
    // is what §2.3 actually requires, so this checks luminance rather than
    // exact white.
    const [headerR, headerG, headerB] = headerBg.match(/\d+/g)!.map(Number);
    const [canvasR, canvasG, canvasB] = canvasBg.match(/\d+/g)!.map(Number);
    expect(Math.min(headerR!, headerG!, headerB!)).toBeLessThan(200);
    expect(Math.min(canvasR!, canvasG!, canvasB!)).toBeGreaterThan(200);
  });

  for (const viewport of VIEWPORTS) {
    test(`visual evidence — builder focus mode — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, DEMO_EMAIL);
      const id = await createBuilderTemplate(page, `s3-visual-${viewport.name}-${Date.now()}`);
      trackFixture('templates', id);
      await page.goto(`/templates/${id}/build`);
      await page.locator('.focus-header').waitFor();
      mkdirSync(resolve(EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(EVIDENCE_ROOT, 'production', `builder-focus-${viewport.name}.png`), fullPage: true });
    });
  }
});
