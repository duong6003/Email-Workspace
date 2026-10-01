import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { trackFixture } from './fixture-registry.js';

/**
 * ADR-044 -- the gate that compares the canvas to the prototype, instead of
 * comparing its class names to a list.
 *
 * Three rounds of "vẫn chưa chuẩn prototype" came out of the same hole. The
 * port was done class by class, and the only thing guarding it,
 * `ARCH-MAILCRAFT-DOM`, greps the SOURCE for the prototype's class names. Three
 * failure modes walk straight past that:
 *
 *   1. the class is present and overridden -- `.v3-row`'s `grid-auto-flow`
 *      never reached a column, and `.v3-node`'s borderless chrome lost to
 *      `.builder-node`'s border, padding and margin;
 *   2. the class exists in the stylesheet but is never put on an element --
 *      `.v3-p-heading`, `.v3-p-text`, `.v3-p-preheader` are all in `globals.css`
 *      and none of them was rendered;
 *   3. the preview branch does not exist at all -- `contact` returned `null`,
 *      so a Liên hệ block was an empty box on the canvas.
 *
 * None of those is visible in a grep, and all three are visible in one diff. So
 * this reads `studio.css` off disk at run time -- never a copy, which would go
 * stale the first time the handoff changed -- takes every rule that paints
 * inside the email sheet, applies its declarations to the live element as an
 * inline style, and reports every computed property that MOVED. A property that
 * moves is a property where EOW's cascade disagrees with the prototype.
 *
 * Deliberate deviations are named in `ACCEPTED` with the reason, and the gate
 * fails if one of those is listed but no longer differs -- an exclusion that has
 * stopped excluding anything is how this list would rot into decoration.
 */
const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';
const STUDIO_CSS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../design-reference/mailcraft-ui-handoff-v1/source/app/studio.css');

/**
 * The rules that paint INSIDE the email sheet. The chrome around it
 * (`.v3-canvas-tools`, the inspector's `.v3-row-layouts`, `.v3-var-group`) has
 * its own gates -- contrast and dark mode -- and is not what "the canvas draws
 * the email" is about.
 */
function isCanvasSelector(selector: string): boolean {
  // Any pseudo-class or pseudo-element: `:hover` and `:focus-within` need a
  // pointer this gate does not move, and `:before` has no element of its own to
  // read a computed style from. `.v3-node.active` survives -- a plain class, and
  // the fixture leaves a node selected so it has something to match.
  if (selector.includes(':')) return false;
  if (/^\.v3-(canvas|row-layouts|var-group|variable-preview|email-fallback)/.test(selector)) return false;
  return /^\.v3-(node|row|column|tag|stage|email|empty-col|empty-section|leaf|media-empty|p-|var|table|custom)\b/.test(selector);
}

type Rule = { selector: string; declarations: Record<string, string> };

