import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackFixture } from './fixture-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_ROOT = resolve(__dirname, '../../../.agents/runs/2026-08-31-mailcraft-builder/evidence/completion-dark-mode');
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
];

/**
 * Completion gate, condition 4: "dark mode: chrome tối, canvas email sáng".
 *
 * Measured on 2026-09-07 and found half true. The backgrounds were dark and the
 * email canvas did stay light -- but `studio.css` was copied verbatim from a
 * prototype that only ever had a light theme, and `globals.css` carried four
 * `.theme-dark` rules touching `v3-*`. So the containers went dark and their
 * text did not: every rail panel's own heading sat at 1.14:1, i.e. invisible,
 * along with both sheet titles, the version-history empty state and more --
 * nineteen elements in all.
 *
 * Nothing caught it because nothing in this repo asserts a colour. This does,
 * and it states the invariant the way the condition means it: **dark mode may
 * not break any text that light mode renders legibly.**
 *
 * The comparison is computed per run rather than kept as a list of exemptions.
 * Twelve more elements sit below 4.5:1 in BOTH themes (count chips, the
 * inspector's own hint, the canvas zoom controls); those are the light design's
 * business, and freezing them into an allowlist here would quietly make this
 * gate the owner of a decision it never made. Asking only "did dark make this
 * worse" keeps the gate to its own question, and keeps it honest when the light
 * theme changes.
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';
/** WCAG AA for body text. Every string in this chrome is small, so the large-text 3:1 allowance never applies. */
const MIN_CONTRAST = 4.5;

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
      body: JSON.stringify({ name, subject: 'Kiểm tra dark mode', origin: 'builder' }),
    });
    if (!response.ok) throw new Error(`create -> ${response.status}`);
    return (await response.json()) as { id: string };
  }, `cg-dark-${Date.now()}`);
  trackFixture('templates', created.id);
  return created.id;
}

/**
 * Walks every leaf text node of the builder chrome and reports its contrast.
 * Runs entirely in the page: the ratio has to come from computed styles after
 * the real cascade, which is the whole point -- three separate mechanisms
 * produced the original failure (inherited ink, a `var()` that is only defined
 * inside a sheet, and a gradient shorthand that sets no background-color), and
 * none of them is visible in the stylesheet source alone.
 */
const CONTRAST_PROBE = `(() => {
  const lum = (rgb) => { const [r,g,b] = rgb.match(/\\d+/g).slice(0,3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }); return 0.2126*r + 0.7152*g + 0.0722*b; };
  const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return c; } return 'rgb(255,255,255)'; };
  const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); const [hi, lo] = a > b ? [a, b] : [b, a]; return +(((hi + 0.05) / (lo + 0.05)).toFixed(2)); };
  const found = {};
  for (const el of document.querySelectorAll('.v3-left *, .v3-inspector *, .focus-header *, .v3-sheet *, .v3-rail *')) {
    const text = (el.textContent || '').trim();
    if (!text || el.children.length) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    found[text.slice(0, 24) + '@' + Math.round(box.top) + ',' + Math.round(box.left)] = ratio(getComputedStyle(el).color, bgOf(el));
  }
  return found;
})()`;

/**
 * Switching the theme is not instant, and measuring too early is how this
 * probe lied twice before it was trusted.
 *
 * `globals.css` gives `.app-shell` (and every button/input under it) a
 * `transition` on `color` and `background-color` -- `.16s` on the shell,
 * `--motion-fast` (`.12s`) on the controls. `getComputedStyle` during that
 * window returns the interpolated colour, so a reading taken right after the
 * class flip reports the theme it is leaving, not the one it is entering. Run
 * without this settle, the same page reported "nothing broken" when dark was
 * measured first and "two hundred regressions" when light was -- both wrong,
 * and neither obviously so. 450ms clears both durations with room to spare.
 */
const THEME_SETTLE_MS = 450;

async function probe(page: import('@playwright/test').Page, theme: 'light' | 'dark'): Promise<Record<string, number>> {
  await page.evaluate((mode) => {
    const shell = document.querySelector('.app-shell');
    if (!shell) throw new Error('no app shell');
    shell.classList.remove('theme-light', 'theme-dark');
    shell.classList.add(`theme-${mode}`);
    void document.body.offsetHeight;
  }, theme);
  await page.waitForTimeout(THEME_SETTLE_MS);
  return page.evaluate(CONTRAST_PROBE) as Promise<Record<string, number>>;
}

