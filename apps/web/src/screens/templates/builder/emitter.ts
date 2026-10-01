import type { Doc, EmailTheme, Node, SocialLink } from './document.js';
import { defaultTheme, SOCIAL_PLATFORM_LABEL } from './document.js';
import { INLINE_TAG_NAME, type InlineSegment, inlineSegments } from './inline.js';

/**
 * `Doc` -> HTML. A pure function: no React, no DOM (spec §2.1 -- web has no
 * component-render tests, so anything that isn't a pure function isn't
 * testable). Every fix below is load-bearing, not cosmetic -- each one is a
 * block that the sanitizer silently breaks otherwise
 * (`docs/superpowers/specs/2026-09-01-builder-block-sanitizer-audit.md`):
 *
 * - `background-color`, never the `background` shorthand (§2.1, §2.4) --
 *   `background` is not in the sanitizer's allowlist, so a shorthand value
 *   survives parsing but is stripped before storage, and a button or table
 *   header renders with no fill at all.
 * - `font-size`/`font-weight`/`font-family` split apart, never the `font`
 *   shorthand (§4) -- same shorthand problem, on the logo wordmark.
 * - `title`, never `aria-label` (§3) -- `aria-label` is not an allowlisted
 *   attribute on any tag; `title` is, on every tag (`emailAttributes['*']`).
 * - The divider is a one-row table with `height` + `background-color`, not
 *   `<hr border-top>` (§2.2) -- `border-top` is not allowlisted, so the rule
 *   collapses to `border:0`, i.e. "draw no border at all".
 * - The preheader stops emitting `opacity:0` (§2.3, ADR-040) -- redundant
 *   once `display`/`max-height`/`overflow` are allowlisted, and one fewer
 *   thing to explain.
 */

const escapeHtml = (value = ''): string => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

const safeUrl = (raw = ''): string => {
  const value = raw.trim();
  if (!value) return '';
  if (/^\{\{\s*[a-z][a-z0-9_]{0,63}\s*\}\}$/.test(value)) return value;
  if (/^(?:https?:|mailto:|tel:|cid:)/i.test(value)) return value;
  return '';
};

export const marginCss = (n: Node): string => `${n.marginTop ?? 0}px ${n.marginRight ?? 0}px ${n.marginBottom ?? 0}px ${n.marginLeft ?? 0}px`;
export const paddingCss = (n: Node): string => `${n.paddingTop ?? 0}px ${n.paddingRight ?? 0}px ${n.paddingBottom ?? 0}px ${n.paddingLeft ?? 0}px`;

/**
 * The floor the `color:inherit` chain lands on.
 *
 * Measured 2026-09-11, closing the loose end ADR-045 left (audit backlog §6):
 * `<body>` declared a `background-color` and no `color`, while `emitText`,
 * `emitHeading` and `emitContact` all write `color:inherit` for a block with no
 * `textColor`. Nothing in the email answered that `inherit`, so it resolved in
 * the CLIENT's stylesheet.
 *
 * That is only a problem because of the head tag beside it. `color-scheme:
 * light dark` asks the client not to invert -- so in dark mode it leaves the
 * explicitly white content background alone and supplies its own light default
 * text colour on top of it. The declaration meant to prevent an ugly automatic
 * inversion was instead removing the safety net from the one case that needed
 * it. Blocks made from the catalogue carry `LEAF_INK`'s `#30463d` and were
 * never at risk; an imported or older block with no colour was.
 *
 * Deliberately a constant rather than a new `EmailTheme` field: a theme ink
 * control is a real decision with a control attached, and adding a field no UI
 * writes is the exact debt audit backlog §1 was just spent paying off.
 */
const BODY_INK = '#30463d';

/**
 * ADR-047 decision 4 -- the dark palette overrides DEFAULT colours only, never
 * a colour the author chose.
 *
 * The `@media` rule has to use `!important` to beat an inline `style`, so if it
 * applied to everything it would erase deliberate choices: white text on a deep
 * green section would be repainted with the dark ink and vanish. Gating it on a
 * class, and only emitting that class while the colour is still the default,
 * means an author who picks colours keeps them in both modes -- their own pair
 * already agrees with itself -- and an author who picks none gets the palette.
 */
const DEFAULT_SURFACE = '#ffffff';
const darkSurfaceClass = (background: string): string => (background.toLowerCase() === DEFAULT_SURFACE ? ' class="mc-dark-surface"' : '');
const darkInkClass = (n: Node): string => (!n.textColor || n.textColor.toLowerCase() === BODY_INK ? ' class="mc-dark-ink"' : '');

/**
 * ADR-045 decision 2. Word inserts its own spacing either side of every table;
 * these two zero it. Inert everywhere else -- no other client parses `mso-*`.
 */
