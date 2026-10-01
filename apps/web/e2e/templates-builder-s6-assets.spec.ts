import { expect, test } from '@playwright/test';
import { trackFixture } from './fixture-registry.js';

/**
 * S6 Task 42 acceptance for MC-UI-005, and the half of ADR-043's own
 * measurement that Task 32 could not run.
 *
 * ADR-043 §Consequences says so explicitly: Task 32 measured the URL SHAPE
 * through the real sanitizer before any storage existed, and recorded that the
 * upload -> store -> serve loop "chỉ nghiệm thu được đầu-cuối ở Task 42". This
 * is that acceptance. What it has to prove is not that buttons exist but that
 * one real PNG survives every layer between a file picker and a recipient's
 * mail client:
 *
 *   upload -> object store -> served over a public URL with no session
 *          -> bound into the document -> emitted -> sanitized -> published
 *          -> still fetchable at that URL afterwards
 *
 * A break anywhere in that chain is an image that vanishes from mail nobody can
 * edit any more, which is the failure ADR-043 exists to prevent.
 *
 * Keyboard-driven like the S4/S5 specs -- `.focus()` a control directly, then
 * press the key a real user would, which proves it is a real tab stop. The one
 * exception is the file input: choosing a file is an OS dialog no page script
 * can drive, so `setInputFiles` stands in for it. The input is still reached
 * and asserted as a real control.
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';

/** A real 1x1 PNG. Magic bytes matter here: the API decides the stored type by sniffing them and ignores whatever the client declares (ADR-043 §4). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
  await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
  await page.locator('button.login-submit').click();
  await page.waitForURL(/\/campaigns$/);
  await page.waitForSelector('.sidebar');
}

async function createBuilderTemplate(page: import('@playwright/test').Page, name: string): Promise<string> {
  const response = await page.evaluate(async (templateName) => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const result = await fetch('/api/v1/templates', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ name: templateName, subject: 'Ảnh trong email', origin: 'builder' }),
    });
    return { status: result.status, body: await result.text() };
  }, name);
  if (response.status !== 201) throw new Error(`Could not create builder-origin fixture: ${response.status} ${response.body}`);
  return (JSON.parse(response.body) as { id: string }).id;
}

/** Archives every asset this spec uploaded. The library is tenant-wide, so leftovers would pile up in front of every other spec that opens the panel. */
async function archiveAssetsNamed(page: import('@playwright/test').Page, prefix: string): Promise<void> {
  await page.evaluate(async (namePrefix) => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const listed = await fetch('/api/v1/assets', { credentials: 'include' }).then((r) => r.json()) as { items: Array<{ id: string; filename: string }> };
    for (const asset of listed.items.filter((item) => item.filename.startsWith(namePrefix))) {
      await fetch(`/api/v1/assets/${asset.id}`, { method: 'DELETE', credentials: 'include', headers: { 'x-csrf-token': csrf } });
    }
  }, prefix);
}

