import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { trackFixture } from './fixture-registry.js';

/**
 * S7 Task 46 acceptance for MC-UI-006.
 *
 * The plan asks for one thing: import a file carrying a `<script>`, an `@media`
 * rule and an `http:` image, and confirm the report names all three. Before this
 * slice it named one of the three, and that one without saying which image.
 *
 * It runs through the browser rather than against the module for the reason S6
 * paid for three times over: every one of that slice's real bugs -- an nginx
 * redirect, a URL missing its `/v1/`, an RLS policy that returned zero rows for
 * the serving role -- was invisible to unit and integration tests and appeared
 * the moment a real browser made a real request. The report is a full round trip
 * (browser -> API -> sanitizer -> response -> render), so it gets the same
 * treatment.
 *
 * The input is the frozen sample the fidelity gate asserts against, read from
 * the repository rather than written inline. One file, one expected set: if the
 * sample changes, the gate and this spec move together instead of drifting into
 * disagreement.
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';

const SAMPLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.agents/runs/2026-08-31-mailcraft-builder/evidence/s7-task43/lossy-import-sample.html',
);

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByPlaceholder('name@mailspace.vn').fill(DEMO_EMAIL);
  await page.getByPlaceholder('Nhập mật khẩu').fill(DEMO_PASSWORD);
  await page.locator('button.login-submit').click();
  await page.waitForURL(/\/campaigns$/);
  await page.waitForSelector('.sidebar');
}

test.describe('S7: import report (MC-UI-006) -- the sanitizer says what it discarded', () => {
  test('names the script, the media query and the http image, and lists the image by address', async ({ page }) => {
    const sample = readFileSync(SAMPLE_PATH, 'utf8');
    const templateName = `e2e-import-report-${Date.now()}`;

    await signIn(page);
    await page.goto('/templates');

    await page.getByRole('button', { name: 'Import HTML' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Import HTML' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(/Tên template/).fill(templateName);
    await dialog.getByLabel(/Mã HTML/).fill(sample);

    // Before analysing, the report side shows its empty state rather than a blank
    // panel -- the prototype's `v3-import-empty`, which says what is about to
    // happen instead of leaving the second column looking broken.
    await expect(dialog.locator('.v3-import-empty')).toBeVisible();

    await dialog.getByRole('button', { name: 'Phân tích cấu trúc' }).click();

    const report = dialog.locator('[data-mc-action="MC-UI-006.review_report"]');
    await expect(report).toBeVisible();
    await expect(report.locator('[data-mc-state="MC-UI-006.import_partial"]')).toBeVisible();

    // `missing_assets` sits inside the report, where the prototype puts it
    // ("Tài nguyên cần thay thế"), and names the address rather than counting:
    // ADR-043's rule is to list and never repair, and a count cannot be acted on.
    const missing = report.locator('[data-mc-state="MC-UI-006.missing_assets"]');
    await expect(missing).toBeVisible();
    await expect(missing).toContainText('http://cdn.example.test/hero.png');

    // The score header states a verdict, which a list of sentences alone does not.
    await expect(report.locator('.v3-import-score')).toContainText('cần xem lại');
    // Four counted tiles, the prototype's metric row.
    await expect(report.locator('.v3-import-metrics > div')).toHaveCount(4);

    // The three the plan names, each from a different stage of the pipeline: the
    // tag from a sanitize pass, the media query from juice, the image from the
    // transform hook. One of them silent means a whole stage stopped reporting.
    const text = (await report.textContent()) ?? '';
    expect(text).toContain('<script>');
    expect(text).toContain('@media');
    expect(text).toContain('ảnh không dùng https');

    // And the replacement advice, which is the half that turns a report into
    // something the author can act on.
    expect(text).toContain('background-color');

    // Nothing is saved until the author has seen the report.
    const save = dialog.getByRole('button', { name: 'Lưu template' });
    await save.click();
    await expect(dialog).toBeHidden();

    const created = await page.evaluate(async (name) => {
      const listed = await fetch('/api/v1/templates?limit=100', { credentials: 'include' }).then((r) => r.json()) as { items: Array<{ id: string; name: string; origin: string }> };
      return listed.items.find((item) => item.name === name) ?? null;
    }, templateName);

    expect(created, 'the draft the report described was not saved').not.toBeNull();
    trackFixture('templates', created!.id);

    // The boundary S7 must not quietly cross (plan line 780, ADR-037 §3):
    // import still lands in the code editor. Building a component tree back out
    // of HTML is a different problem, and the wrong way to do it is already
    // recorded as forbidden.
    expect(created!.origin).toBe('imported');

    // The report is not a client-side story about the draft: the same sentences
    // are persisted with it, which is what lets the editor show them again.
    const stored = await page.evaluate(async (id) => {
      const detail = await fetch(`/api/v1/templates/${id}`, { credentials: 'include' }).then((r) => r.json()) as { validation: { changes: string[] } };
      return detail.validation.changes;
    }, created!.id);

    expect(stored.join('\n')).toContain('@media');
    expect(stored.join('\n')).toContain('<script>');
  });

  test('says so plainly when an import loses nothing', async ({ page }) => {
    const templateName = `e2e-import-clean-${Date.now()}`;

    await signIn(page);
    await page.goto('/templates');
    await page.getByRole('button', { name: 'Import HTML' }).first().click();

    const dialog = page.getByRole('dialog', { name: 'Import HTML' });
    await dialog.getByLabel(/Tên template/).fill(templateName);
    await dialog.getByLabel(/Mã HTML/).fill('<html><body><p style="color:#111111">Xin chào</p></body></html>');
    await dialog.getByRole('button', { name: 'Phân tích cấu trúc' }).click();

    const report = dialog.locator('[data-mc-action="MC-UI-006.review_report"]');
    await expect(report.locator('.v3-import-score')).toContainText('Giữ nguyên được toàn bộ nội dung');
    await expect(report).toContainText('Không có gì bị loại bỏ');
    // The whole point of saying it out loud: silence used to mean "we did not
    // look", and a reader could not tell that from "nothing was lost".
    await expect(report.locator('[data-mc-state="MC-UI-006.import_partial"]')).toBeHidden();
    await expect(dialog.locator('[data-mc-state="MC-UI-006.missing_assets"]')).toBeHidden();

    await dialog.getByRole('button', { name: 'Lưu template' }).click();
    await expect(dialog).toBeHidden();

    const created = await page.evaluate(async (name) => {
      const listed = await fetch('/api/v1/templates?limit=100', { credentials: 'include' }).then((r) => r.json()) as { items: Array<{ id: string; name: string }> };
      return listed.items.find((item) => item.name === name) ?? null;
    }, templateName);
    trackFixture('templates', created?.id);
    expect(created).not.toBeNull();
  });
});