export const MSO_TABLE_RESET = 'mso-table-lspace:0pt;mso-table-rspace:0pt';

/**
 * ADR-042 (built 2026-09-10), for Section and Column: the prototype's
 * `SurfaceExtras` group, whose two effects the sanitizer stripped until ADR-042
 * opened `box-shadow` and a gradient-only `background-image`.
 *
 * Both are declared AFTER `background-color`, never instead of it. A client
 * that drops either keeps the flat colour and the border, which is precisely
 * the promise the prototype prints under the control ("luôn xuất màu nền phẳng
 * và viền làm fallback") -- and Outlook desktop is exactly such a client.
 *
 * The two shadows are the prototype's own values, and each is four tokens --
 * the most ADR-038's shorthand grammar accepts, which is why `elevation` has
 * three values here and four there (see `Node.elevation`).
 */
const SHADOW_SPEC: Record<'soft' | 'strong', { offset: string; fallback: string }> = {
  soft: { offset: '0 8px 18px', fallback: '#c4d0ca' },
  strong: { offset: '0 14px 28px', fallback: '#9eafa7' },
};

/**
 * The two effects as VALUES, not as declarations, so the canvas can apply the
 * same ones through React's `CSSProperties` without restating the rules.
 *
 * That separation exists because it was already broken once: the ADR-042 build
 * added these to the emitter alone, so the two surface controls changed the
 * email and left the canvas identical -- the exact drift `canvas-style.ts` was
 * written to prevent, reintroduced in the commit that added the controls.
 * Sharing a helper is not enough on its own; the helper has to be shaped so
 * both callers can use it.
 */
export type SurfaceEffects = { backgroundImage?: string; boxShadow?: string };

export function surfaceEffects(n: Node): SurfaceEffects {
  const effects: SurfaceEffects = {};
  if (n.backgroundMode === 'gradient') {
    const from = n.background ?? '#ffffff';
    const to = n.gradientTo ?? '#e9f3ee';
    effects.backgroundImage = `linear-gradient(${n.gradientAngle ?? 135}deg,${from} 0%,${to} 100%)`;
  }
  const spec = n.elevation && n.elevation !== 'flat' ? SHADOW_SPEC[n.elevation] : undefined;
  if (spec) effects.boxShadow = `${spec.offset} ${n.shadowColor ?? spec.fallback}`;
  return effects;
}

export function surfaceCss(n: Node): string[] {
  const { backgroundImage, boxShadow } = surfaceEffects(n);
  const out: string[] = [];
  if (backgroundImage) out.push(`background-image:${backgroundImage}`);
  if (boxShadow) out.push(`box-shadow:${boxShadow}`);
  return out;
}

/** `border-radius`, single-value or four corners (S4 decision 4). Falls back to the single `radius` field unless any corner is explicitly set, so button/image/banner (single-value only) are unaffected. */
export const radiusCss = (n: Node): string => {
  const hasCorners = n.radiusTopLeft !== undefined || n.radiusTopRight !== undefined || n.radiusBottomRight !== undefined || n.radiusBottomLeft !== undefined;
  return hasCorners
    ? `${n.radiusTopLeft ?? 0}px ${n.radiusTopRight ?? 0}px ${n.radiusBottomRight ?? 0}px ${n.radiusBottomLeft ?? 0}px`
    : `${n.radius ?? 0}px`;
};

/** `border`, matching the button emitter's own pattern: a real 3-token shorthand when there is a width to show, otherwise the single token `0` -- never a fabricated color on a border nobody asked for. */
export const borderCss = (n: Node): string => (n.borderWidth ? `${n.borderWidth}px solid ${n.borderColor ?? '#dbe5e0'}` : '0');

/**
 * ADR-046 decisions 2 and 3 -- the security boundary of inline rich text.
 *
 * `escapeHtml` is NOT removed by this feature; it moves. Instead of escaping
 * the whole paragraph once, every text RUN between marks is escaped, and the
 * only unescaped characters in the output are the four constant tags below.
 * An author therefore still has no way to write a syntactically meaningful
 * character into the mail -- typing `<mso-ghost data-mso="row-open">` produces
 * `&lt;mso-ghost …&gt;` and reads back as the text it is.
 *
 * That case is the reason this boundary lives here rather than at the server.
 * Measured 2026-09-11: `<mso-ghost data-mso="row-open">` fed to
 * `sanitizeTemplateHtml` comes back as a live `<!--[if mso]><table …><tr>` --
 * because ADR-045 decision 1 runs `expandMsoGhosts` AFTER `sanitize()`, on
 * purpose. Content that reaches the sanitizer as markup can still reach that
 * expansion. The server is not the last layer, and the canvas renders long
 * before the server sees anything at all.
 *
 * The tag names are constants selected by a `switch` over a four-value union,
 * so no data reaches a tag position. The one value that does come from data is
 * `href`, and it goes through the same `safeUrl` every other block uses and
 * then through `escapeHtml`.
 */
