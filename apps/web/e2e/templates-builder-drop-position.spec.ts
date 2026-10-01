import { expect, test } from '@playwright/test';
import { trackFixture } from './fixture-registry.js';

/**
 * ADR-044 -- a dropped block lands where the cursor said it would.
 *
 * Before this, `insertNode` resolved a CONTAINER from the drop target and
 * pushed onto the end of it, so dropping on the first, middle or last child of
 * a column produced the identical document -- measured, all three gave
 * `[a, b, c, new]`. The canvas drew a dashed outline around the block under the
 * cursor the whole time, which made the position look meaningful when it was
 * not. `tree-ops.test.ts` and `engine.test.ts` cover the model; this covers the
 * half that only exists in a browser: that the pointer's Y coordinate reaches
 * that model at all, and that what the author is shown mid-drag matches what
 * the drop then does.
 *
 * The drag is synthesised rather than driven with mouse moves. Playwright's
 * pointer input does not raise HTML5 drag events, so a real `DataTransfer`
 * carried across dragstart/dragover/drop is the only way to exercise the code
 * path the browser actually runs. The payload type is the app's own
 * `DRAG_BLOCK_KIND_TYPE`.
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';
/** The ghost carries `.builder-node.v3-leaf` so it looks like what it previews -- it must never be counted as one. It has no per-kind class, which is what keeps every other spec's `.builder-node-<kind>` selector unambiguous. */
const REAL_LEAVES = '.builder-node.v3-leaf:not(.builder-node-ghost)';

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
      body: JSON.stringify({ name, subject: 'Kéo thả', origin: 'builder' }),
    });
    if (!response.ok) throw new Error(`create -> ${response.status}`);
    return (await response.json()) as { id: string };
  }, `drop-pos-${Date.now()}`);
  trackFixture('templates', created.id);
  return created.id;
}

/** Click-to-insert, which deliberately has no position: a click is not over a block, so it appends. */
async function insertByClick(page: import('@playwright/test').Page, label: string) {
  await page.locator('.v3-block-scroll button').filter({ hasText: label }).first().click();
  await page.waitForTimeout(400);
}

type DragResult = { indicatorShown: boolean; indicatorSide: 'before' | 'after' | null; ghostText: string; lineShown: boolean; cleared: boolean };

/**
 * Drags `label` from the insert panel onto the leaf at `index`, releasing in
 * the top or bottom half of it, and reports what the author saw on the way.
 */
async function dragOnto(
  page: import('@playwright/test').Page,
  label: string,
  index: number,
  half: 'top' | 'bottom',
): Promise<DragResult> {
  return page.evaluate(async ({ label, index, half, REAL_LEAVES }) => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const leaves = () => Array.from(document.querySelectorAll(REAL_LEAVES));
    const transfer = new DataTransfer();
    const source = Array.from(document.querySelectorAll('.v3-block-scroll button')).find((b) => (b.querySelector('b')?.textContent ?? '').trim() === label);
    if (!source) throw new Error(`no palette button for ${label}`);
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    await sleep(120);

    const target = leaves()[index];
    if (!target) throw new Error(`no leaf at index ${index}`);
    const box = target.getBoundingClientRect();
    const y = half === 'top' ? box.top + 2 : box.bottom - 2;
    const at = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + 20, clientY: y };
    target.dispatchEvent(new DragEvent('dragover', at));
    await sleep(220);

    const indicator = document.querySelector('.builder-drop-indicator');
    const side = indicator
      ? ((target.compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_FOLLOWING) > 0 ? 'after' : 'before')
      : null;
    const result = {
      indicatorShown: indicator !== null,
      indicatorSide: side as 'before' | 'after' | null,
      ghostText: (indicator?.querySelector('.builder-node-ghost')?.textContent ?? '').trim(),
      lineShown: indicator?.querySelector('.builder-drop-line') !== null && indicator !== null,
    };

    target.dispatchEvent(new DragEvent('drop', at));
    await sleep(700);
    return { ...result, cleared: document.querySelector('.builder-drop-indicator') === null };
  }, { label, index, half, REAL_LEAVES });
}

