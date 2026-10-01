import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * M2-S3 E2E: create a typed custom field on the admin screen -> see it as a
 * real input in the recipient add form -> save a typed value -> see it
 * round-trip in the edit form. Against the real compiled API + real
 * dockerized PostgreSQL, served through the packaged compose stack (D-22
 * pattern: the API must run from its tsc build, not tsx watch), matching
 * every prior M1/M2 node.
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
  await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
  await page.locator('button.login-submit').click();
  await page.waitForURL(/\/campaigns$/);
}

test.describe('Custom fields (M2-S3)', () => {
  test('create a typed custom field -> appears in the recipient form -> saves and round-trips a typed value', async ({ page }) => {
    await signIn(page);
    const unique = Date.now();
    const key = `e2e_city_${unique}`;

    // Create the custom field on the admin screen.
    await page.goto('/settings/custom-fields');
    await expect(page.locator('.page-header h1')).toHaveText('Cấu hình');
    await page.locator('.primary-button', { hasText: 'Tạo trường' }).click();
    await page.locator('.action-overlay').getByPlaceholder('shirt_size').fill(key);
    await page.locator('.action-overlay').getByPlaceholder('Kích cỡ áo').fill(`E2E City ${unique}`);
    await page.locator('.action-overlay .primary-button', { hasText: 'Tạo trường' }).click();
    await expect(page.locator('.toast')).toContainText('Đã tạo trường người nhận');
    await expect(page.locator('table tbody tr', { hasText: `{{${key}}}` })).toHaveCount(1);

    // BR-CF-003: attempting to create a field with a reserved system key is rejected with the reserved-key list.
    await page.locator('.primary-button', { hasText: 'Tạo trường' }).click();
    await page.locator('.action-overlay').getByPlaceholder('shirt_size').fill('email');
    await page.locator('.action-overlay').getByPlaceholder('Kích cỡ áo').fill('Email shadow attempt');
    await page.locator('.action-overlay .primary-button', { hasText: 'Tạo trường' }).click();
    await expect(page.locator('.action-overlay .login-error')).toContainText('biến hệ thống');
    await page.locator('.action-overlay button[aria-label="Đóng cửa sổ"]').click();

    // It appears as a real field in the recipient add form.
    await page.goto('/recipients');
    const email = `e2e-cf-${unique}@acme.vn`;
    await page.locator('.primary-button', { hasText: 'Thêm người nhận' }).click();
    await page.locator('.action-overlay').getByPlaceholder('email@company.vn').fill(email);
    await expect(page.locator('.action-overlay').getByText(`E2E City ${unique}`)).toBeVisible();
    await page.locator('.action-overlay .modal-field', { hasText: `E2E City ${unique}` }).locator('input').fill('Hanoi');
    await page.locator('.action-overlay .primary-button', { hasText: 'Thêm người nhận' }).click();
    await expect(page.locator('.toast')).toContainText('Đã thêm người nhận mới');

    // Round-trips the typed value via the edit overlay.
    await page.getByPlaceholder('Tìm theo tên, email, phòng ban').fill(String(unique));
    await expect(page.locator('table tbody tr')).toHaveCount(1, { timeout: 10000 });
    await page.locator('table tbody tr .row-menu').click();
    // The row menu is EntityActionMenu now: its items are `role="menuitem"`
    // in a portal on document.body, so they are neither `button`s nor inside
    // `.action-overlay`, and the edit item reads "Chỉnh sửa người nhận".
    await page.getByRole('menuitem', { name: 'Chỉnh sửa người nhận', exact: true }).click();
    await expect(page.locator('.action-overlay .modal-field', { hasText: `E2E City ${unique}` }).locator('input')).toHaveValue('Hanoi');
  });

  test('axe accessibility scan on /settings/custom-fields: no violations beyond the known pre-existing handoff contrast issue', async ({ page }) => {
    // GET /custom-fields has no limit/pagination (custom-fields.controller.ts),
    // and its own DELETE refuses to remove a field any template version ever
    // referenced -- even an archived one, since remove()'s dependency query
    // does not filter template.deleted_at. The shared dev tenant's field count
    // is therefore effectively one-way: hundreds of rows, all rendered as
    // table rows on this screen. axe-core's own DOM walk + per-node contrast
    // computation over that table is what needs more than the 30s default
    // here, not anything this screen's own accessibility does slowly.
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto('/settings/custom-fields');
    await page.waitForSelector('.custom-fields-module');
    const results = await new AxeBuilder({ page }).analyze();
    const unexpectedViolations = results.violations.filter((v) => v.id !== 'color-contrast');
    expect(unexpectedViolations, JSON.stringify(unexpectedViolations, null, 2)).toEqual([]);
  });
});