/** What a segment needs open around it: the tag to write, and an identity so a link that changes destination is not mistaken for the same tag continuing. */
type OpenTag = { key: string; open: string; close: string };

function openTagsFor(segment: InlineSegment): OpenTag[] {
  const tags: OpenTag[] = [];
  for (const kind of segment.marks) {
    if (kind === 'link') {
      const href = safeUrl(segment.href);
      // A rejected destination drops the LINK and keeps the words, exactly as
      // `emitButton` does -- never a bare `<a>` with no href, which reads as a
      // dead control to a screen reader.
      if (!href) continue;
      tags.push({ key: `link:${href}`, open: `<a href="${escapeHtml(href)}">`, close: '</a>' });
      continue;
    }
    const tag = INLINE_TAG_NAME[kind];
    tags.push({ key: kind, open: `<${tag}>`, close: `</${tag}>` });
  }
  return tags;
}

/**
 * Segments -> HTML, keeping a tag OPEN across segment boundaries where the mark
 * actually continues.
 *
 * Emitting each segment independently would be just as correct and just as
 * balanced, but it writes `<strong>a</strong><strong><em>bc</em></strong>`
 * where `<strong>a<em>bc</em></strong>` says the same thing -- and every
 * overlap in the document would pay for it. Gmail clips at 102KB, which is the
 * same reason `emitText` omits `letter-spacing` at its no-op value.
 *
 * Because `segment.marks` is in `INLINE_MARK_ORDER`, comparing the open stack
 * with the next segment's tags prefix-first is well defined: everything up to
 * the first difference stays open, everything after it closes in reverse.
 */
function serializeInlineSegments(segments: readonly InlineSegment[]): string {
  let out = '';
  let stack: OpenTag[] = [];
  for (const segment of segments) {
    const wanted = openTagsFor(segment);
    let shared = 0;
    while (shared < stack.length && shared < wanted.length && stack[shared]!.key === wanted[shared]!.key) shared += 1;
    for (let index = stack.length - 1; index >= shared; index -= 1) out += stack[index]!.close;
    for (let index = shared; index < wanted.length; index += 1) out += wanted[index]!.open;
    stack = wanted;
    out += escapeHtml(segment.text).replace(/\n/g, '<br>');
  }
  for (let index = stack.length - 1; index >= 0; index -= 1) out += stack[index]!.close;
  return out;
}

/**
 * ADR-046 decision 6 -- the migration, and the reason a legacy `<` stays a `<`.
 *
 * No marks means the exact expression this function had before ADR-046, byte
 * for byte. A document saved before today carries no `inline`, so it can only
 * take this branch: its `content` is escaped whole and nothing in it is ever
 * parsed. There is no sniffing of `content` for markup anywhere -- the field's
 * absence is the whole test.
 */
function emitTextBody(n: Node): string {
  const content = n.content ?? '';
  const segments = inlineSegments(content, n.inline);
  if (segments.length === 0 || segments.every((segment) => segment.marks.length === 0)) {
    return escapeHtml(content).replace(/\n/g, '<br>');
  }
  return serializeInlineSegments(segments);
}

function emitText(n: Node): string {
  const tag = n.kind === 'heading' ? `h${n.headingLevel ?? 2}` : 'p';
  const style = [
    /**
     * `margin` is a RESET, not an author control, which is why nothing in the
     * inspector writes it: every mail client ships its own `<p>`/`<h*>` margin
     * and they disagree, so the block states 0 and takes its spacing from
     * `padding` instead. The four `margin*` fields therefore have no control on
     * purpose -- that is an address, not an oversight.
     *
     * `padding` had no line here at all until 2026-09-10, and that was a defect
     * rather than a missing feature: `blocks.ts` sets 14px on every new text
     * block and `canvas-style.ts` has always DRAWN it, so an author saw the
     * padding on screen, approved the design, and the email shipped flush.
     * Emitting it makes the mail agree with the canvas the design was approved
     * against; existing templates gain the spacing they were always shown.
     */
    `margin:${marginCss(n)}`,
    `padding:${paddingCss(n)}`,
    `color:${n.textColor ?? 'inherit'}`,
    `text-align:${n.align ?? 'left'}`,
    `font-family:${n.fontFamily ?? 'inherit'}`,
    `font-size:${n.fontSize ?? (n.kind === 'heading' ? 28 : 14)}px`,
    `line-height:${n.lineHeight ?? (n.kind === 'heading' ? 1.2 : 1.6)}`,
    // ADR-045 decision 2: without this Word ignores `line-height` entirely and
    // uses the font's own leading, so every paragraph came out at a spacing the
    // author never chose.
    'mso-line-height-rule:exactly',
    `font-weight:${n.fontWeight ?? (n.kind === 'heading' ? 700 : 400)}`,
    // ADR-042 (built 2026-09-10). Both are omitted at their no-op value rather
    // than written as `0`/`none`: a declaration that changes nothing is still
    // bytes in every email, and Gmail clips at 102KB.
    ...(n.letterSpacing ? [`letter-spacing:${n.letterSpacing}px`] : []),
    ...(n.textTransform && n.textTransform !== 'none' ? [`text-transform:${n.textTransform}`] : []),
  ].join(';');
  return `<${tag}${darkInkClass(n)} style="${style}">${emitTextBody(n)}</${tag}>`;
}

