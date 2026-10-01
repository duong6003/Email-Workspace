import { expect, test } from '@playwright/test';
import { trackFixture } from './fixture-registry.js';

/**
 * S4 Task 23. What the pre-fix build actually did on a `412`, measured against
 * the packaged stack rather than inferred from reading the code:
 *
 *   1. 'failed' returned the rejected patch to `pending`.
 *   2. `load()` dispatched 'saved'; the reducer re-applies `pending` over the
 *      loaded draft, so status went straight back to 'idle' -- out of the
 *      conflict state in the same tick.
 *   3. The autosave effect, no longer seeing 'conflict', re-sent the same patch
 *      against the fresh `draftRevision`. It succeeded.
 *
 * Nothing of the local user's was lost. The OTHER session's was: with both
 * sessions editing one field, the server ended up holding this tab's value, the
 * other tab's write gone, and the header reading "Đã lưu". A conflict resolved
 * silently in the local user's favour is exactly what spec §2.7 forbids
 * ("Không được lặng lẽ ghi đè"), and it is why that section requires a fifth
 * autosave state plus a comparison the user chooses from.
 *
 * Both tests below fail on the pre-fix build (verified 2026-09-03 by rebuilding
 * the web image from the reverted screen). The unit level cannot cover this: the
 * reducer was always correct, and web has no component-render test (spec §2.1).
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';
const OTHER_SESSION_NAME = 'Tên do phiên khác đặt';
const MY_NAME = 'Tên tôi vừa gõ';

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
      body: JSON.stringify({ name: templateName, subject: 'Xung đột phiên bản', origin: 'builder' }),
    });
    return { status: result.status, body: await result.text() };
  }, name);
  if (response.status !== 201) throw new Error(`Could not create builder-origin fixture: ${response.status} ${response.body}`);
  return (JSON.parse(response.body) as { id: string }).id;
}

/**
 * Stands in for the second session. It writes the SAME field this tab is about
 * to edit -- a different field would let both changes merge cleanly and prove
 * nothing about who wins.
 */
async function saveFromAnotherSession(page: import('@playwright/test').Page, id: string): Promise<void> {
  const response = await page.evaluate(async ({ templateId, nextName }) => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const current = await fetch(`/api/v1/templates/${templateId}`, { credentials: 'include' }).then((r) => r.json()) as { draftRevision: number };
    const result = await fetch(`/api/v1/templates/${templateId}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'if-match': String(current.draftRevision) },
      body: JSON.stringify({ name: nextName }),
    });
    return { status: result.status, body: await result.text() };
  }, { templateId: id, nextName: OTHER_SESSION_NAME });
  if (response.status !== 200) throw new Error(`Second-session save failed: ${response.status} ${response.body}`);
}

async function nameOnServer(page: import('@playwright/test').Page, id: string): Promise<string> {
  return await page.evaluate(async (templateId) => {
    const result = await fetch(`/api/v1/templates/${templateId}`, { credentials: 'include' });
    return (await result.json() as { name: string }).name;
  }, id);
}

/** Opens the builder, lets the other session save first, then edits into the conflict. */
async function reachConflict(page: import('@playwright/test').Page): Promise<{ id: string; nameField: ReturnType<typeof page.locator> }> {
  await signIn(page);
  const id = await createBuilderTemplate(page, `s4-conflict-${Date.now()}`);
  trackFixture('templates', id);

  await page.goto(`/templates/${id}/build`);
  const nameField = page.locator('.builder-title-field input').first();
  await nameField.waitFor();

  await saveFromAnotherSession(page, id);
  await nameField.fill(MY_NAME);

  // Autosave fires ~500ms after the edit and is rejected with 412.
  await expect(page.locator('[data-mc-state="MC-UI-001.revision_conflict"]')).toBeVisible({ timeout: 10_000 });
  return { id, nameField };
}

test.describe('S4 Task 23: a 412 asks instead of deciding', () => {
  test('holds in the fifth autosave state and offers both sides, with the local edit intact', async ({ page }) => {
    const { id, nameField } = await reachConflict(page);
    const conflict = page.locator('[data-mc-state="MC-UI-001.revision_conflict"]');

    await expect(nameField).toHaveValue(MY_NAME);

    // Spec §2.7's fifth state. Pre-fix this read "Đã lưu" -- reporting success
    // at the moment the server had refused the write.
    await expect(page.locator('.focus-header')).toContainText('Bản nháp đã bị thay đổi ở nơi khác');

    await expect(conflict).toContainText('Tên template');
    await expect(conflict.getByRole('button', { name: 'Dùng bản trên máy chủ' })).toBeEnabled();
    await expect(conflict.getByRole('button', { name: 'Giữ thay đổi của tôi' })).toBeEnabled();

    // Nothing has been written while the question is open: the other session's
    // value is still what the server holds. Pre-fix, the retry had already
    // landed by this point and this read back MY_NAME.
    expect(await nameOnServer(page, id)).toBe(OTHER_SESSION_NAME);

    await conflict.getByRole('button', { name: 'Giữ thay đổi của tôi' }).click();
    await expect(conflict).toBeHidden();
    await expect(page.locator('.focus-header')).toContainText('Đã lưu', { timeout: 10_000 });
    expect(await nameOnServer(page, id)).toBe(MY_NAME);
  });

  test('"dùng bản trên máy chủ" really discards the local edit rather than re-sending it', async ({ page }) => {
    const { id, nameField } = await reachConflict(page);
    const conflict = page.locator('[data-mc-state="MC-UI-001.revision_conflict"]');

    await conflict.getByRole('button', { name: 'Dùng bản trên máy chủ' }).click();
    await expect(conflict).toBeHidden();

    // The whole screen takes the server's draft -- including the field the user
    // had been typing in, which is the half a "reload" would have been expected
    // to do and the pre-fix code never did.
    await expect(nameField).toHaveValue(OTHER_SESSION_NAME);

    // And no queued patch flushes afterwards to undo the choice.
    await page.waitForTimeout(2_000);
    expect(await nameOnServer(page, id)).toBe(OTHER_SESSION_NAME);
  });
});
