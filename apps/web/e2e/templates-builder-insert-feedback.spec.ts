import { expect, test } from '@playwright/test';
import { trackFixture } from './fixture-registry.js';

/**
 * ADR-044 -- what the author is told after inserting a block.
 *
 * A3/A4/A5/C9 from the drag-and-drop audit, which were four symptoms of one
 * thing: the insert path ended at `engine.addBlock` and stopped. Measured on
 * the running app before this, after clicking "Văn bản" and then "Hình ảnh":
 * `selectedId` was null both times, the inspector stayed on its empty state,
 * the asset picker never opened, and nothing was said about where either block
 * had gone -- while `insertNode` had quietly built a Section, a Row and a
 * Column for each of them.
 *
 * The prototype's `finishAdd` (studio.tsx:510) does all of it: selects, opens
 * the content tab, and for image kinds opens the asset panel on the new node.
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

async function builderTemplate(page: import('@playwright/test').Page): Promise<string> {
  const created = await page.evaluate(async (name) => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('eow_csrf='))?.split('=')[1] ?? '';
    const response = await fetch('/api/v1/templates', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ name, subject: 'Chèn khối', origin: 'builder' }),
    });
    if (!response.ok) throw new Error(`create -> ${response.status}`);
    return (await response.json()) as { id: string };
  }, `insert-fb-${Date.now()}`);
  trackFixture('templates', created.id);
  return created.id;
}

const insert = async (page: import('@playwright/test').Page, label: string) => {
  await page.locator('.v3-block-scroll button').filter({ hasText: label }).first().click();
  await page.waitForTimeout(500);
};

test.describe('Builder: inserting a block says what happened and where', () => {
  test('the new block is selected, the inspector opens on it, and the toast names the destination', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.focus-header').waitFor();
    await page.locator('.v3-rail button').first().waitFor();

    // First block on an empty canvas: containers have to be built for it, and
    // the message has to say so -- this is the case that produced "chèn xong
    // không biết nó đi đâu".
    const firstInsertAt = Date.now();
    await insert(page, 'Đoạn văn');
    await expect(page.locator('.builder-node-selected')).toHaveCount(1);
    await expect(page.locator('.v3-inspect-head b')).toHaveText('Đoạn văn');
    await expect(page.locator('.v3-tabs button.active')).toHaveText('Nội dung');
    await expect(page.locator('.toast')).toContainText('vào một Khối mới ở cuối email');

    // Second block, with the first selected: it lands in that column, and the
    // message is different because the outcome is different.
    await insert(page, 'Nút bấm');
    await expect(page.locator('.v3-inspect-head b')).toHaveText('Nút bấm');
    await expect(page.locator('.toast')).toContainText('vào Cột');

    /**
     * The toast has to survive a second insert. It did not: `notify` scheduled
     * a clear without cancelling the previous one, so the FIRST message's timer
     * wiped the second. Measured at 250ms intervals, the second toast lived
     * 1.0s instead of 3.0s, and two quick inserts left it showing nothing.
     * Inserting several blocks in a row is the normal way to use this panel.
     */
    await insert(page, 'Đường ngăn');
    /**
     * The moment to look is fixed against the FIRST insert, not as a delay
     * after the third, and both earlier versions of this were wrong in
     * opposite directions.
     *
     * The first message's 3s timer fires at t0+3000. That is the only instant
     * that distinguishes the two behaviours: with the timers cancelled the
     * third toast is still up, without them that timer has just wiped it. A
     * 1400ms delay after the third insert landed BEFORE t0+3000 and passed
     * either way -- blind. A 2200ms delay assumed each insert costs ~600ms, and
     * under suite load they cost more, so it landed after the third toast's own
     * expiry and failed on a healthy build.
     *
     * Anchoring to t0+3300 is immune to both: it is past the first timer by
     * 300ms, and the third toast does not expire until 3s after IT was set,
     * which is strictly later. Slower inserts only widen that window.
     */
    await page.waitForTimeout(Math.max(300, firstInsertAt + 3300 - Date.now()));
    await expect(page.locator('.toast'), 'the previous toast timer cut this one short').toContainText('Đường ngăn');
  });

  test('an image block points at the asset library without taking the palette away', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.v3-rail button').first().waitFor();

    await insert(page, 'Hình ảnh');
    await expect(page.locator('.v3-inspect-head b')).toHaveText('Hình ảnh');
    // The message names the next step...
    await expect(page.locator('.toast')).toContainText('Thư viện ảnh');
    /**
     * ...and the palette is still there. An earlier version of this switched
     * the rail to the asset panel, copying the prototype's `finishAdd` -- but
     * the prototype's picker is an overlay above the canvas and this rail
     * destination REPLACES the tool panel. Two acceptance specs timed out on a
     * palette button that had been swapped away, and a person inserting an
     * image and then reaching for another block would have watched their tools
     * disappear.
     */
    await expect(page.locator('.v3-rail button.active')).toContainText('Chèn khối');
    await expect(page.locator('.v3-block-scroll button').first()).toBeVisible();
  });

  test('every palette button says where its block goes, and shows it can be dragged', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.v3-block-scroll button').first().waitFor();

    /**
     * C9. `globals.css` has carried `.v3-block-scroll section>button small` and
     * `... > button em` since the port -- two rules with no element to style,
     * because the markup rendered only the icon and the label. The `em` is the
     * prototype's grip glyph and the only thing on screen saying these can be
     * dragged at all.
     */
    const readButton = (label: string) => page.evaluate((label) => {
      const button = Array.from(document.querySelectorAll('.v3-block-scroll button')).find((b) => (b.textContent ?? '').includes(label));
      if (!button) throw new Error(`no palette button for ${label}`);
      const grip = button.querySelector('em');
      return {
        hint: (button.querySelector('small')?.textContent ?? '').trim(),
        grip: (grip?.textContent ?? '').trim(),
        gripVisible: grip !== null && getComputedStyle(grip).display !== 'none',
        // Hiding the glyph must not quietly cost the drag: the layout tiles are
        // `draggable` in studio.tsx exactly as the plain buttons are.
        draggable: (button as HTMLElement).draggable,
      };
    }, label);

    // The hints come from `requiredParentKind`, the same function the insert
    // uses, so the panel cannot teach a rule the model does not follow.
    expect(await readButton('Đoạn văn')).toEqual({ hint: 'Nằm trong Cột', grip: '⠿', gripVisible: true, draggable: true });
    // Section and the six shapes render as `layout-option` tiles, and studio.css
    // hides the grip on those: `.v3-block-scroll .layout-section>button.layout-option>em
    // {display:none}`. The tile is a two-column grid with nowhere to put it. It
    // is still a drag source, which is what the `draggable` check is for -- the
    // glyph going away must not take the behaviour with it.
    expect(await readButton('Section trống')).toEqual({ hint: 'Lớp ngoài cùng của email', grip: '⠿', gripVisible: false, draggable: true });
    // A layout preset says its ratio instead -- `spec.widths.join(" / ")`, which
    // is studio.tsx's own sub-label and the only thing that tells these six
    // buttons apart.
    expect(await readButton('Trái hẹp · phải rộng')).toEqual({ hint: '35 / 65', grip: '⠿', gripVisible: false, draggable: true });
  });

  test('an unaimed click joins the last container instead of minting a Section', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.v3-rail button').first().waitFor();

    /**
     * D10. Clicking with nothing selected passed `null`, which sent
     * `insertNode` down its wrap-and-recurse path and built a fresh Section,
     * Row and Column each time -- measured, two clicks gave two one-block
     * sections, so an email became a stack of them. Deselecting between clicks
     * is what makes this visible; with a selection the blocks already chained.
     */
    const deselect = async () => { await page.locator('.v3-canvas').click({ position: { x: 5, y: 5 } }); await page.waitForTimeout(250); };
    await insert(page, 'Đoạn văn');
    await deselect();
    await insert(page, 'Tiêu đề');
    await deselect();
    await insert(page, 'Nút bấm');

    await expect(page.locator('.builder-node-section'), 'each unaimed click minted its own Section').toHaveCount(1);
    await expect(page.locator('.builder-node-column')).toHaveCount(1);
    await expect(page.locator(`${'.builder-node.v3-leaf:not(.builder-node-ghost)'}`)).toHaveCount(3);
  });

  test('the bare canvas says what a drop there will do', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.v3-rail button').first().waitFor();
    await insert(page, 'Đoạn văn');

    /**
     * B7. The canvas background accepts drops and builds a Section, a Row and a
     * Column around whatever lands there -- the largest consequence of any drop
     * target on the screen, and the only one that showed nothing on the way in.
     */
    const overBackground = await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const canvas = document.querySelector('.v3-canvas') as HTMLElement;
      const box = canvas.getBoundingClientRect();
      const transfer = new DataTransfer();
      const source = Array.from(document.querySelectorAll('.v3-block-scroll button')).find((b) => (b.querySelector('b')?.textContent ?? '').trim() === 'Tiêu đề')!;
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await sleep(160);
      canvas.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + box.width / 2, clientY: box.bottom - 30 }));
      await sleep(320);
      const indicator = document.querySelector('.builder-drop-indicator');
      const result = {
        shown: indicator !== null,
        // At root level the indicator belongs to the email body itself, not to
        // any node's children -- there is no block it sits beside.
        host: indicator ? Array.from(indicator.parentElement!.classList).join('.') : null,
        outlined: document.querySelectorAll('.builder-node-drop-target').length,
      };
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
      await sleep(250);
      return { ...result, cleared: document.querySelector('.builder-drop-indicator') === null };
    });

    expect(overBackground.shown, 'the drop with the biggest consequence still showed nothing').toBe(true);
    expect(overBackground.host).toContain('v3-email');
    expect(overBackground.outlined, 'nothing is being positioned against, so nothing should be outlined').toBe(0);
    expect(overBackground.cleared).toBe(true);
  });

  test('an empty Section and an empty Column each say what belongs in them', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.v3-rail button').first().waitFor();

    /**
     * B8. One generic sentence served both levels and taught neither. The
     * prototype uses this exact spot to say which level takes what, which is
     * cheaper than any tooltip because it is already where the cursor is going.
     */
    await insert(page, 'Section trống');
    await expect(page.locator('.v3-empty-section')).toContainText('bố cục');
    // The preset brings the Row and its empty columns in one click, which is the
    // only way to reach a bare Column now that the invented palette buttons are
    // gone.
    await insert(page, 'Hai cột đều');
    await expect(page.locator('.v3-empty-col').first()).toContainText('thành phần');
  });
});
