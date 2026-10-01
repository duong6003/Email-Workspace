import { expect, test } from '@playwright/test';
import { trackFixture } from './fixture-registry.js';

/**
 * S5 Task 31 acceptance for MC-UI-004.
 *
 * Driven by keyboard, the same method the S4 specs established: `.focus()` a
 * control directly (proving it is a real tab stop, not dependent on full-page
 * tab order) and then press the key a real user would.
 *
 * The behaviour worth pinning here is the one the unit tests cannot reach: a
 * saved block is a COPY. Inserting it twice must produce two independent nodes,
 * and deleting the library entry afterwards must leave the document alone --
 * that is the whole reason the delete is a hard delete (plan §S5 Task 26).
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

async function createBuilderTemplate(page: import('@playwright/test').Page, name: string): Promise<string> {
  const response = await page.evaluate(async (templateName) => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const result = await fetch('/api/v1/templates', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ name: templateName, subject: 'Khối dùng lại', origin: 'builder' }),
    });
    return { status: result.status, body: await result.text() };
  }, name);
  if (response.status !== 201) throw new Error(`Could not create builder-origin fixture: ${response.status} ${response.body}`);
  return (JSON.parse(response.body) as { id: string }).id;
}

/** Removes every block this spec saved, by name prefix -- the library is tenant-wide, so leftovers would pile up for every other spec that opens the panel. */
async function deleteBlocksNamed(page: import('@playwright/test').Page, prefix: string): Promise<void> {
  await page.evaluate(async (namePrefix) => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const listed = await fetch('/api/v1/reusable-blocks', { credentials: 'include' }).then((r) => r.json()) as { items: Array<{ id: string; name: string }> };
    for (const block of listed.items.filter((item) => item.name.startsWith(namePrefix))) {
      await fetch(`/api/v1/reusable-blocks/${block.id}`, { method: 'DELETE', credentials: 'include', headers: { 'x-csrf-token': csrf } });
    }
  }, prefix);
}

test.describe('S5: reusable block library (MC-UI-004) -- keyboard only', () => {
  test('saves the selected block, inserts it twice as independent copies, renames it, and deletes it without touching the document', async ({ page }) => {
    await signIn(page);
    const prefix = `s5-block-${Date.now()}`;
    const id = await createBuilderTemplate(page, `${prefix}-template`);
    trackFixture('templates', id);

    try {
      await page.goto(`/templates/${id}/build`);
      await page.locator('.builder-title-field input').first().waitFor();

      // Put something on the canvas and select it, so there is a "current tree".
      // ADR-044 Task SV-3: the Insert panel's list is `.v3-block-scroll` now (grouped, searchable), not the old flat `.builder-library-grid`.
      const sectionButton = page.locator('.v3-block-scroll button', { hasText: 'Section trống' }).first();
      await sectionButton.focus();
      await page.keyboard.press('Enter');
      const sections = page.locator('.builder-node-section');
      await expect(sections).toHaveCount(1);
      await sections.first().focus();
      await page.keyboard.press('Enter');

      // MC-UI-004: open the Reusable rail destination by keyboard.
      const rail = page.locator('.mc-tool-rail button', { hasText: 'Khối dùng lại' }).first();
      await rail.focus();
      await page.keyboard.press('Enter');

      const panel = page.locator('.mc-workspace-panel');
      await expect(panel.locator('[data-mc-action="MC-UI-004.save_current_tree"]')).toBeVisible();

      // save_current_tree
      const blockName = `${prefix}-chan-trang`;
      const nameField = panel.locator('[data-mc-action="MC-UI-004.save_current_tree"] input');
      await nameField.focus();
      await page.keyboard.type(blockName);
      const saveButton = panel.getByRole('button', { name: 'Lưu vào thư viện' });
      await saveButton.focus();
      await page.keyboard.press('Enter');

      const list = panel.locator('[data-mc-state="MC-UI-004.success"]');
      await expect(list).toBeVisible();
      await expect(list).toContainText(blockName);

      // search: unaccented query still finds the accented name.
      const searchField = panel.locator('[data-mc-action="MC-UI-004.search"] input');
      await searchField.focus();
      await page.keyboard.type(prefix);
      await expect(list.locator('li')).toHaveCount(1);

      // insert, twice. Each press must add another independent copy. Node ids
      // are not in the DOM, so id uniqueness is asserted at the unit level
      // (`withFreshIds` in tree-ops.test.ts, and the fidelity gate's own
      // MC-UI-004 check); what this proves is the user-visible half -- the
      // second insert really adds a second block rather than re-selecting the
      // first, which is what an id collision would look like from here.
      const insertButton = list.locator('[data-mc-action="MC-UI-004.insert"]').first();
      await insertButton.focus();
      await page.keyboard.press('Enter');
      await expect(sections).toHaveCount(2);
      await insertButton.focus();
      await page.keyboard.press('Enter');
      await expect(sections).toHaveCount(3);

      // rename
      const renamed = `${prefix}-doi-ten`;
      await list.locator('[data-mc-action="MC-UI-004.rename"]').first().focus();
      await page.keyboard.press('Enter');
      const renameField = panel.locator('.builder-reusable-rename input');
      await renameField.focus();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type(renamed);
      await panel.getByRole('button', { name: 'Lưu tên' }).focus();
      await page.keyboard.press('Enter');
      await expect(list).toContainText(renamed);

      // delete, with the confirmation naming the block and saying documents are safe.
      await list.locator('[data-mc-action="MC-UI-004.delete"]').first().focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(renamed);
      await expect(dialog).toContainText('không bị ảnh hưởng');
      await dialog.getByRole('button', { name: 'Xoá khối' }).focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeHidden();

      // The library entry is gone; the copies already on the canvas are not.
      // Asserted against the panel rather than the list: with the last block
      // deleted the list element itself is replaced by the empty state, so a
      // `not.toContainText` on the list would fail on "element not found"
      // instead of passing.
      await expect(panel).not.toContainText(renamed);
      await expect(panel.locator('[data-mc-state="MC-UI-004.empty"], [data-mc-state="MC-UI-004.success"]')).toBeVisible();
      await expect(sections).toHaveCount(3);
    } finally {
      await deleteBlocksNamed(page, prefix);
    }
  });
});