/**
 * ADR-048 -- the list block.
 *
 * A SIBLING of the paragraph, never nested inside one. Measured 2026-09-11: a
 * `<ul>` inside the `<p>` that `emitText` produces splits the paragraph in two
 * and orphans an empty `<p></p>`, while the same `<ul>` inside an `<h2>` nests
 * normally -- one author action, two results. That measurement is the whole
 * reason this is a block kind rather than a fifth inline mark.
 *
 * Items are the lines of `content` (decision 2). No second text field: seven
 * other places read `content` and would each have had to learn a new shape,
 * and the prototype already demonstrated what a second copy of the text costs.
 *
 * `list-style-type` is the only marker route that survives the sanitizer --
 * `list-style`, `list-style-position`, `<ol type>` and `<ol start>` were all
 * measured stripped -- and ADR-048 opened exactly that one.
 */
function emitList(n: Node): string {
  const items = (n.content ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  // Nothing to show is nothing emitted, the same as an image with no src.
  if (items.length === 0) return '';
  const tag = n.ordered ? 'ol' : 'ul';
  const style = [
    `margin:${marginCss(n)}`,
    `padding:${n.paddingTop ?? 0}px ${n.paddingRight ?? 0}px ${n.paddingBottom ?? 0}px ${n.paddingLeft ?? 24}px`,
    `color:${n.textColor ?? 'inherit'}`,
    `text-align:${n.align ?? 'left'}`,
    `font-family:${n.fontFamily ?? 'inherit'}`,
    `font-size:${n.fontSize ?? 14}px`,
    `line-height:${n.lineHeight ?? 1.6}`,
    'mso-line-height-rule:exactly',
    // ADR-045 decision 2: Word pads a list the way it pads a table.
    MSO_TABLE_RESET,
    // Omitted when unset so an untouched block spends no bytes saying
    // "use the default" -- the rule `emitText` follows for `letter-spacing`.
    ...(n.listStyle ? [`list-style-type:${n.listStyle}`] : []),
  ].join(';');
  const body = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `<${tag}${darkInkClass(n)} style="${style}">${body}</${tag}>`;
}

function emitButton(n: Node): string {
  const href = safeUrl(n.href);
  const size = n.buttonSize === 'sm' ? '9px 14px' : n.buttonSize === 'lg' ? '15px 26px' : '12px 20px';
  const variant = n.buttonVariant ?? 'solid';
  const bg = variant === 'solid' ? (n.accent ?? '#173f33') : variant === 'soft' ? `${n.accent ?? '#173f33'}18` : 'transparent';
  const color = variant === 'solid' ? (n.textColor ?? '#fff') : (n.accent ?? '#173f33');
  const border = variant === 'outline' ? `1px solid ${n.accent ?? '#173f33'}` : '0';
  const label = escapeHtml(n.content ?? '');
  const style = [
    'display:block',
    `padding:${size}`,
    `border:${border}`,
    `border-radius:${n.radius ?? 0}px`,
    `background-color:${bg}`,
    `color:${color}`,
    'text-align:center',
    `text-decoration:${variant === 'link' ? 'underline' : 'none'}`,
  ].join(';');
  const title = n.linkTitle ? ` title="${escapeHtml(n.linkTitle)}"` : '';
  const inner = href ? `<a href="${escapeHtml(href)}"${title} style="${style}">${label}</a>` : `<span style="${style}">${label}</span>`;
  return `<table role="presentation" width="${n.buttonWidth === 'full' ? '100%' : 'auto'}" align="${n.align ?? 'left'}"><tr><td style="padding:${n.paddingTop ?? 0}px 0">${inner}</td></tr></table>`;
}

/**
 * ADR-043 §8: a decorative image gets an empty alt AND `role="presentation"`.
 * Both, always together. `alt=""` on its own is ambiguous -- a screen reader
 * cannot distinguish a deliberate empty alt from a forgotten one -- and it is
 * the pair that `IMAGE_ALT_MISSING` recognises as "empty on purpose".
 */
function altAttributes(n: Node, fallback = ''): string {
  if (n.decorative) return 'alt="" role="presentation"';
  return `alt="${escapeHtml(n.alt ?? fallback)}"`;
}

function emitImage(n: Node): string {
  if (!n.src) return '';
  const align = n.align ?? 'left';
  const margin = align === 'center' ? '0 auto' : align === 'right' ? '0 0 0 auto' : '0';
  const img = `<img src="${escapeHtml(n.src)}" ${altAttributes(n)} width="${n.maxWidth ?? 100}%" style="display:block;max-width:${n.maxWidth ?? 100}%;height:auto;border-radius:${n.radius ?? 0}px;margin:${margin}">`;
  const linked = safeUrl(n.href) ? `<a href="${escapeHtml(safeUrl(n.href))}">${img}</a>` : img;
  const caption = n.caption ? `<p style="margin:8px 0 0;color:#68766f;font-size:12px;text-align:${align}">${escapeHtml(n.caption)}</p>` : '';
  return linked + caption;
}

function emitBanner(n: Node): string {
  if (!n.src) return '';
  const img = `<img src="${escapeHtml(n.src)}" ${altAttributes(n)} width="100%" style="display:block;width:100%;max-width:100%;height:auto;border-radius:${n.radius ?? 0}px">`;
  return safeUrl(n.href) ? `<a href="${escapeHtml(safeUrl(n.href))}">${img}</a>` : img;
}

function emitLogo(n: Node): string {
  const height = n.height ?? 36;
  const mark = n.src
    ? `<img src="${escapeHtml(n.src)}" ${altAttributes(n, n.content || 'Logo')} height="${height}" style="display:inline-block;height:${height}px;width:auto">`
    : `<span style="font-size:${height}px;font-weight:700;font-family:Georgia,serif;color:${n.accent ?? '#173f33'}">${escapeHtml(n.content || 'ALTA')}</span>`;
  const href = safeUrl(n.href);
  const linked = href ? `<a href="${escapeHtml(href)}">${mark}</a>` : mark;
  return `<p style="text-align:${n.align ?? 'left'};margin:${n.paddingTop ?? 0}px 0">${linked}</p>`;
}

/**
 * ADR-052. Text glyphs, not per-platform brand images: `<svg>` is not in the
 * sanitizer's tag allowlist (opening it is its own decision, matching the
 * rigor ADR-042 gave the CSS allowlist -- measure, then open, never assume
 * survival), and an `<img>` icon needs a hosted asset this product does not
 * have (every asset today is tenant-uploaded, `logo`/`image` kinds only --
 * ADR-043). Styled text is what the prototype itself actually ships
 * (`studio.tsx`'s own `platform()` function) -- restored, not invented, and
 * it needs nothing new from the sanitizer: every property `emitSocial` below
 * writes was already open before this ADR (measured in Context).
 *
 * `other` uses the link's own `label` -- its first letter, uppercased --
 * rather than a platform glyph, because there is no platform to look one up
 * for. An `other` link with no label yet falls back to a plain dot rather
 * than emitting nothing, so a half-filled row still reads as a link.
 */
const SOCIAL_GLYPH: Record<SocialLink['platform'], string> = {
  facebook: 'f', linkedin: 'in', instagram: 'ig', youtube: 'yt',
  tiktok: 'tt', zalo: 'za', threads: 'th', website: '↗', other: '•',
};

export function socialGlyph(link: SocialLink): string {
  if (link.platform === 'other') {
    const initial = link.label?.trim().charAt(0);
    return initial ? initial.toUpperCase() : SOCIAL_GLYPH.other;
  }
  return SOCIAL_GLYPH[link.platform];
}

function emitSocial(n: Node): string {
  const links = (n.social ?? []).filter((link) => link.enabled && safeUrl(link.url));
  const shape = n.socialStyle ?? 'circle';
  const size = n.socialSize ?? 32;
  const accent = n.accent ?? '#173f33';
  // `text` drops the badge entirely and sizes off font-size instead --
  // the prototype's own third Segment option, `width:auto;height:auto`.
  const badge = shape === 'text' ? '' : `width:${size}px;height:${size}px;line-height:${size}px;border-radius:${shape === 'circle' ? '50%' : '6px'};border:1px solid ${accent};`;
  const items = links
    .map((link) => {
      const anchorStyle = [
        'display:inline-block', 'margin:0 6px', 'text-align:center', badge,
        `color:${accent}`, `font-size:${shape === 'text' ? 13 : Math.round(size * 0.4)}px`, 'font-weight:700',
        `text-decoration:${shape === 'text' ? 'underline' : 'none'}`,
      ].filter(Boolean).join(';');
      const title = escapeHtml(link.label || SOCIAL_PLATFORM_LABEL[link.platform]);
      return `<a href="${escapeHtml(safeUrl(link.url))}" title="${title}" style="${anchorStyle}">${escapeHtml(socialGlyph(link))}</a>`;
    })
    .join('');
  return `<p style="text-align:${n.align ?? 'center'}">${items}</p>`;
}

function emitTable(n: Node): string {
  const t = n.table;
  if (!t) return '';
  const caption = t.caption ? `<caption style="padding:0 0 8px;text-align:${t.align};font-weight:700">${escapeHtml(t.caption)}</caption>` : '';
  const rows = t.cells
    .map((row, rowIndex) => {
      const isHeaderRow = t.header && rowIndex === 0;
      const cells = row
        .map((cell) => {
          const tag = isHeaderRow ? 'th' : 'td';
          const bg = isHeaderRow ? t.headerBg : t.zebra && rowIndex % 2 === 0 ? t.altBg : t.rowBg;
          const color = isHeaderRow ? t.headerColor : '#30463d';
          return `<${tag} style="padding:${t.cellPadding}px;border:1px solid ${t.borderColor};background-color:${bg};color:${color};text-align:${t.align}">${escapeHtml(cell)}</${tag}>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${caption}${rows}</table>`;
}

function emitSpacer(n: Node): string {
  return `<div style="height:${n.height ?? 32}px">&nbsp;</div>`;
}

function emitDivider(n: Node): string {
  const height = n.height ?? 1;
  const color = n.accent ?? '#dbe5e0';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:${paddingCss(n)}"><tr><td style="height:${height}px;background-color:${color}"></td></tr></table>`;
}

/**
 * ADR-044: restored from the prototype (`studio.tsx`), where it is one of the
 * sixteen block kinds. Three lines at most -- who, how to reach them, where --
 * and the middle one is the reason the block exists at all: `mailto:` and `tel:`
 * are the two schemes the sanitizer keeps besides http/https/cid, so a contact
 * block can be tapped in a mail client while a typed-out paragraph cannot.
 *
 * `tel:` is stripped down to digits and a leading `+` because a number written
 * for a human to read ("+84 28 1234 5678") is not a number a phone can dial;
 * the visible text keeps the spacing it was typed with.
 *
 * Empty fields drop out rather than emitting a bare separator, so a block filled
 * in halfway still reads as a sentence instead of "· ·".
 */
function emitContact(n: Node): string {
  const c = n.contact;
  if (!c) return '';

  const who = [c.name, c.role].filter(Boolean).map((part) => escapeHtml(part)).join(' · ');
  const mail = c.email ? `<a href="mailto:${escapeHtml(c.email)}" style="color:inherit">${escapeHtml(c.email)}</a>` : '';
  const tel = c.phone ? `<a href="tel:${escapeHtml(c.phone.replace(/[^+\d]/g, ''))}" style="color:inherit">${escapeHtml(c.phone)}</a>` : '';
  const reach = [mail, tel].filter(Boolean).join(' · ');
  const body = [who, reach, c.address && escapeHtml(c.address)].filter(Boolean).join('<br>');
  if (!body) return '';

  const style = [
    `margin:${marginCss(n)}`,
    `color:${n.textColor ?? 'inherit'}`,
    `text-align:${n.align ?? 'left'}`,
    `font-family:${n.fontFamily ?? 'inherit'}`,
    `font-size:${n.fontSize ?? 14}px`,
    `line-height:${n.lineHeight ?? 1.6}`,
  ].join(';');
  return `<p style="${style}">${body}</p>`;
}

/**
 * ADR-050. CAN-SPAM's physical-postal-address requirement, closed the same
 * way `emitContact` closes the mailto:/tel: requirement: a plain `<p>`, no
 * new allowlist entry -- measured against `sanitizeTemplateHtml` while
 * writing the ADR, every property this function writes already survives.
 *
 * Company name, then the address split on `\n` the way `emitList` splits
 * `content` into items -- one line per segment, blanks dropped, joined with
 * `<br>` so a three-line address does not wrap wherever the client feels
 * like it. Empty pieces drop out rather than leaving a stray `<br>`, the same
 * rule `emitContact` follows.
 *
 * `hasPostalAddress` (`publish-readiness.ts`) is what actually enforces the
 * law -- this function only renders what the author put in the block. An
 * empty block renders nothing, same as an image with no `src`.
 */
function emitFooter(n: Node): string {
  const f = n.footer;
  if (!f) return '';
  const addressLines = (f.address ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const name = f.companyName?.trim();
  const parts = [...(name ? [escapeHtml(name)] : []), ...addressLines.map((line) => escapeHtml(line))];
  if (parts.length === 0) return '';
  const style = [
    `margin:${marginCss(n)}`,
    `padding:${paddingCss(n)}`,
    `color:${n.textColor ?? 'inherit'}`,
    `text-align:${n.align ?? 'center'}`,
    `font-family:${n.fontFamily ?? 'inherit'}`,
    `font-size:${n.fontSize ?? 12}px`,
    `line-height:${n.lineHeight ?? 1.6}`,
  ].join(';');
  return `<p${darkInkClass(n)} style="${style}">${parts.join('<br>')}</p>`;
}

/**
 * ADR-045 decision 2 retires a limit this codebase had already written down.
 * ADR-040 §Consequences and the sanitizer audit both recorded that a preheader
 * stays VISIBLE in Outlook desktop, because `mso-hide:all` was being stripped
 * and the other three properties mean nothing to Word. It is allowed now, so
 * the block finally hides everywhere it claims to.
 */
function emitPreheader(n: Node): string {
  return `<div style="display:none!important;max-height:0;overflow:hidden;color:transparent;mso-hide:all">${escapeHtml(n.content ?? '')}</div>`;
}

/** MC-UI-011 (S4 Task 20): pass-through, not a second sanitizer -- see the `html` field's own doc comment on why that is safe. */
function emitCustomHtml(n: Node): string {
  const html = n.html ?? '';
  // No markup means nothing for the rules to select, so the style block would
  // be dead weight the sanitizer still has to walk -- and a `<style>` alone in
  // a table row is not valid email HTML anyway.
  if (!html) return '';
  const css = n.css?.trim() ?? '';
  return css ? `<style>${css}</style>${html}` : html;
}

/** ADR-045: the column's width in real pixels -- what the `<div>` caps itself at, and what the Outlook ghost `<td>` is given. One function so the two can never disagree. */
const columnPixelWidth = (n: Node, theme: EmailTheme): number => Math.round((theme.width * (n.width ?? 100)) / 100);

function emitColumn(n: Node, theme: EmailTheme, stack = theme.stackColumns !== false): string {
  const kids = (n.children ?? []).map((child) => emitNode(child, theme)).join('');
  const bg = n.background ?? '#ffffff';
  const maxWidth = columnPixelWidth(n, theme);
  // MC-UI-007 change_responsive_rules (S4 Task 20): width:100% is what lets this column
  // shrink to its container and stack under narrower ones -- the whole fluid-hybrid
  // technique ADR-037 §2 relies on, since @media is stripped. Stacking off swaps it for
  // the fixed pixel width instead, so the column never shrinks and never stacks.
  //
  // `stack` defaults to the document's `theme.stackColumns` and is overridden per row by
  // `Node.stackMobile` (see `emitRow`): a header row of three logos should hold its
  // shape while the article row beneath it stacks.
  const width = stack ? '100%' : `${maxWidth}px`;
  const style = [
    'display:inline-block',
    `width:${width}`,
    `max-width:${maxWidth}px`,
    'vertical-align:top',
    `padding:${paddingCss(n)}`,
    `background-color:${bg}`,
    ...surfaceCss(n),
    `border:${borderCss(n)}`,
    `border-radius:${radiusCss(n)}`,
  ].join(';');
  return `<div${darkSurfaceClass(bg)} style="${style}">${kids}</div>`;
}

/**
 * ADR-045 decision 1. The second half of the fluid-hybrid technique ADR-037 §2
 * chose, and the half that was never built: Outlook desktop renders through
 * Word, which does not support `display:inline-block` for layout, so every one
 * of `ROW_LAYOUT_PRESETS` collapsed into a single stacked column there. The
 * ghost table gives Word a real `<table>`/`<td>` to lay the columns out in,
 * inside a conditional comment every other client ignores.
 *
 * `<mso-ghost>` rather than the comment itself because `sanitizeTemplateHtml`
 * strips comments before `sanitize-html` ever sees them; the API expands these
 * tags back into comments as its last step. See that function for why the
 * expansion is injection-proof.
 *
 * A one-column row is left alone: a lone full-width `<div>` already stacks
 * correctly in Word, so the scaffolding would be bytes spent on nothing -- and
 * bytes are not free when Gmail clips at 102KB.
 */
const ghost = (kind: 'row-open' | 'row-close' | 'col-close') => `<mso-ghost data-mso="${kind}"></mso-ghost>`;
const ghostColumn = (n: Node, theme: EmailTheme) => `<mso-ghost data-mso="col-open" data-w="${columnPixelWidth(n, theme)}"></mso-ghost>`;

function emitRow(n: Node, theme: EmailTheme): string {
  const children = (n.children ?? []).filter((child) => child.visible !== false);
  const scaffold = children.length > 1;
  // The row's own answer wins when it has one; otherwise the document's.
  // `?? ` rather than `||` so an explicit `false` is not read as "unset".
  const stack = n.stackMobile ?? (theme.stackColumns !== false);
  const columns = children
    .map((child) => (scaffold
      ? `${ghostColumn(child, theme)}${emitColumn(child, theme, stack)}${ghost('col-close')}`
      : emitColumn(child, theme, stack)))
    .join('');
  const body = scaffold ? `${ghost('row-open')}${columns}${ghost('row-close')}` : columns;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="${MSO_TABLE_RESET}"><tr><td align="center" style="text-align:center">${body}</td></tr></table>`;
}

function emitSection(n: Node, theme: EmailTheme): string {
  const kids = (n.children ?? []).map((child) => emitNode(child, theme)).join('');
  const bg = n.background ?? '#ffffff';
  const cellStyle = [
    `padding:${paddingCss(n)}`,
    `background-color:${bg}`,
    ...surfaceCss(n),
    `border:${borderCss(n)}`,
    `border-radius:${radiusCss(n)}`,
  ].join(';');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"${darkSurfaceClass(bg)} style="background-color:${bg};${MSO_TABLE_RESET}"><tr><td${darkSurfaceClass(bg)} style="${cellStyle}">${kids}</td></tr></table>`;
}

/** `Node` -> HTML for one node and its descendants. `theme` defaults so a single leaf block can be emitted standalone in a test without a surrounding `Doc`. */
export function emitNode(n: Node, theme: EmailTheme = defaultTheme): string {
  if (n.visible === false) return '';
  switch (n.kind) {
    case 'section':
      return emitSection(n, theme);
    case 'row':
      return emitRow(n, theme);
    case 'column':
      return emitColumn(n, theme);
    case 'text':
    case 'heading':
      return emitText(n);
    case 'list':
      return emitList(n);
    case 'button':
      return emitButton(n);
    case 'image':
      return emitImage(n);
    case 'banner':
      return emitBanner(n);
    case 'logo':
      return emitLogo(n);
    case 'social':
      return emitSocial(n);
    case 'table':
      return emitTable(n);
    case 'spacer':
      return emitSpacer(n);
    case 'divider':
      return emitDivider(n);
    case 'contact':
      return emitContact(n);
    case 'footer':
      return emitFooter(n);
    case 'preheader':
      return emitPreheader(n);
    case 'customHtml':
      return emitCustomHtml(n);
    default:
      return '';
  }
}

/** `Doc` -> a complete HTML document. Independent of `projectData`'s shape -- this is the only function `ContentStore.save` needs to have already been called through. */
/**
 * ADR-045 decisions 3 and 4. Until this ADR the `<head>` could hold nothing:
 * `meta` and `title` were not in the sanitizer's tag list and `lang` not in its
 * attribute list, so all four of the tags below were stripped on save -- the
 * viewport meta included, which this function had been emitting since it was
 * written without it ever once surviving.
 *
 * `charset` anchors the encoding for "view in browser", a saved `.html` and a
 * forward; the MIME header already carries utf-8 on the SMTP path, so this
 * covers the routes that leave it. `color-scheme` is what stops Apple Mail and
 * Outlook.com from inverting the palette on their own.
 *
 * `lang` is fixed at Vietnamese because that is what this product writes and
 * the model carries no language field; giving a template its own language is a
 * separate decision, not something to smuggle in behind a `<head>` fix.
 */
const HEAD_META = '<meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<meta name="color-scheme" content="light dark">'
  // ADR-047: Apple Mail's older builds read this name and not `color-scheme`.
  // Declaring support in a form half the clients that care cannot read is still
  // an empty declaration in that half, which is the defect this ADR closes.
  + '<meta name="supported-color-schemes" content="light dark">'
  /**
   * ADR-047 decision 1. Expands into the dark-mode stylesheet in
   * `sanitizeTemplateHtml`, after every measurement, the same way
   * `<mso-ghost>` becomes a conditional comment.
   *
   * A tag rather than the `<style>` itself because a surviving stylesheet is
   * a hole through the whole property allowlist: `allowedStyles` inspects
   * `style="..."` attributes only, and CSS inside `@media` is never inlined,
   * so it never meets the filter. Measured; see the ADR.
   */
  + '<mc-dark></mc-dark>';



export function emitDoc(doc: Doc): string {
  const theme: EmailTheme = { ...defaultTheme, ...doc.theme };
  const body = doc.nodes.map((n) => emitNode(n, theme)).join('');
  const title = doc.title.trim() ? `<title>${escapeHtml(doc.title.trim())}</title>` : '';
  return `<!doctype html><html lang="vi"><head>${HEAD_META}${title}</head><body class="mc-dark-bg" style="margin:0;background-color:${theme.outerBg};color:${BODY_INK};font-family:${theme.fontFamily};font-size:${theme.baseFontSize}px"><table role="presentation" width="100%" style="${MSO_TABLE_RESET}"><tr><td align="center"><table role="presentation" width="${theme.width}" ${darkSurfaceClass(theme.contentBg)} style="width:100%;max-width:${theme.width}px;background-color:${theme.contentBg};${MSO_TABLE_RESET}">${body}</table></td></tr></table></body></html>`;
}