test.describe('S6: asset library (MC-UI-005) -- upload, bind, publish', () => {
  /**
   * The asset URL the API mints comes from `ASSET_PUBLIC_ORIGIN`, which compose
   * fills from the deployment's own `EOW_WEB_ORIGIN`. The packaged local stack
   * serves `http://localhost:8080`, and `http:` is exactly what the sanitizer
   * strips (Task 32 measured it) and what `bindAsset` refuses rather than
   * writing a source that would vanish at publish.
   *
   * So this spec does not skip on such a stack and it does not pretend the
   * chain completes there. It asserts what is true of the deployment it is
   * actually running against, decided from the URL the API returned rather than
   * from configuration: on https the image goes all the way to a published
   * version, and on http the bind is refused OUT LOUD, which is the fail-safe
   * and the thing worth proving on a misconfigured stack.
   *
   * Everything before that point -- upload, store, serve to an anonymous
   * request, keep serving after archive -- is origin-independent, and it is the
   * half of ADR-043's own measurement that Task 32 could not run.
   */
  test('carries one real image from the file picker to a published version, and keeps serving it without a session', async ({ page, request }) => {
    await signIn(page);
    const prefix = `s6-asset-${Date.now()}`;
    const id = await createBuilderTemplate(page, `${prefix}-template`);
    trackFixture('templates', id);

    try {
      await page.goto(`/templates/${id}/build`);
      await page.locator('.builder-title-field input').first().waitFor();

      // An image block on the canvas. It starts with no src, which is the
      // `unbound` half of missing_assets: visible here, absent from the email.
      // ADR-044 Task SV-3: the Insert panel's list is `.v3-block-scroll` now (grouped, searchable), not the old flat `.builder-library-grid`.
      const imageButton = page.locator('.v3-block-scroll button', { hasText: 'Hình ảnh' }).first();
      await imageButton.focus();
      await page.keyboard.press('Enter');
      const canvasImages = page.locator('.v3-canvas img');
      await expect(page.locator('.v3-canvas')).toBeVisible();

      // Inserting does not select (spec: insertBlock never calls setSelectedId,
      // matching the S4/S5 pattern), so the canvas node is selected explicitly --
      // `bind` needs a selected image-bearing node to have a target at all.
      const canvasImageNode = page.locator('.builder-node-image').first();
      await canvasImageNode.focus();
      await page.keyboard.press('Enter');

      // Open the Assets rail destination by keyboard.
      const rail = page.locator('.mc-tool-rail button', { hasText: 'Thư viện ảnh' }).first();
      await rail.focus();
      await page.keyboard.press('Enter');
      const panel = page.locator('.mc-workspace-panel');
      await expect(panel.locator('[data-mc-action="MC-UI-005.upload"]')).toBeVisible();

      // MC-UI-005 missing_assets, reachable before anything is uploaded: the
      // image block on the canvas has no source yet.
      await expect(panel.locator('[data-mc-state="MC-UI-005.missing_assets"]')).toBeVisible();

      // The two disclosures ADR-043 forbids burying, at the point of upload.
      await expect(panel).toContainText('Ai có đường dẫn ảnh đều tải được');
      await expect(panel).toContainText('Outlook desktop');

      // upload. The file dialog is the one thing a keyboard cannot reach.
      const filename = `${prefix}-logo.png`;
      await panel.locator('[data-mc-action="MC-UI-005.upload"] input[type="file"]').setInputFiles({ name: filename, mimeType: 'image/png', buffer: PNG });

      const list = panel.locator('[data-mc-state="MC-UI-005.success"]');
      await expect(list).toBeVisible();
      await expect(list).toContainText(filename);

      // The URL the API actually minted decides what the rest of this proves.
      const assetUrl = (await list.locator('img.builder-asset-thumb').first().getAttribute('src'))!;
      expect(assetUrl).toMatch(/^https?:\/\/[^/]+\/api\/v1\/assets\/[0-9a-f-]{36}\//);

      // The serving route works with no session at all -- which is what a
      // recipient's mail client is: a request context carrying none of this
      // page's cookies. ADR-043 §2 calls the id a bearer capability on purpose;
      // here it is, behaving like one. This is the half Task 32 could not run.
      const anonymous = await request.get(assetUrl, { headers: {} });
      expect(anonymous.status()).toBe(200);
      expect(anonymous.headers()['content-type']).toContain('image/png');
      expect(anonymous.headers()['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(await anonymous.body())).toEqual(PNG);

      // bind, by keyboard, onto the selected image block.
      const bindButton = list.locator('[data-mc-action="MC-UI-005.bind"]').first();
      await expect(bindButton).toBeEnabled();
      await bindButton.focus();
      await page.keyboard.press('Enter');

      if (!assetUrl.startsWith('https:')) {
        // A deployment serving itself over http cannot produce a usable email
        // image at all. What must NOT happen is a dead button: the panel says
        // why, names the misconfiguration, and the document is left alone so
        // nothing broken reaches a published version.
        await expect(panel.getByRole('alert')).toContainText('không phải https');
        await expect(panel.getByRole('alert')).toContainText('ASSET_PUBLIC_ORIGIN');
        await expect(panel.locator('[data-mc-state="MC-UI-005.missing_assets"]')).toBeVisible();
        return;
      }

      // The canvas now shows the served URL, absolute https -- the constraint
      // Task 32 measured, because a relative one is stripped.
      await expect(canvasImages.first()).toBeVisible();
      expect(await canvasImages.first().getAttribute('src')).toBe(assetUrl);

      // ...and the document no longer reports a missing image.
      await expect(panel.locator('[data-mc-state="MC-UI-005.missing_assets"]')).toHaveCount(0);

      // mark_decorative, in the inspector where the image lives. ADR-044 Task
      // SV-2 split the inspector into the prototype's three tabs, and this
      // switch is on "Nâng cao": it is not a style and not the image's content,
      // it changes what a screen reader is told. So the tab has to be opened
      // first -- without this the control is not in the DOM at all.
      await page.locator('.v3-tabs button', { hasText: 'Nâng cao' }).click();
      const decorative = page.locator('[data-mc-action="MC-UI-005.mark_decorative"] input[type="checkbox"]');
      await decorative.focus();
      await page.keyboard.press('Space');
      await expect(decorative).toBeChecked();

      // Publish, and read the immutable version back.
      //
      // The header control opens the publish sheet rather than publishing --
      // S9 (`66c5b21`) changed `onPublish` from `() => void publish()` to
      // `openPublishSheet`, and this spec, last touched at `6d7d8f2`, kept
      // waiting for a toast that only arrives after the sheet's own confirm.
      // It has been red since then; the flow works, the test was describing the
      // previous one. Keeping the focus/Enter step because that was its point:
      // the header control is reachable from the keyboard.
      const publishButton = page.getByRole('button', { name: 'Xuất bản' }).first();
      await expect(publishButton).toBeEnabled();
      await publishButton.focus();
      await page.keyboard.press('Enter');
      const confirmPublish = page.locator('[data-mc-action="MC-UI-010.publish"]');
      await expect(confirmPublish).toBeEnabled({ timeout: 20000 });
      await confirmPublish.click();
      await expect(page.locator('.toast')).toContainText('Đã xuất bản', { timeout: 15000 });

      const published = await page.evaluate(async (templateId) => {
        const versions = await fetch(`/api/v1/templates/${templateId}/versions`, { credentials: 'include' }).then((r) => r.json()) as { items: Array<{ id: string; version: number }> };
        const latest = versions.items.sort((a, b) => b.version - a.version)[0]!;
        return fetch(`/api/v1/template-versions/${latest.id}`, { credentials: 'include' }).then((r) => r.json()) as Promise<{ html: string }>;
      }, id);

      // The whole point. The stored, sanitized, immutable HTML carries the
      // asset URL byte for byte, and the decorative pair survived with it --
      // Task 39 measured the sanitizer silently dropping `role` before it was
      // allowed, which would have made this the assertion that caught it.
      expect(published.html).toContain(assetUrl);
      expect(published.html).toContain('role="presentation"');
      expect(published.html).toContain('alt=""');

      // Archiving hides the asset from the library and does NOT withdraw it:
      // this published version still points at the URL and cannot be edited.
      await archiveAssetsNamed(page, prefix);
      expect((await request.get(assetUrl)).status()).toBe(200);
    } finally {
      await archiveAssetsNamed(page, prefix);
    }
  });
});
