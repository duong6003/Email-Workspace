import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackFixture } from './fixture-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * S4 Task 22 acceptance -- the surfaces Tasks 17-21 added on top of the
 * Task 18 baseline (`templates-builder-s4.spec.ts`, still valid, not
 * superseded): the tool rail, the Structure tree, the Theme checkbox, and
 * the Custom HTML block. Same method that file already established --
 * `.focus()` a control directly (proves it is a real keyboard stop, not
 * fragile to full-page Tab order) then press the key a real user would.
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
];
const EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-31-mailcraft-builder/evidence/s4-task22-acceptance');

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
      body: JSON.stringify({ name: templateName, subject: 'Nghiệm thu S4', origin: 'builder' }),
    });
    return { status: result.status, body: await result.text() };
  }, name);
  if (response.status !== 201) throw new Error(`Could not create builder-origin fixture: ${response.status} ${response.body}`);
  return (JSON.parse(response.body) as { id: string }).id;
}

test.describe('S4 Task 22: rail, Structure tree, Theme, Custom HTML -- keyboard only', () => {
  test('toggles the Theme responsive checkbox, navigates the tool rail, arrow-navigates the Structure tree, and edits a Custom HTML block, all by keyboard', async ({ page }) => {
    await signIn(page);
    const id = await createBuilderTemplate(page, `s4-task22-kbd-${Date.now()}`);
    trackFixture('templates', id);
    await page.goto(`/templates/${id}/build`);
    await page.locator('.focus-header').waitFor();
    await page.locator('.builder-title-field input').waitFor();

    // MC-UI-007 change_responsive_rules. ADR-044 Task SV-2 (SV decision 2) moved
    // the theme out of the inspector's Document field list -- which no longer
    // exists -- into the prototype's own sheet, opened from the rail. The
    // control is the prototype's `v3-toggle` there: a button with aria-pressed,
    // not a native checkbox, so this drives it with Enter and reads its pressed
    // state. Its accessible name comes from the visible text beside it
    // (aria-labelledby), which is the correction SV-4's e2e checkpoint made to
    // the prototype's own markup -- studio.tsx wraps it in a <label>, and a
    // <label> cannot name a <button>.
    const themeRail = page.getByRole('button', { name: 'Chủ đề', exact: true });
    await themeRail.focus();
    await page.keyboard.press('Enter');
    const stackToggle = page.getByRole('button', { name: 'Xếp chồng cột trên màn hình hẹp' });
    await expect(stackToggle).toHaveAttribute('aria-pressed', 'true');
    await stackToggle.focus();
    await page.keyboard.press('Enter');
    await expect(stackToggle).toHaveAttribute('aria-pressed', 'false');

    // Escape closes the sheet before Back would consider leaving the editor
    // (conventions spec §2.11 layer 1). Escape, not the header's Back button:
    // the sheet backdrop is inset:0 above the header, so a click there lands on
    // the backdrop rather than on Back -- which dismisses the sheet by a
    // different path and proves nothing about layer 1. Measured by this spec.
    await page.keyboard.press('Escape');
    await expect(page.locator('.v3-sheet-bg')).toHaveCount(0);

    // MC-UI-002 insert_element: a Custom HTML block via the Insert rail (default active).
    await page.getByRole('button', { name: 'HTML/CSS tùy chỉnh', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.builder-node-customHtml')).toHaveCount(1);

    // MC-UI-003: switch to Structure via the rail, by keyboard.
    const structureRailButton = page.getByRole('button', { name: 'Cấu trúc', exact: true });
    await structureRailButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.v3-layer-scroll')).toBeVisible();

    // expand_all by keyboard, then arrow down to the customHtml row (auto-wrapped as
    // Section > Row > Column > HTML tuỳ chỉnh, so it is the 4th row) and select it.
    await page.getByRole('button', { name: 'Mở rộng tất cả', exact: true }).focus();
    await page.keyboard.press('Enter');
    const firstRow = page.locator('[role="treeitem"]').first();
    await firstRow.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    // ADR-044 Task SV-3: the row also carries the restored visibility/lock
    // toggle buttons now (v3-layer's trailing two buttons), so the row's own
    // full text is no longer just the label -- assert on the label cell.
    // The Structure tree names a node with `NODE_LABEL` (studio.tsx's
    // `nodeName`), which is a different list from the Insert panel's: the button
    // that made this block says "HTML/CSS tùy chỉnh", the block itself says
    // "HTML/CSS".
    await expect(page.locator('[role="treeitem"][aria-selected="true"] .v3-layer-select')).toHaveText('HTML/CSS');
    // select_node's effect: the inspector switched to this node's own editor.
    // ADR-044 Task SV-2 split the inspector into the prototype's three tabs and
    // put the HTML source on "Nâng cao" -- it is neither the block's text nor
    // its appearance. Opening the tab is now part of reaching the editor.
    await page.locator('.v3-tabs button', { hasText: 'Nâng cao' }).click();
    // ADR-044 Task SV-5 ported the prototype's code panel onto this editor, so
    // the surface is now `v3-code-work` carrying `v3-pipeline` and the two tabs
    // of `v3-code-tabs`. `builder-custom-html-editor` is still on the same
    // element -- the two classes are one element, not two panels.
    await expect(page.locator('.v3-code-work.builder-custom-html-editor')).toBeVisible();
    await expect(page.locator('.v3-pipeline > div')).toHaveCount(4);

    // MC-UI-011 edit_sanitized_html: type into the CodeMirror editor by keyboard.
    await page.locator('.v3-code-work .cm-content').click();
    await page.keyboard.type('<p class="lead">Nghiệm thu S4</p>');
    await expect(page.locator('.v3-code-work .cm-content')).toContainText('Nghiệm thu S4');
    // The banner reacts to the keystrokes themselves, with no round trip: a
    // <div>-only fragment earns the email-layout warning (`custom-code.ts`).
    await expect(page.locator('.v3-code-result.warn')).toBeVisible();

    // Task SV-5's second tab, and the reason `Node.css` exists: CSS typed here
    // reaches the email, because the sanitizer inlines a <style> block into
    // style="" rather than dropping it. The banner reads BOTH tabs, so an
    // `@import` in the CSS blocks a fragment whose HTML is fine -- and blocking
    // also disables the round trip, since applying it would silently lose the
    // rule. The layout warning above stays either way: that one is about the
    // HTML, and clean CSS does not make a <div> layout a good idea.
    await page.locator('.v3-code-tabs button', { hasText: 'CSS' }).click();
    await page.locator('.builder-custom-css-input').fill('@import url(https://evil.test/x.css);');
    await expect(page.locator('.v3-code-result.error')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Xác thực với máy chủ', exact: true })).toBeDisabled();
    await page.locator('.builder-custom-css-input').fill('.lead{color:#173f33}');
    await expect(page.locator('.v3-code-result.warn')).toBeVisible();

    // MC-UI-011 validate: the server round trip, by keyboard. SV-5 renamed the
    // button because the panel now checks as you type -- this one is the trip
    // to the sanitizer, and the old bare "Xác thực" no longer said which.
    await page.getByRole('button', { name: 'Xác thực với máy chủ', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.builder-custom-html-report')).toBeVisible({ timeout: 10000 });
    // All four stages complete only after the server has answered for exactly
    // this text, which is what the report being visible means.
    await expect(page.locator('.v3-pipeline > div.done')).toHaveCount(4);
  });

  for (const viewport of VIEWPORTS) {
    test(`visual evidence — rail, Structure tree open, richer canvas — ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page);
      const id = await createBuilderTemplate(page, `s4-task22-visual-${viewport.name}-${Date.now()}`);
      trackFixture('templates', id);
      await page.goto(`/templates/${id}/build`);
      await page.locator('.focus-header').waitFor();
      await page.locator('.builder-title-field input').waitFor();

      if (viewport.width >= 1280) {
        // Full editor width: build a richer tree (banner, table, social alongside
        // the Task 18 baseline shapes) so the screenshot actually exercises S4's
        // fuller block set, then open Structure to show the tree populated.
        await page.getByRole('button', { name: 'Section trống', exact: true }).click();
        await page.locator('.builder-node-section').first().click();
        await page.getByRole('button', { name: 'Tiêu đề', exact: true }).click();
        const column = page.locator('.builder-node-column').first();
        await column.click();
        await page.getByRole('button', { name: 'Banner', exact: true }).click();
        await column.click();
        await page.getByRole('button', { name: 'Mạng xã hội', exact: true }).click();
        await page.locator('.builder-node-heading').first().click();
        await page.locator('.builder-inspector-field textarea').first().fill('Nghiệm thu S4 — đủ 5 vùng, 4 token, 4 đích rail');
        await page.getByRole('button', { name: 'Cấu trúc', exact: true }).click();
        await page.getByRole('button', { name: 'Mở rộng tất cả', exact: true }).click();
      } else if (viewport.width >= 1024) {
        await page.getByRole('button', { name: 'Section trống', exact: true }).click();
        await page.locator('.builder-node-section').first().click();
        await page.getByRole('button', { name: 'Tiêu đề', exact: true }).click();
        await page.locator('.builder-node-heading').first().click();
        await page.locator('.builder-inspector-field textarea').first().fill('Nghiệm thu S4');
      }

      mkdirSync(resolve(EVIDENCE_ROOT, 'production'), { recursive: true });
      await page.screenshot({ path: resolve(EVIDENCE_ROOT, 'production', `s4-acceptance-${viewport.name}.png`), fullPage: true });
    });
  }
});