/** A deliberately small CSS reader: `studio.css` is one flat file of single-level rules, and a real parser would be more machinery than the job needs. */
function prototypeCanvasRules(): Rule[] {
  const source = readFileSync(STUDIO_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = new Map<string, Record<string, string>>();
  let depth = 0;
  let buffer = '';
  for (const character of source) {
    buffer += character;
    if (character === '{') depth++;
    else if (character === '}' && --depth === 0) {
      const block = buffer.trim();
      buffer = '';
      if (block.startsWith('@')) continue;
      const brace = block.indexOf('{');
      const body = block.slice(brace + 1, -1);
      for (const selector of block.slice(0, brace).split(',').map((part) => part.trim())) {
        if (!isCanvasSelector(selector)) continue;
        const declarations = rules.get(selector) ?? {};
        for (const pair of body.split(';')) {
          const colon = pair.indexOf(':');
          if (colon === -1) continue;
          declarations[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim().replace('!important', '');
        }
        rules.set(selector, declarations);
      }
    }
  }
  return [...rules].map(([selector, declarations]) => ({ selector, declarations }));
}

/**
 * Deviations this repo owns on purpose. `selector -> property -> why`, or
 * `selector -> '*' -> why` when the whole rule is out of scope here.
 *
 * Every entry is a decision someone can argue with, which is the point of
 * writing them down instead of loosening the comparison.
 */
/**
 * States one document cannot be in at once, or that need something this fixture
 * cannot mint. Not deviations -- the rule is ported and correct, there is just
 * nothing on screen wearing it. Each names the gate that does cover it, where
 * one exists.
 */
const UNREACHABLE: Record<string, string> = {
  '.v3-row.stack': 'the mobile device toggle; `templates-builder-s4` drives that view',
  '.v3-leaf.locked': 'a locked block; the lock lives in the Inspector',
  '.v3-p-button a.sm': 'one button carries one size, and the fixture uses the default md',
  '.v3-p-button a.lg': 'see a.sm',
  '.v3-p-button a.outline': 'one button carries one variant, and the fixture uses the default solid',
  '.v3-p-button a.link': 'see a.outline',
  '.v3-p-button.width-full a': 'one button carries one width, and the fixture uses the default auto',
  '.v3-p-social.circle a': 'one social block carries one shape',
  '.v3-p-social.square a': 'see .circle',
  '.v3-p-social.text a': 'see .circle',
  '.v3-p-image': 'needs an image URL; `templates-builder-s6-assets` binds a real asset',
  '.v3-p-image img': 'see .v3-p-image',
  '.v3-p-image p': 'see .v3-p-image, plus a caption',
  '.v3-p-image small': 'see .v3-p-image -- the missing-alt warning needs an image first',
  '.v3-p-image>a': 'see .v3-p-image, plus a link',
  '.v3-p-image.banner': 'see .v3-p-image',
  '.v3-p-image.banner img': 'see .v3-p-image',
  '.v3-p-logo img': 'needs a logo image URL; the fixture logo falls back to its wordmark',
  '.v3-p-logo>a': 'needs a logo link',
  '.v3-p-logo>a img': 'needs both',
  '.v3-p-logo small': 'the prototype logo carries a sub-label this block model has no field for',
  '.v3-table caption': 'needs a table caption, which the default table leaves empty',
  '.v3-p-image>button': 'the prototype puts a "Thay anh" button inside the node; EOW does not -- see .v3-media-empty small',
  '.v3-p-logo>button': 'see .v3-p-image>button',
  '.v3-media-empty small': 'the prototype placeholder is a button reading "Mo kho tai nguyen". EOW keeps it inert: the node around it is already role="button", and a real button nested in one is an interactive control inside an interactive control. The label is dropped rather than left naming an action that would not happen.',
};

const ACCEPTED: Record<string, Record<string, string>> = {
  // Colour is owned by the two contrast gates. studio.css was authored without
  // a dark theme and several of its inks sit under 4.5:1 in one or both, so
  // `mailcraft-contrast-both-themes` re-picked them; that gate, not this one,
  // is the authority on what a canvas colour may be.
  '.v3-empty-section': { color: 'raised to 4.5:1 by the contrast gate' },
  '.v3-empty-col': { color: 'raised to 4.5:1 by the contrast gate' },
  '.v3-media-empty': {
    color: 'raised to 4.5:1 by the contrast gate',
    display: 'inline-flex so the placeholder does not stretch a column that has other blocks in it',
  },
  '.v3-p-spacer': { color: 'raised to 4.5:1 by the contrast gate' },
  '.v3-p-preheader': { color: 'raised to 4.5:1 by the contrast gate' },
  '.v3-custom': { '*': 'ADR-044 addressed exclusion: drawing custom HTML on the canvas needs dangerouslySetInnerHTML, which this repo refuses -- the preview is a summary chip, not the markup' },
  '.v3-custom>small': { '*': 'see .v3-custom' },
  // The prototype hardcodes `font: 700 28px/1.18 Georgia,serif` on a heading and
  // a fixed 13px on text. EOW's blocks carry their own `fontSize`/`fontWeight`
  // from the Inspector and its theme carries `fontFamily`, all of which
  // `emitter.ts` puts in the mail. Honouring the prototype here would make the
  // canvas contradict the email it is previewing, so only the metrics the
  // author cannot set -- line-height, letter-spacing -- are ported.
  '.v3-p-heading': { 'font-family': "the email's own font, not the prototype's Georgia", 'font-size': "the block's own size", 'font-weight': "the block's own weight", 'line-height': "the block's own, from `newLeaf`: studio.tsx's `Rich` applies it inline and overrides this rule there too" },
  '.v3-p-text': { 'font-size': "the block's own size", 'line-height': "see .v3-p-heading" },
  '.v3-p-contact': { 'font-size': "the block's own size" },
  // Set inline from the node's own properties, which is what the mail will use.
  '.v3-p-button a': { 'border-color': "the button's accent colour, set inline" },
  '.v3-p-social a': { 'border-style': 'dashed marks a link with no URL yet' },
  '.v3-table': { '*': 'the table paints from its own node properties -- header, zebra and border colours, all inline' },
  '.v3-table th': { '*': 'see .v3-table' },
  '.v3-table td': { '*': 'see .v3-table' },
  '.v3-email': { 'font-family': "resolves `--mc-email-font` to the template's own theme font; studio.css only carries a literal fallback" },
};

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
      body: JSON.stringify({ name, subject: 'Đối chiếu prototype', origin: 'builder' }),
    });
    if (!response.ok) throw new Error(`create -> ${response.status}`);
    return (await response.json()) as { id: string };
  }, `canvas-fidelity-${Date.now()}`);
  trackFixture('templates', created.id);
  return created.id;
}

