import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackFixture } from './fixture-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-31-mailcraft-builder/evidence/s9-publish-handoff');
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
];

/**
 * S9 acceptance -- MC-UI-010, and with it the vertical slice's own exit gate
 * (spec §5.3): publish an immutable version from the builder, and have a
 * campaign send that exact version.
 *
 * Three claims a unit test cannot settle, because each spans the header, a
 * sheet, the API and a second screen:
 *
 * 1. **Publish no longer posts on the header click.** Before S9 the button
 *    called `POST /publish` directly. Now it opens a summary sheet, and the
 *    version only exists after the sheet's own confirm. Asserted at both ends:
 *    no version after the header click, one version after the confirm.
 * 2. **A blocking finding really blocks.** An undeclared `{{...}}` disables
 *    the confirm button and names the variable; a clean template's sheet is
 *    enabled. §2.9 makes this the server's rule -- `templates.service.ts`
 *    answers 4xx -- and the sheet exists so the author learns it before the
 *    click rather than after.
 * 3. **BR-TPL-012: the pin does not drift.** A campaign pinned to v1 still
 *    says v1 after v2 is published, offers the newer one, and moves only when
 *    the user says so. Both directions asserted, because "it showed v2" would
 *    pass either on a correct opt-in or on the silent drift the rule forbids.
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
  await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
  await page.locator('button.login-submit').click();
  await page.waitForURL(/\/campaigns$/);
  await page.waitForSelector('.sidebar');
}

async function api(page: import('@playwright/test').Page, path: string, init: { method: string; body?: unknown; ifMatch?: number }) {
  const result = await page.evaluate(async ([target, options]) => {
    const request = options as { method: string; body?: unknown; ifMatch?: number };
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-csrf-token': csrf };
    if (request.ifMatch !== undefined) headers['if-match'] = String(request.ifMatch);
    const response = await fetch(`/api/v1${target as string}`, {
      method: request.method, credentials: 'include', headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    return { status: response.status, body: await response.text() };
  }, [path, init] as const);
  if (result.status >= 400) throw new Error(`${init.method} ${path} -> ${result.status} ${result.body}`);
  return result.body ? JSON.parse(result.body) as Record<string, unknown> : {};
}

async function builderTemplate(page: import('@playwright/test').Page, label: string, subject: string): Promise<string> {
  const created = await api(page, '/templates', {
    method: 'POST',
    body: { name: `${label}-${Date.now()}`, subject, origin: 'builder' },
  }) as { id: string; draftRevision: number };
  trackFixture('templates', created.id);
  const current = await api(page, `/templates/${created.id}`, { method: 'GET' }) as { draftRevision: number };
  await api(page, `/templates/${created.id}`, {
    method: 'PATCH',
    ifMatch: current.draftRevision,
    body: { html: '<p>Chào bạn — {{unsubscribe_url}}</p>', textBody: 'Chào bạn' },
  });
  return created.id;
}

test.describe('S9 acceptance: publish handoff and campaign pin (MC-UI-010)', () => {
  test('the header button opens a summary instead of publishing, and the sheet is what publishes', async ({ page }) => {
    await signIn(page);
    const id = await builderTemplate(page, 's9-summary', 'Chào mừng bạn mới');
    await page.goto(`/templates/${id}/build`);
    await page.locator('.focus-header').waitFor();

    // Nothing published yet -- the "before" half of the claim.
    const before = await api(page, `/templates/${id}/versions`, { method: 'GET' }) as { items: unknown[] };
    expect(before.items).toHaveLength(0);

    await page.locator('[data-mc-action="MC-UI-010.validate"]').click();
    await expect(page.locator('.v3-publish-ready')).toBeVisible({ timeout: 15000 });

    // Still nothing: opening the summary is not publishing.
    const afterOpening = await api(page, `/templates/${id}/versions`, { method: 'GET' }) as { items: unknown[] };
    expect(afterOpening.items).toHaveLength(0);

    // The four boxes that replaced the prototype's Provider/Resource table.
    await expect(page.locator('.v3-resource')).toContainText('Phiên bản sắp tạo');
    await expect(page.locator('.v3-resource')).toContainText('v1');

    const confirm = page.locator('[data-mc-action="MC-UI-010.publish"]');
    await expect(confirm).toBeEnabled({ timeout: 15000 });
    await confirm.click();

    await expect(page.locator('[data-mc-state="MC-UI-010.published"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-mc-state="MC-UI-010.published"]')).toContainText('phiên bản 1');

    const after = await api(page, `/templates/${id}/versions`, { method: 'GET' }) as { items: unknown[] };
    expect(after.items).toHaveLength(1);
  });

  test('an undeclared variable blocks the confirm button and names itself', async ({ page }) => {
    await signIn(page);
    const blocked = await builderTemplate(page, 's9-blocked', 'Chào {{ten_sep_khong_khai_bao}}');
    await page.goto(`/templates/${blocked}/build`);
    await page.locator('.focus-header').waitFor();
    await page.locator('[data-mc-action="MC-UI-010.validate"]').click();

    const confirm = page.locator('[data-mc-action="MC-UI-010.publish"]');
    await expect(page.locator('.v3-publish-items')).toContainText('ten_sep_khong_khai_bao', { timeout: 20000 });
    await expect(confirm).toBeDisabled();
    await expect(page.locator('.v3-publish-ready.bad')).toBeVisible();

    // The other end: the same sheet on a template with nothing undeclared is
    // enabled, so "disabled" above is the finding and not the default.
    const clean = await builderTemplate(page, 's9-clean', 'Chào mừng');
    await page.goto(`/templates/${clean}/build`);
    await page.locator('.focus-header').waitFor();
    await page.locator('[data-mc-action="MC-UI-010.validate"]').click();
    await expect(page.locator('[data-mc-action="MC-UI-010.publish"]')).toBeEnabled({ timeout: 20000 });
  });

  test('BR-TPL-012: a pinned campaign keeps its version when a newer one is published, and moves only on request', async ({ page }) => {
    await signIn(page);
    const id = await builderTemplate(page, 's9-pin', 'Bảng giá tháng 8');
    await api(page, `/templates/${id}/publish`, { method: 'POST' });

    await page.goto('/campaigns/new');
    await page.locator('.compose-card, .template-row').first().waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Chọn template' }).click();
    await page.locator('.template-choice-grid button').filter({ hasText: 's9-pin' }).first().click();

    // Pinned at publish time, and now visible -- before S9 nothing on this
    // screen said which version a campaign would send.
    await expect(page.locator('.template-version-pin-badge')).toHaveText('Đang gửi bản v1', { timeout: 20000 });
    await expect(page.locator('.template-version-pin-update')).toHaveCount(0);

    // The pick above is local until the debounced autosave lands, and this
    // test reloads on purpose (the newer-version check runs on mount). Wait
    // for the server to actually hold the pin, or the reload restores a draft
    // with no template and the assertions below fail for the wrong reason.
    await page.waitForURL(/\/campaigns\/[0-9a-f-]+\/edit$/);
    const campaignId = page.url().match(/campaigns\/([0-9a-f-]+)\/edit/)![1]!;
    await expect.poll(async () => {
      const draft = await api(page, `/campaigns/${campaignId}`, { method: 'GET' }) as { templateVersionId: string | null };
      return draft.templateVersionId;
    }, { timeout: 20000 }).not.toBeNull();

    // A newer version appears while the campaign sits in draft.
    const current = await api(page, `/templates/${id}`, { method: 'GET' }) as { draftRevision: number };
    await api(page, `/templates/${id}`, {
      method: 'PATCH', ifMatch: current.draftRevision,
      body: { subject: 'Bảng giá tháng 9', html: '<p>Giá mới — {{unsubscribe_url}}</p>', textBody: 'Giá mới' },
    });
    await api(page, `/templates/${id}/publish`, { method: 'POST' });

    await page.reload();
    await expect(page.locator('.template-version-pin-badge')).toHaveText('Đang gửi bản v1', { timeout: 20000 });
    await expect(page.locator('.template-version-pin-update')).toContainText('Đã có bản v2');

    await page.getByRole('button', { name: 'Cập nhật lên bản mới nhất' }).click();
    await expect(page.locator('.template-version-pin-badge')).toHaveText('Đang gửi bản v2');
    await expect(page.locator('.template-version-pin-update')).toHaveCount(0);
  });

  test('the publish sheet at three viewports', async ({ page }) => {
    mkdirSync(EVIDENCE_ROOT, { recursive: true });
    await signIn(page);
    const id = await builderTemplate(page, 's9-shots', 'Chào mừng bạn mới');

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/templates/${id}/build`);
      await page.locator('.focus-header').waitFor();

      // The header keeps its publish button at every width (SV-6 restored the
      // preview button below 720px but deliberately left publish hidden --
      // nothing on a phone should be one tap from an immutable version), so
      // the assertion branches rather than skipping: ARCH-TEST-HYGIENE forbids
      // a committed skip, and each width has something true to assert.
      const trigger = page.locator('[data-mc-action="MC-UI-010.validate"]');
      if (await trigger.isVisible()) {
        await trigger.click();
        await expect(page.locator('.v3-publish-ready')).toBeVisible({ timeout: 20000 });
        await expect(page.locator('.v3-resource')).toBeVisible();
      } else {
        await expect(page.locator('.builder-narrow-notice')).toBeVisible();
      }
      await page.screenshot({ path: resolve(EVIDENCE_ROOT, `publish-${viewport.name}.png`), fullPage: false });
    }
  });
});