const labels = (page: import('@playwright/test').Page) =>
  page.locator(`${REAL_LEAVES} .builder-node-tag`).allTextContents();

test.describe('Builder: a dropped block lands where the cursor pointed', () => {
  test('drop position decides the index, and the indicator shows it first', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.focus-header').waitFor();
    await page.locator('.v3-rail button').first().waitFor();

    await insertByClick(page, 'Đoạn văn');
    await insertByClick(page, 'Đoạn văn');
    await insertByClick(page, 'Đoạn văn');
    expect((await labels(page)).map((t) => t.replace('✓ ', ''))).toEqual(['Đoạn văn', 'Đoạn văn', 'Đoạn văn']);

    // Released in the TOP half of the first block: it goes in front of it.
    const first = await dragOnto(page, 'Tiêu đề', 0, 'top');
    expect(first.indicatorShown, 'nothing told the author where the block would land').toBe(true);
    expect(first.lineShown).toBe(true);
    expect(first.indicatorSide, 'the line must be drawn on the side the cursor was on').toBe('before');
    // The ghost is the block's real canvas rendering, so it carries the real
    // default content rather than a placeholder shape.
    expect(first.ghostText).toContain('Tiêu đề phần mới');
    expect(first.cleared, 'the indicator outlived the drag it belonged to').toBe(true);
    expect((await labels(page)).map((t) => t.replace('✓ ', ''))).toEqual(['Tiêu đề', 'Đoạn văn', 'Đoạn văn', 'Đoạn văn']);

    // Released in the BOTTOM half of that same first block: it goes after it.
    // Under the old append-only behaviour both of these drops produced the same
    // document, which is the regression this pair exists to catch.
    const second = await dragOnto(page, 'Nút bấm', 0, 'bottom');
    expect(second.indicatorSide).toBe('after');
    expect((await labels(page)).map((t) => t.replace('✓ ', ''))).toEqual(['Tiêu đề', 'Nút bấm', 'Đoạn văn', 'Đoạn văn', 'Đoạn văn']);

    // And the last block's bottom half still means "last", which is the one
    // position the old behaviour also produced -- now for the right reason.
    const third = await dragOnto(page, 'Đường ngăn', 4, 'bottom');
    expect(third.indicatorSide).toBe('after');
    expect((await labels(page)).map((t) => t.replace('✓ ', ''))).toEqual(['Tiêu đề', 'Nút bấm', 'Đoạn văn', 'Đoạn văn', 'Đoạn văn', 'Đường ngăn']);
  });

  test('a container block draws its line at the level it actually lands', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.focus-header').waitFor();
    await page.locator('.v3-rail button').first().waitFor();
    await insertByClick(page, 'Đoạn văn');

    /**
     * The bug this pins: the indicator drew beside whatever the cursor was
     * over, which is only the destination for LEAF kinds. Dropping a Row on a
     * text leaf lands beside that leaf's Row -- two levels up -- and the line
     * was still drawn inside the Column, next to the text. Measured on the
     * running app before the fix: indicator inside `.builder-node-children` of
     * the Column at y=162 against a leaf at y=158, while the Row arrived as
     * `section > [row(new), row > column > text]`.
     *
     * So the assertion is not "an indicator appeared" -- that was always true.
     * It is "the indicator's own container is the node that receives the
     * block", which is the thing that was false.
     */
    const hostFor = (label: string) => page.evaluate(async (label) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const leaf = document.querySelector('.builder-node.v3-leaf:not(.builder-node-ghost)') as HTMLElement;
      const box = leaf.getBoundingClientRect();
      const transfer = new DataTransfer();
      const source = Array.from(document.querySelectorAll('.v3-block-scroll button')).find((b) => (b.querySelector('b')?.textContent ?? '').trim() === label)!;
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await sleep(140);
      const at = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + 20, clientY: box.top + 2 };
      leaf.dispatchEvent(new DragEvent('dragover', at));
      await sleep(260);
      const indicator = document.querySelector('.builder-drop-indicator');
      // The indicator sits in a container's `.builder-node-children`, so its
      // grandparent is the node that will hold the block.
      const holder = indicator?.parentElement?.parentElement ?? null;
      const holderKind = holder ? (Array.from(holder.classList).find((c) => c.startsWith('builder-node-')) ?? holder.className) : null;
      const outlined = Array.from(document.querySelectorAll('.builder-node-drop-target'))
        .map((n) => Array.from(n.classList).find((c) => c.startsWith('builder-node-') && c !== 'builder-node-drop-target'));
      leaf.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
      await sleep(200);
      return { holderKind, outlined };
    }, label);

    // What the drop will AFFECT, not just where it lands. The dashed outline
    // marks the block being positioned against; on its own it says nothing about
    // the container that is going to change. Both are now drawn, and they are
    // drawn differently: the ring is on the receiver, the dashes on the anchor.
    const marks = await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const leaf = document.querySelector('.builder-node.v3-leaf:not(.builder-node-ghost)') as HTMLElement;
      const box = leaf.getBoundingClientRect();
      const transfer = new DataTransfer();
      const source = Array.from(document.querySelectorAll('.v3-block-scroll button')).find((b) => (b.querySelector('b')?.textContent ?? '').trim() === 'Tiêu đề')!;
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await sleep(140);
      leaf.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + 20, clientY: box.top + 2 }));
      await sleep(260);
      const kindsOf = (selector: string) => Array.from(document.querySelectorAll(selector))
        .map((n) => Array.from(n.classList).find((c) => c.startsWith('builder-node-') && !c.startsWith('builder-node-drop')));
      const receiver = document.querySelector('.builder-node-drop-container');
      const ring = receiver ? getComputedStyle(receiver).boxShadow : 'none';
      const result = { receivers: kindsOf('.builder-node-drop-container'), anchors: kindsOf('.builder-node-drop-target'), ring };
      leaf.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
      await sleep(200);
      return result;
    });

    expect(marks.receivers, 'exactly one container is marked as the one that will change').toEqual(['builder-node-column']);
    expect(marks.anchors, 'and the block being positioned against keeps its own mark').toEqual(['builder-node-text']);
    expect(marks.ring, 'the receiver is drawn with a ring, not left to colour alone').not.toBe('none');

    // A layout dropped on a leaf nests inside that leaf's Column -- studio.tsx's
    // `accepts()` lets a Column hold a Row, and its `add()` sends anything aimed
    // below a Section through `columnForTarget`. It used to climb out to the
    // Section and land there, which is a different email.
    // The outline marks the block being positioned AGAINST -- the leaf under the
    // cursor -- while the holder is the container that receives the drop. Both
    // are the Column's business now, which is the change: this used to report
    // the Section.
    expect(await hostFor('Hai cột đều')).toEqual({ holderKind: 'builder-node-column', outlined: ['builder-node-text'] });
    // A leaf still lands among a Column's children -- the case that always worked.
    expect(await hostFor('Tiêu đề')).toEqual({ holderKind: 'builder-node-column', outlined: ['builder-node-text'] });
  });

  test('a block already on the canvas can be dragged to a new position', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.focus-header').waitFor();
    await page.locator('.v3-rail button').first().waitFor();

    /**
     * A1 from the audit. The port carried the drop half of the prototype's
     * canvas and none of the drag half: measured, the whole builder had exactly
     * ONE draggable element, the palette button, so a block once placed could
     * only be nudged with the inspector's up/down pair. The prototype makes
     * every leaf a drag source (`studio.tsx:822`).
     */
    await insertByClick(page, 'Đoạn văn');
    await page.locator(REAL_LEAVES).first().click();
    await page.waitForTimeout(300);
    await insertByClick(page, 'Nút bấm');
    await page.locator(REAL_LEAVES).first().click();
    await page.waitForTimeout(300);
    await insertByClick(page, 'Tiêu đề');
    const order = async () => (await labels(page)).map((t) => t.replace('✓ ', ''));
    expect(await order()).toEqual(['Đoạn văn', 'Nút bấm', 'Tiêu đề']);

    /**
     * Asserted separately, and first, because the rest of this test cannot see
     * it. The drag below is synthesised -- Playwright's pointer input does not
     * raise HTML5 drag events -- and a synthetic `dragstart` runs the React
     * handler whether or not the element is actually draggable. So every
     * assertion after this one passes on a canvas no real user can drag from.
     * Found by mutation: setting `draggable={false}` left this whole spec green
     * until this check existed.
     */
    const draggability = await page.evaluate(() => ({
      leaves: Array.from(document.querySelectorAll('.builder-node.v3-leaf:not(.builder-node-ghost)')).map((n) => (n as HTMLElement).draggable),
      containers: Array.from(document.querySelectorAll('.builder-node.v3-column, .builder-node.v3-section, .builder-node.v3-row')).map((n) => (n as HTMLElement).draggable),
    }));
    expect(draggability.leaves.every(Boolean), 'a canvas block that cannot be picked up is not draggable, whatever the handlers do').toBe(true);
    expect(draggability.leaves.length).toBeGreaterThan(0);
    // Containers stay targets only, as in the prototype: a draggable Section
    // would start a drag from anywhere inside it.
    expect(draggability.containers.some(Boolean), 'containers must not be drag sources').toBe(false);

    const moveLast = (toIndex: number) => page.evaluate(async (toIndex) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const leaves = () => Array.from(document.querySelectorAll('.builder-node.v3-leaf:not(.builder-node-ghost)')) as HTMLElement[];
      const source = leaves()[leaves().length - 1]!;
      const target = leaves()[toIndex]!;
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await sleep(200);
      const carried = transfer.types.slice();
      const dimmed = document.querySelectorAll('.builder-node-moving').length;
      const box = target.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + 20, clientY: box.top + 2 };
      target.dispatchEvent(new DragEvent('dragover', at));
      await sleep(280);
      const ghost = (document.querySelector('.builder-drop-indicator .builder-node-ghost')?.textContent ?? '').trim();
      target.dispatchEvent(new DragEvent('drop', at));
      await sleep(800);
      return { carried, dimmed, ghost };
    }, toIndex);

    const moved = await moveLast(0);
    // The payload is the node id, not a catalog kind: this drop relocates.
    expect(moved.carried).toEqual(['application/x-mailcraft-node']);
    // The block is shown twice mid-drag -- ghost and origin -- so the origin dims.
    expect(moved.dimmed, 'the block being moved was not distinguished from the ghost of itself').toBe(1);
    // The ghost is the moved block's own content, not a catalog default.
    expect(moved.ghost).toContain('Tiêu đề phần mới');
    expect(await order()).toEqual(['Tiêu đề', 'Đoạn văn', 'Nút bấm']);

    // Undo puts it back: a mis-drop is the most likely thing to want back.
    await page.locator('.focus-header button[aria-label="Hoàn tác"]').click();
    await page.waitForTimeout(700);
    expect(await order()).toEqual(['Đoạn văn', 'Nút bấm', 'Tiêu đề']);

    // Dropping a block on itself is refused, and says so by showing nothing.
    const onSelf = await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const leaf = document.querySelector('.builder-node.v3-leaf:not(.builder-node-ghost)') as HTMLElement;
      const transfer = new DataTransfer();
      leaf.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await sleep(180);
      const box = leaf.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + 20, clientY: box.top + 2 };
      leaf.dispatchEvent(new DragEvent('dragover', at));
      await sleep(280);
      const indicator = document.querySelector('.builder-drop-indicator') !== null;
      leaf.dispatchEvent(new DragEvent('drop', at));
      await sleep(600);
      return indicator;
    });
    expect(onSelf, 'an indicator promised a move the model refuses').toBe(false);
    expect(await order()).toEqual(['Đoạn văn', 'Nút bấm', 'Tiêu đề']);
  });

  test('a saved library block can be dragged onto the canvas, not just clicked', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.v3-rail button').first().waitFor();
    await insertByClick(page, 'Đoạn văn');

    /**
     * A2. The prototype's saved blocks are drag sources (`studio.tsx:762`,
     * payload `mc/saved`); the port offered click-to-insert only, so a library
     * block could be added but never aimed. The id travels, not the tree -- the
     * tree lives on the server -- so the drag starts the fetch and the
     * indicator waits for it rather than drawing a placeholder.
     */
    const blockName = `Khối kéo thả ${Date.now()}`;
    await page.evaluate(async (name) => {
      const csrf = document.cookie.split('; ').find((v) => v.startsWith('eow_csrf='))?.split('=')[1] ?? '';
      const node = { id: 'saved-row', kind: 'row', visible: true, children: [
        { id: 'saved-col', kind: 'column', visible: true, children: [
          { id: 'saved-text', kind: 'text', visible: true, content: 'Nội dung khối đã lưu', align: 'left' },
        ] },
      ] };
      const response = await fetch('/api/v1/reusable-blocks', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ name, node }),
      });
      if (!response.ok) throw new Error(`create block -> ${response.status}`);
    }, blockName);

    await page.locator('.v3-rail button').filter({ hasText: 'Khối dùng lại' }).click();
    /**
     * By NAME, never `.first()`. Reusable blocks are tenant-scoped and this
     * suite does not clean them up, so the library fills with leftovers from
     * earlier runs -- and `.first()` quietly dragged one of those. The tell was
     * a toast naming a block whose timestamp came from a previous run.
     */
    const libraryItem = page.locator('.builder-reusable-insert').filter({ hasText: blockName });
    await libraryItem.waitFor();
    expect(await libraryItem.evaluate((el) => (el as HTMLElement).draggable), 'a library block that cannot be picked up is not draggable').toBe(true);

    const dropped = await page.evaluate(async (name) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const item = Array.from(document.querySelectorAll('.builder-reusable-insert')).find((b) => (b.textContent ?? '').includes(name)) as HTMLElement;
      if (!item) throw new Error(`no library item named ${name}`);
      const transfer = new DataTransfer();
      item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      const carried = transfer.types.slice();
      // The tree is fetched by the dragstart; give it a moment to land.
      await sleep(900);
      const leaf = document.querySelector('.builder-node.v3-leaf:not(.builder-node-ghost)') as HTMLElement;
      const box = leaf.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + 20, clientY: box.top + 2 };
      leaf.dispatchEvent(new DragEvent('dragover', at));
      await sleep(350);
      const indicator = document.querySelector('.builder-drop-indicator');
      const holder = indicator?.parentElement?.parentElement ?? null;
      const result = {
        carried,
        // The saved block's root is a Row, so it belongs among a Section's
        // children -- not beside the text leaf the cursor was over.
        holderKind: holder ? (Array.from(holder.classList).find((c) => c.startsWith('builder-node-')) ?? null) : null,
        ghost: (indicator?.querySelector('.builder-node-ghost')?.textContent ?? '').trim(),
      };
      leaf.dispatchEvent(new DragEvent('drop', at));
      // Short: the toast this test reads clears itself after 3s, and every
      // millisecond spent here is one the assertions below do not have.
      await sleep(500);
      return result;
    }, blockName);

    expect(dropped.carried).toEqual(['application/x-mailcraft-reusable']);
    // A saved block is a Row, and a Row aimed at a leaf now nests inside that
    // leaf's Column -- studio.tsx's `accepts()` allows it and its `add()` routes
    // there. This read `builder-node-section` while EOW still gave every kind a
    // single legal parent.
    expect(dropped.holderKind).toBe('builder-node-column');
    expect(dropped.ghost).toContain('Hàng');
    // The toast goes first because it clears itself after 3s -- putting the
    // structural checks ahead of it spends that budget and reads as a missing
    // message. It names the block, not the kind of its root node.
    await expect(page.locator('.toast')).toContainText(blockName);
    // The subtree arrives whole, with its own content.
    await expect(page.locator('.builder-node-row')).toHaveCount(2);
    await expect(page.locator('.v3-canvas')).toContainText('Nội dung khối đã lưu');
  });
});
