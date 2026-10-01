import { expect, test } from '@playwright/test';
import { trackFixture } from './fixture-registry.js';

/**
 * ADR-044 -- a row's columns divide the row, on the canvas as well as in the
 * mail.
 *
 * `row-layouts.test.ts` covers the numbers and `tree-ops.test.ts` covers the
 * document. Neither could see the defect this gate exists for, because the
 * defect was entirely in the cascade: `.v3-row` carried the prototype's
 * `grid-auto-flow:column`, but `CanvasNodeView` renders every container's
 * children inside a `.builder-node-children` wrapper, so that grid had one item
 * and the columns inside it sized themselves to their own content.
 *
 * Measured on the running builder before the fix: a 535px row holding two
 * columns drew them at 105px and 107px -- three fifths of the row blank -- and
 * switching the row to 35/65 in the Inspector left both at 105px. The Inspector
 * said the ratio had changed and the emitter agreed; only the surface the
 * author was looking at did not.
 *
 * `ARCH-MAILCRAFT-DOM` was green through all of it, and correctly so: it asks
 * whether the prototype's class names are present, which they were. Whether a
 * present class reaches anything is a question only a browser can answer, so it
 * is asked here, in pixels.
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
      body: JSON.stringify({ name, subject: 'Bố cục cột', origin: 'builder' }),
    });
    if (!response.ok) throw new Error(`create -> ${response.status}`);
    return (await response.json()) as { id: string };
  }, `row-cols-${Date.now()}`);
  trackFixture('templates', created.id);
  return created.id;
}

/**
 * Matches on the button's own `<b>`, not its text content: the palette buttons
 * carry a hint line and a drag glyph as well, and a `textContent` match against
 * either end of that broke a spec once already.
 */
async function insertByClick(page: import('@playwright/test').Page, label: string) {
  await page.evaluate((wanted) => {
    const button = Array.from(document.querySelectorAll('.v3-block-scroll section > button'))
      .find((candidate) => (candidate.querySelector('b')?.textContent ?? '').trim() === wanted);
    if (!button) throw new Error(`no palette button for ${wanted}`);
    (button as HTMLElement).click();
  }, label);
  await page.waitForTimeout(400);
}

type RowMetrics = { available: number; columns: number[]; shares: number[]; covered: number };

/**
 * The row as the author sees it: how wide each column is drawn, and how much of
 * the row those columns cover once the gaps between them are accounted for.
 */
async function measureRow(page: import('@playwright/test').Page): Promise<RowMetrics> {
  return page.evaluate(() => {
    const row = document.querySelector('.builder-node-row');
    if (!row) throw new Error('no row on the canvas');
    const wrapper = row.querySelector(':scope > .builder-node-children');
    if (!wrapper) throw new Error('the row rendered no children wrapper');
    const columns = Array.from(wrapper.children)
      .filter((child) => child.classList.contains('builder-node-column'))
      .map((child) => child.getBoundingClientRect().width);
    const gap = Number.parseFloat(getComputedStyle(wrapper).columnGap) || 0;
    // The space the columns have to divide: the wrapper, less the gaps that sit
    // between them. Measured off the wrapper rather than the row so the row's
    // own padding and border never enter the arithmetic.
    const available = wrapper.getBoundingClientRect().width - gap * Math.max(0, columns.length - 1);
    const total = columns.reduce((sum, width) => sum + width, 0);
    return { available, columns, shares: columns.map((width) => width / total), covered: total / available };
  });
}

test.describe('Row columns: the row is divided, not left blank', () => {
  test('two columns fill the row and take half each', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.v3-rail button').first().waitFor();

    // One click. "Hai cột đều" is a layout preset -- studio.tsx's `newLayout` --
    // so the Row arrives with both of its columns already in it.
    await insertByClick(page, 'Hai cột đều');

    const measured = await measureRow(page);
    expect(measured.columns, 'the preset brings its own two columns').toHaveLength(2);
    // The number the old canvas failed on: 212px of a 535px row, a coverage of
    // 0.40. Anything that sizes a column to its content lands far below 1.
    expect(measured.covered, `the columns must divide the whole row, not shrink to their content -- drawn at ${measured.columns.map(Math.round).join('/')}px of ${Math.round(measured.available)}px`).toBeGreaterThan(0.98);
    expect(measured.covered, 'and must not overflow it either').toBeLessThan(1.02);
    expect(Math.abs(measured.shares[0]! - 0.5), 'a row of two fresh columns is an even split').toBeLessThan(0.02);
  });

  test('the Inspector ratio changes the canvas, not just the document', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.v3-rail button').first().waitFor();

    await insertByClick(page, 'Hai cột đều');

    await page.locator('.builder-node-row').first().click();
    const preset = page.locator('.v3-row-layouts button').filter({ hasText: '35 / 65' });
    await expect(preset, 'a two-column row is offered the three two-column presets').toHaveCount(1);
    await preset.click();
    await page.waitForTimeout(400);

    // Both halves of the claim: the Inspector marks the preset active (the
    // document took the widths) AND the canvas redraws in that ratio. Before the
    // fix the first was true and the second was not, which is precisely the
    // failure mode a document-only assertion cannot see.
    await expect(preset, 'the row took the widths').toHaveClass(/active/);
    const measured = await measureRow(page);
    expect(measured.shares[0]!, `35/65 must be drawn as 35/65 -- drawn at ${measured.columns.map(Math.round).join('/')}px`).toBeGreaterThan(0.33);
    expect(measured.shares[0]!, 'and not wider than 35').toBeLessThan(0.37);
    expect(measured.covered, 'still filling the row at an uneven ratio').toBeGreaterThan(0.98);
  });
});
