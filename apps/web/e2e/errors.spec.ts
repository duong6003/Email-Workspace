import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * M1-S3 E2E: a session-fetch failure (GET /auth/me erroring for a reason
 * other than 401) must render SystemErrorScreen with a retry, never a
 * silent redirect to /login -- that was RequireAuth's pre-existing bug this
 * node fixed (a backend outage is not "please log in"). Fixtures:
 * apps/api/scripts/seed-demo-user.mjs (same as auth.spec.ts/rbac.spec.ts).
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';

test.describe('Audit and errors (M1-S3)', () => {
  test('a 500 from GET /auth/me shows the system error state, not a redirect to /login', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
    await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
    await page.locator('button.login-submit').click();
    await page.waitForURL(/\/campaigns$/);
    await page.waitForSelector('.sidebar');

    // Simulate a backend outage on the very next session check: the session
    // cookie is still valid (the user is still authenticated), but the API
    // itself is failing.
    await page.route('**/api/v1/auth/me', (route) =>
      route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Internal Server Error', status: 500 }) }),
    );
    await page.reload();

    await expect(page.locator('.permission-denied-card h1')).toHaveText('Đã xảy ra lỗi hệ thống');
    await expect(page).not.toHaveURL(/\/login$/);

    // Recovery: once the backend is healthy again, retry brings the real shell back.
    await page.unroute('**/api/v1/auth/me');
    await page.getByRole('button', { name: 'Thử lại' }).click();
    await expect(page.locator('.app-shell')).toBeVisible();
  });

  test('axe accessibility scan on the system error state: no violations beyond the known pre-existing handoff contrast issue', async ({ page }) => {
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

    const results = await new AxeBuilder({ page }).analyze();
    const unexpectedViolations = results.violations.filter((v) => v.id !== 'color-contrast');
    expect(unexpectedViolations, JSON.stringify(unexpectedViolations, null, 2)).toEqual([]);
  });
});