test.describe('Completion gate: dark mode keeps the chrome readable and the email light', () => {
  // Ten destinations, each probed twice with a repaint between: comfortably
  // past the 30s default.
  test('no rail destination has text that dark mode makes illegible', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.focus-header').waitFor();
    await page.locator('.v3-rail button').first().waitFor();

    const railCount = await page.locator('.v3-rail button').count();
    expect(railCount, 'ADR-044 decision 1 put ten destinations on the rail; a shrunken rail would shrink this gate with it').toBe(10);

    const regressions: Array<{ destination: string; element: string; light: number; dark: number }> = [];
    let compared = 0;

    for (let index = 0; index < railCount; index++) {
      const button = page.locator('.v3-rail button').nth(index);
      const destination = ((await button.textContent()) ?? '').trim().replace(/\s+/g, ' ');
      await button.click();
      await page.waitForTimeout(500);
      // Two of the ten destinations open a full-screen `v3-sheet-bg` overlay,
      // which then covers the rail. Playwright refuses the next click because
      // the button really is unreachable -- the same overlay-over-target trap
      // SV-2 once reported as a working Back button. Close the sheet after
      // probing it rather than clicking through a layer that is genuinely
      // there.
      const sheetClose = page.locator('.v3-sheet header button[aria-label="Đóng"]');

      const dark = await probe(page, 'dark');
      const light = await probe(page, 'light');
      for (const [key, darkRatio] of Object.entries(dark)) {
        const lightRatio = light[key];
        if (lightRatio === undefined) continue;
        compared++;
        // Only a regression counts: legible in light, illegible in dark.
        if (darkRatio < MIN_CONTRAST && lightRatio >= MIN_CONTRAST) {
          regressions.push({ destination, element: key.split('@')[0]!, light: lightRatio, dark: darkRatio });
        }
      }

      if (await sheetClose.count() > 0) {
        await sheetClose.first().click();
        await expect(page.locator('.v3-sheet-bg')).toHaveCount(0);
      }

      // No rail entry may leave the builder. "Nhập HTML" was the one that did,
      // and it went with its `navigate` kind (2026-09-10 spec §3). This used to be
      // a recovery block that navigated back; it is an assertion now, so the rail
      // cannot grow another door out without this test saying so.
      expect(page.url(), 'a rail destination navigated away from the builder').toContain(
        `/templates/${id}/build`);
    }

    expect(compared, 'the probe found nothing to compare, so a green result here would mean nothing').toBeGreaterThan(100);
    expect(regressions, 'dark mode must not push any legible text below 4.5:1').toEqual([]);
  });

  test('the email canvas stays light while the chrome is dark', async ({ page }) => {
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.focus-header').waitFor();
    await probe(page, 'dark');

    const luminance = (rgb: string) => {
      const parts = rgb.match(/\d+/g)!.slice(0, 3).map(Number).map((v) => { const n = v / 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); });
      return 0.2126 * parts[0]! + 0.7152 * parts[1]! + 0.0722 * parts[2]!;
    };
    const bg = async (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);

    // The email is a light document no matter the operator's theme: recipients
    // read it in their own client, and darkening the canvas would preview a
    // mail nobody will receive.
    expect(luminance(await bg('.v3-canvas')), 'the email canvas must stay light in dark mode').toBeGreaterThan(0.7);
    // ...while the surfaces around it are genuinely dark, or "chrome tối" is
    // satisfied by doing nothing at all.
    expect(luminance(await bg('.focus-header')), 'the focus header must actually be dark').toBeLessThan(0.1);
    expect(luminance(await bg('.v3-rail')), 'the rail must actually be dark').toBeLessThan(0.1);
  });

  test('dark mode at three viewports', async ({ page }) => {
    mkdirSync(EVIDENCE_ROOT, { recursive: true });
    await signIn(page);
    const id = await builderTemplate(page);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/templates/${id}/build`);
      await page.locator('.focus-header').waitFor();
      await probe(page, 'dark');

      // Below 1024px the workspace is replaced by `.builder-narrow-notice`
      // (conventions §2.2), so the assertion branches on width rather than
      // skipping -- ARCH-TEST-HYGIENE forbids a committed skip, and the narrow
      // layout has its own true thing to assert.
      if (viewport.width < 1024) {
        await expect(page.locator('.builder-narrow-notice')).toBeVisible();
      } else {
        await expect(page.locator('.v3-left')).toBeVisible();
        await expect(page.locator('.v3-inspector')).toBeVisible();
      }
      await page.screenshot({ path: resolve(EVIDENCE_ROOT, `dark-${viewport.name}.png`), fullPage: false });
    }
  });
});
