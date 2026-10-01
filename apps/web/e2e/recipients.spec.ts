import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * M2-S1 E2E: add -> search -> filter -> soft delete, against the real
 * compiled API + real dockerized PostgreSQL, served through the packaged
 * compose stack, matching every prior M1 node's live-servers pattern
 * (D-22: the API must run from its tsc build, not tsx watch).
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

test.describe('Recipients (M2-S1)', () => {
  test('add -> search -> filter -> soft delete', async ({ page }) => {
    await signIn(page);
    await page.goto('/recipients');
    await expect(page.locator('.page-header h1')).toHaveText('Người nhận');
    await expect(page.locator('[role="tablist"][aria-label="Quản lý người nhận"] button.active')).toHaveText('Tất cả người nhận');

    const unique = Date.now();
    const email = `e2e-${unique}@acme.vn`;

    // Add
    await page.locator('.primary-button', { hasText: 'Thêm người nhận' }).click();
    await page.locator('.action-overlay').getByPlaceholder('email@company.vn').fill(email);
    await page.locator('.action-overlay').getByPlaceholder('Nguyễn').fill('E2E');
    await page.locator('.action-overlay').getByPlaceholder('Minh An').fill(`Test${unique}`);
    await page.locator('.action-overlay .primary-button', { hasText: 'Thêm người nhận' }).click();
    await expect(page.locator('.toast')).toContainText('Đã thêm người nhận mới');
    await expect(page.locator('.action-overlay')).toHaveCount(0);

    // Search
    await page.getByPlaceholder('Tìm theo tên, email, phòng ban').fill(String(unique));
    await expect(page.locator('table tbody tr')).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('table tbody tr')).toContainText(email);

    // Duplicate rejected
    await page.locator('.primary-button', { hasText: 'Thêm người nhận' }).click();
    await page.locator('.action-overlay').getByPlaceholder('email@company.vn').fill(email);
    await page.locator('.action-overlay .primary-button', { hasText: 'Thêm người nhận' }).click();
    await expect(page.locator('.action-overlay .login-error')).toContainText('đã tồn tại');
    await page.locator('.action-overlay button[aria-label="Đóng cửa sổ"]').click();

    // Filter: paused status should exclude our active recipient
    await page.locator('.filter-button').click();
    await page.locator('.action-overlay').getByText('Tạm dừng').click();
    await page.locator('.action-overlay .primary-button', { hasText: 'Áp dụng bộ lọc' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(0);
    await page.locator('.clear-filters').click();
    await expect(page.locator('table tbody tr')).toHaveCount(1);

    // Soft delete. The row menu is EntityActionMenu now: its items are
    // `role="menuitem"` in a portal on document.body, so they are neither
    // `button`s nor inside `.action-overlay`. Its delete item also calls
    // deleteRecipient straight away -- RecipientActionsOverlay's separate
    // confirm step is gone (only its comment survives), so there is no
    // `.danger-button` to click between the menu item and the toast.
    await page.locator('table tbody tr .row-menu').click();
    await page.getByRole('menuitem', { name: 'Xóa người nhận', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('Đã xóa');
    await expect(page.locator('table tbody tr')).toHaveCount(0);
  });

  test('import preview reports a bad cell and returns to editable mapping', async ({ page }) => {
    await signIn(page);
    await page.goto('/recipients');
    await page.locator('.secondary-button', { hasText: 'Import Excel' }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'preview.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Email,First name\nnot-an-email,Minh\n'),
    });
    await page.getByRole('button', { name: 'Tiếp tục mapping' }).click();
    await expect(page.getByText('Mapping dữ liệu', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Xem kiểm tra' }).click();
    await expect(page.getByText('Dòng 2, cột Email: Email không hợp lệ.')).toBeVisible();
    await page.getByRole('button', { name: 'Quay lại mapping' }).click();
    await expect(page.getByText('Mapping dữ liệu', { exact: true })).toBeVisible();
    await expect(page.locator('.modal-field', { hasText: 'Email *' }).locator('select')).toHaveValue('Email');
  });

  test('axe accessibility scan on /recipients: no violations beyond the known pre-existing handoff contrast issue', async ({ page }) => {
    await signIn(page);
    await page.goto('/recipients');
    await page.waitForSelector('.recipients-module');
    const results = await new AxeBuilder({ page }).analyze();
    const unexpectedViolations = results.violations.filter((v) => v.id !== 'color-contrast');
    expect(unexpectedViolations, JSON.stringify(unexpectedViolations, null, 2)).toEqual([]);
  });
});