/** Every block kind the palette offers, plus an empty Section and an empty Column, so each rule has something to be measured against. */
const EVERY_KIND = [
  'Tiêu đề', 'Đoạn văn', 'Hình ảnh', 'Banner', 'Logo', 'Nút bấm', 'Mạng xã hội',
  'Bảng dữ liệu', 'Đường ngăn', 'Khoảng cách', 'Liên hệ', 'Preheader', 'HTML/CSS tùy chỉnh',
  // Last, and in this order. "Hai cột đều" brings two empty columns with it, so
  // `.v3-empty-col` has something to match; the Section goes last because an
  // unaimed click joins the last container of the kind it needs, and a Section
  // inserted earlier would stop being empty the moment a layout followed it.
  'Hai cột đều', 'Section trống',
];

test.describe('Canvas fidelity: every prototype rule reaches the canvas', () => {
  test('no rule in studio.css is missing, unapplied, or overridden', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const id = await builderTemplate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/templates/${id}/build`);
    await page.locator('.v3-rail button').first().waitFor();

    for (const label of EVERY_KIND) {
      await page.evaluate((wanted) => {
        const button = Array.from(document.querySelectorAll('.v3-block-scroll section > button'))
          .find((candidate) => (candidate.querySelector('b')?.textContent ?? '').trim() === wanted);
        if (!button) throw new Error(`no palette button for ${wanted}`);
        (button as HTMLElement).click();
      }, label);
      await page.waitForTimeout(280);
    }

    // `.v3-var` only exists where a block's content carries one, so give the text
    // block a variable rather than excluding the chip for want of a fixture.
    await page.locator('.builder-node-text').first().click();
    await page.waitForTimeout(300);
    await page.locator('.v3-inspector textarea').first().fill('Xin chào {{first_name}}');
    await page.waitForTimeout(400);
    await expect(page.locator('.v3-var')).toHaveCount(1);

    const rules = prototypeCanvasRules();
    expect(rules.length, 'studio.css moved or stopped parsing -- an empty rule set would make this gate pass on nothing').toBeGreaterThan(20);

    const findings = await page.evaluate((input: { rules: Rule[]; accepted: Record<string, Record<string, string>> }) => {
      const results: Array<{ selector: string; property: string; eow: string; prototype: string }> = [];
      const unmatched: string[] = [];
      const probe = document.createElement('div');

      for (const rule of input.rules) {
        const element = document.querySelector(rule.selector) as HTMLElement | null;
        if (!element) { unmatched.push(rule.selector); continue; }

        // Expand each declaration to the longhands it really sets, and compare
        // only those. Diffing the whole computed style instead reports the
        // consequences as if they were the cause: `color` moves eight
        // properties `caret-color` among them, and a line-height moves `height`
        // and `transform-origin`. 103 lines of noise around six real findings,
        // the first time this ran.
        const longhands: Record<string, string> = {};
        for (const [property, value] of Object.entries(rule.declarations)) {
          probe.style.cssText = '';
          probe.style.setProperty(property, value);
          for (const expanded of Array.from(probe.style)) longhands[expanded] = probe.style.getPropertyValue(expanded);
        }

        // An accepted property is dropped BEFORE the rule is applied, not
        // filtered out of the results afterwards. `font: 700 28px/1.18 Georgia`
        // is one declaration carrying a family, a size and a line-height; if the
        // accepted size were applied anyway, every font-relative value under it
        // would move and read as a second, invented divergence.
        const skip = input.accepted[rule.selector] ?? {};
        const apply = Object.entries(longhands).filter(([property]) => skip['*'] === undefined && skip[property] === undefined);
        for (const [property] of Object.entries(longhands)) {
          if (skip['*'] !== undefined || skip[property] !== undefined) {
            results.push({ selector: rule.selector, property, eow: '(accepted)', prototype: '(accepted)' });
          }
        }
        if (apply.length === 0) continue;

        const style = getComputedStyle(element);
        const before = new Map(apply.map(([property]) => [property, style.getPropertyValue(property)]));
        const previous = element.getAttribute('style');
        for (const [property, value] of apply) element.style.setProperty(property, value, '');
        const after = getComputedStyle(element);
        for (const [property] of apply) {
          const now = after.getPropertyValue(property);
          if (before.get(property) !== now) results.push({ selector: rule.selector, property, eow: before.get(property)!, prototype: now });
        }
        if (previous === null) element.removeAttribute('style'); else element.setAttribute('style', previous);
      }
      return { results, unmatched };
    }, { rules, accepted: ACCEPTED });

    /**
     * The ACCEPTED key covering a finding, or undefined. `border-top-color` and
     * its three siblings resolve to one `border-color` entry: a deviation is
     * about a border, not about its top edge, and four identical lines with
     * four identical reasons is a list nobody reads.
     */
    const acceptedKey = (selector: string, property: string): string | undefined => {
      const entry = ACCEPTED[selector];
      if (!entry) return undefined;
      if (entry['*'] !== undefined) return '*';
      if (entry[property] !== undefined) return property;
      const side = /^border-(?:top|right|bottom|left)-(\w+)$/.exec(property);
      return side && entry[`border-${side[1]}`] !== undefined ? `border-${side[1]}` : undefined;
    };
    const accepted = (selector: string, property: string): string | undefined => acceptedKey(selector, property);

    const divergences = findings.results
      .filter((finding) => finding.eow !== '(accepted)')
      .filter((finding) => accepted(finding.selector, finding.property) === undefined)
      .map((finding) => `${finding.selector} { ${finding.property}: ${finding.eow} }  -- studio.css says ${finding.prototype}`);

    // A selector with nothing to match means the class was never put on an
    // element: failure mode 2, and the one a grep is most blind to.
    const neverRendered = findings.unmatched
      .filter((selector) => ACCEPTED[selector]?.['*'] === undefined && UNREACHABLE[selector] === undefined);

    // An exclusion that no longer excludes anything is worse than no exclusion:
    // it reads as a known deviation while quietly guarding a rule that now
    // matches. Both lists are checked for that.
    const used = new Set<string>();
    // A whole-rule exclusion earns its keep by the selector having nothing to
    // match -- `.v3-custom` is excluded precisely BECAUSE this canvas renders a
    // summary chip in its place, so it will never appear in the results.
    for (const selector of findings.unmatched) {
      if (ACCEPTED[selector]?.['*'] !== undefined) used.add(`${selector}::*`);
    }
    for (const finding of findings.results) {
      const key = acceptedKey(finding.selector, finding.property);
      if (key !== undefined) used.add(`${finding.selector}::${key}`);
    }
    const stale: string[] = [];
    for (const [selector, properties] of Object.entries(ACCEPTED)) {
      for (const property of Object.keys(properties)) {
        if (!used.has(`${selector}::${property}`)) stale.push(`ACCEPTED ${selector} { ${property} }`);
      }
    }
    for (const selector of Object.keys(UNREACHABLE)) {
      if (!findings.unmatched.includes(selector)) stale.push(`UNREACHABLE ${selector}`);
    }

    expect(neverRendered, 'these prototype classes exist in the stylesheet but no element on the canvas carries them').toEqual([]);
    expect(divergences, 'the canvas must render what studio.css says, or say in ACCEPTED why not').toEqual([]);
    expect(stale, 'these entries no longer exclude anything -- delete them, or the list stops meaning what it says').toEqual([]);
  });
});
