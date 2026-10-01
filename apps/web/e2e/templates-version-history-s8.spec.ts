import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackFixture } from './fixture-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-31-mailcraft-builder/evidence/s8-version-history');
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
];

/**
 * S8 acceptance -- MC-UI-009's full version history, which no spec covered
 * before this file. Tasks 47 and 48 added the two things
 * `TemplateEditorScreen.tsx` used to admit it did not have: `preview` of a
 * published version, and `compare` between two of them.
 *
 * The two claims worth a browser, because neither a unit test nor a screenshot
 * settles them:
 *
 * 1. **Preview renders THAT version, not the current draft.** The endpoint is
 *    version-scoped; the UI reaching it has to be too. So the fixture publishes
 *    v1, changes the draft, publishes v2, and the test asserts the v1 preview
 *    carries v1's text and NOT v2's -- naming both ends, the way SV-2's
 *    "Back closed the sheet" report should have.
 * 2. **Compare distinguishes two versions that share a long prefix.** The plan
 *    told Task 48 to reuse `templateConflictExcerpt`; that was measured and
 *    rejected, because the builder emitter writes a fixed 367-character
 *    preamble and the excerpt cuts at 120, so two versions differing in every
 *    visible word produce identical excerpts. The fixture below reproduces
 *    exactly that shape -- a shared 367-character preamble, a difference after
 *    it -- so a regression to any first-N-characters cut fails here rather
 *    than rendering two cells that look the same and claiming they were
 *    compared.
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';

/** The emitter's real preamble shape (builder/emitter.ts, defaultTheme): the reason a 120-character excerpt cannot tell two versions apart. */
const PREAMBLE = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
  + '<body style="margin:0;background-color:#f3f1ed;font-family:Arial, Helvetica, sans-serif;font-size:14px">'
  + '<table role="presentation" width="100%"><tr><td align="center">'
  + '<table role="presentation" width="640" style="width:100%;max-width:640px;background-color:#ffffff">';
const TAIL = '</table></td></tr></table></body></html>';
const V1_TEXT = 'Giá gốc 199000 dong';
const V2_TEXT = 'Giá gốc 149000 dong';

const historyRail = (page: import('@playwright/test').Page) => page.locator('.v3-rail button', { hasText: 'Lịch sử' });

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

/** Publishes one immutable version carrying `text` after the shared preamble, and returns the draft revision left behind. */
async function publishVersion(page: import('@playwright/test').Page, id: string, subject: string, text: string) {
  const current = await api(page, `/templates/${id}`, { method: 'GET' }) as { draftRevision: number };
  await api(page, `/templates/${id}`, {
    method: 'PATCH',
    ifMatch: current.draftRevision,
    body: { subject, html: `${PREAMBLE}<tr><td>${text}</td></tr>${TAIL}`, textBody: text },
  });
  await api(page, `/templates/${id}/publish`, { method: 'POST' });
}

async function twoVersionFixture(page: import('@playwright/test').Page, label: string): Promise<string> {
  const created = await api(page, '/templates', {
    method: 'POST',
    body: { name: `${label}-${Date.now()}`, subject: 'Nghiệm thu S8', origin: 'builder' },
  }) as { id: string };
  trackFixture('templates', created.id);
  await publishVersion(page, created.id, 'Bảng giá tháng 8', V1_TEXT);
  await publishVersion(page, created.id, 'Bảng giá tháng 9', V2_TEXT);
  return created.id;
}

async function openHistorySheet(page: import('@playwright/test').Page, id: string) {
  await page.goto(`/templates/${id}/build`);
  await page.locator('.focus-header').waitFor();
  await historyRail(page).click();
  await expect(page.locator('.v3-versions.timeline button')).toHaveCount(2, { timeout: 15000 });
}

