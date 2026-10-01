import { expect, test } from '@playwright/test';
import { trackFixture } from './fixture-registry.js';

/**
 * ADR-044 -- one block reads as one block.
 *
 * The nesting itself is real and cannot go away: a block lives in a Column,
 * inside a Row, inside a Section, because that is the shape `emitter.ts` needs
 * to build a table-based email. `requiredParentKind` builds the chain on the
 * author's behalf and is right to.
 *
 * What was wrong is that EOW DREW all four levels, permanently. `.builder-node`
 * -- the canvas styling from before the prototype was ported -- puts a 1px
 * border, 8px of padding and an 8px margin on every node, container or not, and
 * `CanvasNodeView` renders every node's green name badge whether or not that
 * node is selected. So a single dropped heading arrived as four boxes inside
 * each other with three badges stacked over them.
 *
 * `studio.css` gives `.v3-node` no border, no padding and no margin at all --
 * only `outline:1px solid transparent`, turned visible on hover and thickened
 * on `.active` -- and `studio.tsx`'s `CanvasNode` renders its `<Tag>` behind
 * `{active && ...}`. The structure is there to be revealed by pointing at it,
 * not drawn over the email at rest.
 *
 * Both classes were ported. Neither took effect, because the older rules were
 * still winning, and no gate compares the two: `ARCH-MAILCRAFT-DOM` checks that
 * the prototype's class names are present, which they were.
 *
 * The badge stays in the DOM at zero opacity rather than being removed when
 * unselected: it is the accessible name of the node's `role="button"`, and a
 * canvas where only the selected block has a name is worse than a busy one.
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
      body: JSON.stringify({ name, subject: 'Khung canvas', origin: 'builder' }),
    });
    if (!response.ok) throw new Error(`create -> ${response.status}`);
    return (await response.json()) as { id: string };
  }, `chrome-${Date.now()}`);
  trackFixture('templates', created.id);
  return created.id;
}

async function insertByClick(page: import('@playwright/test').Page, label: string) {
  await page.evaluate((wanted) => {
    const button = Array.from(document.querySelectorAll('.v3-block-scroll section > button'))
      .find((candidate) => (candidate.querySelector('b')?.textContent ?? '').trim() === wanted);
    if (!button) throw new Error(`no palette button for ${wanted}`);
    (button as HTMLElement).click();
  }, label);
  await page.waitForTimeout(400);
}

async function openBuilderWithOneHeading(page: import('@playwright/test').Page) {
  await signIn(page);
  const id = await builderTemplate(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/templates/${id}/build`);
  await page.locator('.v3-rail button').first().waitFor();
  // One click on an empty canvas: `requiredParentKind` builds Section, Row and
  // Column around it, which is exactly the four-level case in question.
  await insertByClick(page, 'Tiêu đề');
  await expect(page.locator('.builder-node-heading')).toHaveCount(1);
}

test.describe('Canvas chrome: the structure is revealed, not drawn', () => {
  test('a block dropped into a fresh canvas reads as one box, not four', async ({ page }) => {
    test.setTimeout(120_000);
    await openBuilderWithOneHeading(page);

    const measured = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`missing ${selector}`);
        const style = getComputedStyle(el);
        return {
          left: el.getBoundingClientRect().left,
          border: Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderLeftWidth),
          padding: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingLeft),
          paddingLeft: Number.parseFloat(style.paddingLeft),
        };
      };
      // The stage is transform-scaled by the zoom control (90% by default), so
      // `getBoundingClientRect` comes back scaled while `getComputedStyle`
      // reports the unscaled CSS value. Comparing the two directly reads 16.2
      // against 18 and fails for a reason that has nothing to do with chrome.
      const email = document.querySelector('.v3-email') as HTMLElement;
      return {
        scale: email.getBoundingClientRect().width / email.offsetWidth,
        email: box('.v3-email'),
        section: box('.builder-node-section'),
        row: box('.builder-node-row'),
        column: box('.builder-node-column'),
        heading: box('.builder-node-heading'),
      };
    });

    // Each container drew a 1px border of its own, and there are three of them
    // between the sheet and the block.
    for (const level of ['section', 'row', 'column'] as const) {
      expect(measured[level].border, `${level} must not draw a permanent border -- studio.css gives .v3-node none`).toBe(0);
    }
    // Padding is no longer always zero, and that is the point: a Column carries
    // the handoff's own 18px (`newColumn`) and `nodeSurfaceStyle` draws what the
    // document declares. The question is not "is there an inset" but "is any of
    // it the canvas's own". Every pixel between the sheet edge and the block has
    // to be padding the email will emit -- 27px of stacked chrome is what this
    // rules out.
    const declared = measured.section.paddingLeft + measured.row.paddingLeft + measured.column.paddingLeft;
    expect(declared, "the Column is the only level declaring any, at the handoff's 18px").toBe(18);
    expect((measured.heading.left - measured.email.left) / measured.scale, 'every pixel of inset belongs to the document, none to the canvas').toBeCloseTo(declared, 0);
  });

  test('the name badge belongs to the selected block, not to every block', async ({ page }) => {
    test.setTimeout(120_000);
    await openBuilderWithOneHeading(page);
    // Park the pointer off the canvas: hover reveals a badge too, and a mouse
    // left over the last click would make this pass for the wrong reason.
    await page.mouse.move(4, 4);
    await page.locator('.builder-node-heading').click();
    await page.mouse.move(4, 4);
    await page.waitForTimeout(300);

    const badges = await page.evaluate(() => Array.from(document.querySelectorAll('.builder-node')).map((node) => ({
      kind: Array.from(node.classList).find((name) => name.startsWith('builder-node-') && name !== 'builder-node-selected') ?? '?',
      selected: node.classList.contains('builder-node-selected'),
      opacity: Number.parseFloat(getComputedStyle(node.querySelector(':scope > .builder-node-tag')!).opacity),
      named: (node.getAttribute('aria-pressed') !== null) && (node.querySelector(':scope > .builder-node-tag')?.textContent ?? '').trim().length > 0,
    })));

    expect(badges.length, 'Section, Row, Column and the heading itself').toBe(4);
    expect(badges.filter((badge) => badge.opacity > 0.5).map((badge) => badge.kind), 'exactly one badge on screen, on the block that is selected').toEqual(['builder-node-heading']);
    expect(badges.every((badge) => badge.named), 'and every node keeps its name for assistive tech, badge visible or not').toBe(true);
  });

  test('selecting a block still shows a ring, now that it has no border to thicken', async ({ page }) => {
    test.setTimeout(120_000);
    await openBuilderWithOneHeading(page);
    await page.locator('.builder-node-heading').click();
    await page.mouse.move(4, 4);
    await page.waitForTimeout(300);

    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('.builder-node-heading')!);
      return { width: Number.parseFloat(style.outlineWidth), style: style.outlineStyle, shadow: style.boxShadow };
    });
    expect(ring.width, 'the prototype marks the selected node with an outline, not a border').toBeGreaterThan(0);
    expect(ring.style, 'a solid ring for selection -- the dashed one means "drop here"').toBe('solid');
    expect(ring.shadow, 'and the halo behind it').not.toBe('none');
  });
});
