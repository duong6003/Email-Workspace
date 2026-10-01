import { expect, test } from '@playwright/test';
import { trackFixture } from './fixture-registry.js';

/**
 * ADR-044 -- the companion gate to `mailcraft-dark-mode-completion.spec.ts`.
 *
 * That gate asks one question: "did dark mode make legible text illegible?" It
 * says so in its own comment, and it deliberately does not own text that was
 * already under 4.5:1 in light -- freezing those into an allowlist would have
 * made it the owner of a design decision it never made.
 *
 * That left the other half of the invariant unguarded, and 24 elements sat in
 * it. They were measured, priced and fixed; this gate is what keeps them fixed.
 * The question here is the complementary one:
 *
 *   **no text in the builder chrome may be below 4.5:1 in BOTH themes.**
 *
 * Computed per run, not compared against a stored list, for the same reason the
 * dark gate computes its comparison: a list of exempt strings goes stale the
 * first time a label changes, and then guards nothing while still passing.
 *
 * Three things this gate inherits from the dark one, each of which cost a
 * debugging round to learn the first time:
 *
 * 1. `THEME_SETTLE_MS`. `globals.css` transitions `color` and
 *    `background-color`, so a reading taken right after the class flip returns
 *    the theme being LEFT. Measured without it, the same page reports "nothing
 *    broken" or "two hundred broken" depending only on which theme is probed
 *    first.
 * 2. The ratio is computed from `getComputedStyle` after the real cascade. The
 *    failures this replaces were produced by inherited ink, a `var()` defined
 *    only inside a sheet, and a gradient shorthand that sets no
 *    background-color -- none of them visible in the stylesheet source.
 * 3. `bgOf` walks ancestors for a background-COLOR, which reports the wrong
 *    surface for anything painted by a gradient. So `worstStop` re-reads the
 *    gradient and scores against its least-favourable stop instead. Without
 *    this the gate reads five elements as ~0.4 better than they are.
 *
 * And one thing it does not inherit: the element scope is wider.
 * `.v3-canvas-tools` lives in `.v3-canvas-area`, outside all five containers
 * the dark gate walks, so its three buttons were invisible to that gate at
 * 4.15:1 light / 3.38:1 dark.
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';
/** WCAG AA for body text. Every string in this chrome is small, so the large-text 3:1 allowance never applies. */
const MIN_CONTRAST = 4.5;
/** See point 1 above. Same value and same reason as the dark-mode gate's own constant. */
const THEME_SETTLE_MS = 450;

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
      body: JSON.stringify({ name, subject: 'Kiểm tra tương phản', origin: 'builder' }),
    });
    if (!response.ok) throw new Error(`create -> ${response.status}`);
    return (await response.json()) as { id: string };
  }, `cg-contrast-${Date.now()}`);
  trackFixture('templates', created.id);
  return created.id;
}

const CONTRAST_PROBE = `(() => {
  const lum = (rgb) => { const [r,g,b] = rgb.match(/\\d+/g).slice(0,3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }); return 0.2126*r + 0.7152*g + 0.0722*b; };
  const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); const [hi, lo] = a > b ? [a, b] : [b, a]; return +(((hi + 0.05) / (lo + 0.05)).toFixed(2)); };
  const opaque = (c) => c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c);
  // The surface an element is really painted on: the nearest ancestor with a
  // background-color, UNLESS a nearer one paints a gradient -- in which case the
  // least-favourable stop of that gradient is the honest background.
  const surface = (el, fg) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        const stops = cs.backgroundImage.match(/rgba?\\([^)]*\\)/g) || [];
        const solid = stops.filter((s) => !/, *0\\)$/.test(s));
        if (solid.length) return solid.reduce((worst, s) => ratio(fg, s) < ratio(fg, worst) ? s : worst, solid[0]);
      }
      if (opaque(cs.backgroundColor)) return cs.backgroundColor;
    }
    return 'rgb(255,255,255)';
  };
  const found = {};
  for (const el of document.querySelectorAll('.v3-left *, .v3-inspector *, .focus-header *, .v3-sheet *, .v3-rail *, .v3-canvas-area *')) {
    const text = (el.textContent || '').trim();
    if (!text || el.children.length) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    const fg = getComputedStyle(el).color;
    found[text.slice(0, 24) + '@' + Math.round(box.top) + ',' + Math.round(box.left)] = ratio(fg, surface(el, fg));
  }
  return found;
})()`;