test.describe('S8 acceptance: version history preview and compare (MC-UI-009)', () => {
  test('preview renders the version that was selected, not the newest one', async ({ page }) => {
    await signIn(page);
    const id = await twoVersionFixture(page, 's8-preview');
    await openHistorySheet(page, id);

    // v2 is selected by default (the list is newest-first), so selecting v1 is
    // a real change of state, not the starting position.
    const rows = page.locator('.v3-versions.timeline button');
    await expect(rows.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'false');
    await rows.nth(1).click();
    await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.v3-history-selection b')).toContainText('Phiên bản 1');

    await page.locator('[data-mc-action="MC-UI-009.preview"]').click();

    const frame = page.locator('[data-mc-state="MC-UI-009.success"]');
    await expect(frame).toBeVisible({ timeout: 15000 });
    const rendered = await frame.getAttribute('srcdoc');
    // Both ends named: v1's content is there and v2's is not, so this cannot
    // pass by rendering whatever the draft happens to hold.
    expect(rendered).toContain(V1_TEXT);
    expect(rendered).not.toContain(V2_TEXT);

    // And the way back leaves the timeline exactly as it was.
    await page.getByRole('button', { name: '‹ Quay lại danh sách' }).click();
    await expect(page.locator('.v3-versions.timeline button')).toHaveCount(2);
  });

  test('compare tells two versions apart even though their first 120 characters are identical', async ({ page }) => {
    await signIn(page);
    const id = await twoVersionFixture(page, 's8-compare');
    await openHistorySheet(page, id);

    // The premise, asserted rather than assumed: an excerpt of either version's
    // html would be the same string, because the shared preamble is longer than
    // the excerpt budget. If this stops being true the test below stops proving
    // what it claims.
    expect(PREAMBLE.length).toBeGreaterThan(120);

    await page.locator('[data-mc-action="MC-UI-009.compare"]').click();
    const candidates = page.locator('.v3-versions.timeline button');
    await expect(candidates).toHaveCount(1);
    await candidates.first().click();

    const diff = page.locator('[data-mc-state="MC-UI-009.success"]');
    await expect(diff).toBeVisible({ timeout: 15000 });
    // The changed line, both sides of it, actually reaches the cell.
    await expect(diff).toContainText(V1_TEXT);
    await expect(diff).toContainText(V2_TEXT);
    // Subject changed too, so the field grid must name it.
    await expect(diff).toContainText('Tiêu đề email');
  });

  test('a template with a single version cannot be compared, and says why', async ({ page }) => {
    await signIn(page);
    const created = await api(page, '/templates', {
      method: 'POST',
      body: { name: `s8-single-${Date.now()}`, subject: 'Một phiên bản', origin: 'builder' },
    }) as { id: string };
    trackFixture('templates', created.id);
    await publishVersion(page, created.id, 'Chỉ một bản', V1_TEXT);

    await page.goto(`/templates/${created.id}/build`);
    await page.locator('.focus-header').waitFor();
    await historyRail(page).click();
    await expect(page.locator('.v3-versions.timeline button')).toHaveCount(1, { timeout: 15000 });

    const compare = page.locator('[data-mc-action="MC-UI-009.compare"]');
    await expect(compare).toBeDisabled();
    await expect(compare).toHaveAttribute('title', /ít nhất 2 phiên bản/);
    // Preview stays available -- one version is still a version worth reading.
    await expect(page.locator('[data-mc-action="MC-UI-009.preview"]')).toBeEnabled();
  });

  test('the history sheet at three viewports', async ({ page }) => {
    mkdirSync(EVIDENCE_ROOT, { recursive: true });
    await signIn(page);
    const id = await twoVersionFixture(page, 's8-shots');

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/templates/${id}/build`);
      await page.locator('.focus-header').waitFor();

      // Below 1024px the builder swaps its workspace for `.builder-narrow-notice`
      // (conventions spec §2.2), so the assertion branches on the width rather
      // than skipping: ARCH-TEST-HYGIENE forbids a committed skip, and a
      // narrow viewport still has something true to assert.
      const narrow = viewport.width < 1024;
      if (narrow) {
        await expect(page.locator('.builder-narrow-notice')).toBeVisible();
      } else {
        await historyRail(page).click();
        await expect(page.locator('.v3-immutable')).toBeVisible();
        await expect(page.locator('.v3-versions.timeline button')).toHaveCount(2, { timeout: 15000 });
        await expect(page.locator('.v3-history-selection')).toBeVisible();
      }
      await page.screenshot({ path: resolve(EVIDENCE_ROOT, `history-${viewport.name}.png`), fullPage: false });
    }
  });
});