/**
 * Puts the app in a theme the way a person does -- through its own stored
 * preference -- and reloads, rather than forcing the class the app also owns.
 *
 * The forced-class version was wrong twice over, and the second failure is why
 * this exists. `AppShell` renders `theme-${theme}` into `<main>`, so any
 * re-render (autosave ticking, an analysis response landing) rewrites
 * `className` and puts the app back on its real theme; the next flip restarts
 * the `color` transition, and a reading taken in that window is a colour that
 * never appears on screen. It reported `.primary-button` at exactly 1.00:1,
 * white on white, in a theme where that button is really `#405149` on `#fff`
 * (7.4:1) -- verified by setting the real theme and reading it back.
 *
 * Requiring two agreeing reads narrowed the window but did not close it: under
 * a full-suite run, both reads can land inside the same re-render. Reading the
 * app's real theme closes it completely -- there is nothing to race, because
 * nothing is fighting over the class. It is also faster than it looks: two
 * reloads for the whole run, not two per destination, because the loop now
 * walks all ten destinations once per theme instead of flipping at each one.
 *
 * `use-theme.ts` restores `ecs-theme` in a `requestAnimationFrame` after mount,
 * so the settle after load is still needed -- just once per pass.
 */
async function loadInTheme(page: import('@playwright/test').Page, theme: 'light' | 'dark', url: string): Promise<void> {
  await page.evaluate((mode) => window.localStorage.setItem('ecs-theme', mode), theme);
  await page.goto(url);
  await page.locator('.focus-header').waitFor();
  await page.locator('.v3-rail button').first().waitFor();
  await page.waitForTimeout(THEME_SETTLE_MS);
  const applied = await page.evaluate(() => document.querySelector('.app-shell')?.className ?? '');
  const isDark = applied.includes('theme-dark');
  expect(isDark, `the app did not actually enter ${theme} mode -- measuring the wrong theme is how this gate lied before`).toBe(theme === 'dark');
}

/** Walks every rail destination in the CURRENT theme and returns one ratio per on-screen string. */
async function probeAllDestinations(page: import('@playwright/test').Page, templateId: string): Promise<Record<string, number>> {
  const railCount = await page.locator('.v3-rail button').count();
  expect(railCount, 'ADR-044 decision 1 put ten destinations on the rail; a shrunken rail would shrink this gate with it').toBe(10);
  const collected: Record<string, number> = {};

  for (let index = 0; index < railCount; index++) {
    await page.locator('.v3-rail button').nth(index).click();
    await page.waitForTimeout(500);
    // Two destinations open a full-screen `v3-sheet-bg` that then covers the
    // rail; close it after probing rather than clicking through a layer that
    // is genuinely there.
    const sheetClose = page.locator('.v3-sheet header button[aria-label="Đóng"]');

    const found = (await page.evaluate(CONTRAST_PROBE)) as Record<string, number>;
    for (const [key, value] of Object.entries(found)) collected[key] = value;

    if (await sheetClose.count() > 0) {
      await sheetClose.first().click();
      await expect(page.locator('.v3-sheet-bg')).toHaveCount(0);
    }
    // No rail entry may leave the builder. "Nhập HTML" was the one that did,
    // and it went with its `navigate` kind (2026-09-10 spec §3). This used to be
    // a recovery block that navigated back; it is an assertion now, so the rail
    // cannot grow another door out without this test saying so.
    expect(page.url(), 'a rail destination navigated away from the builder').toContain(
      `/templates/${templateId}/build`);
  }
  return collected;
}

test.describe('Contrast: no builder text is illegible in both themes', () => {
  test('every rail destination clears 4.5:1 in light or dark', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const url = `/templates/${id}/build`;

    await loadInTheme(page, 'dark', url);
    const dark = await probeAllDestinations(page, id);

    await loadInTheme(page, 'light', url);
    const light = await probeAllDestinations(page, id);

    const failures: Array<{ element: string; light: number; dark: number }> = [];
    let compared = 0;
    for (const [key, darkRatio] of Object.entries(dark)) {
      const lightRatio = light[key];
      if (lightRatio === undefined) continue;
      compared++;
      // Below the bar in BOTH themes: there is no theme in which a reader can
      // see this. One theme passing is enough for this gate -- the dark-mode
      // gate owns the case where dark alone breaks something.
      if (darkRatio < MIN_CONTRAST && lightRatio < MIN_CONTRAST) {
        failures.push({ element: key.split('@')[0]!, light: lightRatio, dark: darkRatio });
      }
    }

    expect(compared, 'the probe found nothing to compare, so a green result here would mean nothing').toBeGreaterThan(100);
    expect(failures, 'no builder text may sit under 4.5:1 in both themes at once').toEqual([]);
  });
});
