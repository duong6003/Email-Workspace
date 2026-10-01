import juice from 'juice';
import sanitizeHtml from 'sanitize-html';

export const MAX_TEMPLATE_HTML_BYTES = 5 * 1024 * 1024;

export type TemplateSanitizationResult = {
  html: string;
  warnings: string[];
  errors: string[];
  changes: string[];
};

const emailTags = [
  'a', 'b', 'blockquote', 'body', 'br', 'caption', 'center', 'code', 'div', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'head', 'hr', 'html', 'i', 'img', 'li', 'meta', 'ol', 'p', 'pre', 'span', 'strong', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'u', 'ul',
  /**
   * ADR-045 decision 1. Never reaches a recipient: `expandMsoGhosts` turns every
   * surviving one into a conditional comment as the last step of
   * `sanitizeTemplateHtml`.
   *
   * It is a TAG here rather than the comment it becomes because `sanitize-html`
   * keeps comments under no configuration -- measured against three (default,
   * `'!--'` in `allowedTags`, `parser.recognizeCDATA`) -- and `withoutComments`
   * strips them before the library is even reached. Travelling as a tag is what
   * lets the allowlist vet this content the ordinary way instead of carving out
   * an exception for it.
   */
  'mso-ghost',
  /**
   * ADR-047 decision 1. Same shape as `mso-ghost` above and never reaches a
   * recipient as itself: `expandDarkMode` turns it into the dark-mode
   * stylesheet as the last step of `sanitizeTemplateHtml`.
   *
   * It carries NO attributes, which makes it stricter than `mso-ghost` --
   * there the author still influences one integer (`data-w`), here the
   * expansion has no parameter at all and the whole `<style>` body is a
   * constant in this file.
   */
  'mc-dark',
];

const emailAttributes: Record<string, string[]> = {
  a: ['href', 'name', 'target', 'title'],
  // `role` is here for ADR-043 §8 only: a decorative image must reach the inbox
  // as `alt=""` AND `role="presentation"`, because an empty alt on its own
  // cannot be told apart from a forgotten one -- and `IMAGE_ALT_MISSING` reads
  // that pair to decide the same thing. Measured first: the attribute was being
  // stripped, which made the accepted decision unimplementable at the only
  // layer that counts. The value is narrowed to presentation/none in
  // `transformTags` below; `table` has carried `role` since M3-S1.
  img: ['alt', 'height', 'role', 'src', 'title', 'width'],
  table: ['align', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'height', 'role', 'width'],
  td: ['align', 'bgcolor', 'colspan', 'height', 'rowspan', 'valign', 'width'],
  th: ['align', 'bgcolor', 'colspan', 'height', 'rowspan', 'scope', 'valign', 'width'],
  /**
   * ADR-045 decision 3. `http-equiv` is EXCLUDED on purpose, and
   * `template-html-sanitizer.test.ts` locks that: measured both ways before
   * this shipped, listing it lets `<meta http-equiv="refresh"
   * content="0;url=…">` through intact and the template becomes an open
   * redirect; leaving it out drops the attribute and only an inert
   * `<meta content="…">` husk remains. One line is the whole difference between
   * three head tags and a redirect channel, so it is a test, not a comment.
   */
  meta: ['charset', 'content', 'name'],
  html: ['lang'],
  /** ADR-045 decision 1. Closed vocabulary; both values are re-validated at expansion time. */
  'mso-ghost': ['data-mso', 'data-w'],
  '*': ['class', 'style', 'title'],
};

const safeStyleValues = [
  /^#[0-9a-f]{3,8}$/i,
  /^(?:rgb|rgba)\([\d\s,.%]+\)$/i,
  /^(?:[\d.]+)(?:px|em|rem|%|pt)?$/i,
  /^(?:normal|bold|italic|none|left|right|center|justify|top|middle|bottom|solid|dashed|underline|line-through|inherit|initial|unset)$/i,
  /^[a-z][a-z\s,-]*$/i,
];

/**
 * ADR-038: one token of a space-separated shorthand. Deliberately excludes the two
 * whitespace-bearing patterns above (the font stack and the spaced `rgb()`): joining a
 * token that can match whitespace with a `\s+` separator makes the partition ambiguous,
 * which is a backtracking hazard on attacker-supplied CSS. Both still match whole values.
 * The bare-word branch is no more permissive than the existing whole-value word pattern --
 * it is that same class, tokenised -- and it is what lets `border:0 solid transparent`
 * through, which is the form real builder output emits.
 */
const shorthandToken = '(?:#[0-9a-f]{3,8}|(?:rgb|rgba)\\([\\d,.%]+\\)|[\\d.]+(?:px|em|rem|%|pt)?|[a-z][a-z-]*)';

/** Two to four safe tokens. CSS shorthand never takes more than four. */
const safeShorthandValue = new RegExp(`^${shorthandToken}(?:\\s+${shorthandToken}){1,3}$`, 'i');

/**
 * Only for the allowlisted properties whose CSS grammar actually takes several values.
 * Every other property keeps the single-token rule, so `color:1px solid` stays rejected.
 */
const safeShorthandStyleValues = [...safeStyleValues, safeShorthandValue];

/**
 * ADR-042: `letter-spacing` is the one existing value shape (number + unit) that also needs
 * a leading `-` -- negative tracking is a normal typographic choice on headings, and none of
 * the shared `safeStyleValues` patterns admit a sign. Scoped to this property alone so the
 * sign doesn't widen what every other numeric property (padding, width, ...) accepts.
 */
const letterSpacingValues = [/^-?(?:[\d.]+)(?:px|em|rem|%)?$/i];

/** ADR-042: keywords `text-transform` actually takes; the shared keyword list has none of them. */
const textTransformValues = [/^(?:uppercase|lowercase|capitalize|none|inherit|initial|unset)$/i];

/**
 * ADR-042: `background-image` limited to `linear-gradient()` -- never `url(`. The grammar is
 * spelled out explicitly (optional angle or `to <side>` direction, then 2-6 color stops built
 * only from hex/`rgb()`/`rgba()` colors with an optional `%` stop) rather than reusing the
 * generic word pattern, because a `url(...)` argument does not fit this shape at all and so
 * cannot match even nested inside a gradient call -- this is the actual security boundary for
 * the property, not `unsafeCss` (that regex only screens `<style>` block text, not inline
 * `style="..."` attribute values). Measured against both plain and nested `url(` before this
 * shipped (evidence in the ADR); both are dropped, not just the outer form.
 */
const gradientColorStop = '(?:#[0-9a-f]{3,8}|rgba?\\([\\d\\s,.%]+\\))(?:\\s+\\d+(?:\\.\\d+)?%)?';
const gradientDirection = '(?:to\\s+(?:top|right|bottom|left)(?:\\s+(?:top|right|bottom|left))?|-?\\d+(?:\\.\\d+)?deg)';
const backgroundImageValues = [new RegExp(`^linear-gradient\\(\\s*(?:${gradientDirection}\\s*,\\s*)?${gradientColorStop}(?:\\s*,\\s*${gradientColorStop}){1,5}\\s*\\)$`, 'i')];

/**
 * ADR-045 decision 2. Four named properties, each with its own vocabulary --
 * `mso-*` is NOT opened by prefix, because the prefix is a namespace, not a
 * safety class. Every one is inert in clients that are not Outlook desktop,
 * none can reference a URL, and none is a shorthand.
 *
 * `mso-hide` is the one that retires a limitation the codebase had already
 * written down: ADR-040 §Consequences and the sanitizer audit both recorded
 * that a preheader stays visible in Outlook desktop because this declaration
 * was stripped. It is no longer stripped.
 */
const msoLineHeightRuleValues = [/^(?:exactly|at-least)$/i];
const msoHideValues = [/^all$/i];
const msoTableSpaceValues = [/^0(?:pt|px)?$/i];

/**
 * ADR-048. The one property a list block needs and the only one of the five
 * routes to a marker that is opened.
 *
 * Its own keyword list, not the shared `safeStyleValues` word pattern -- the
 * same reasoning ADR-042 decision 3 gave for `text-transform`: putting these
 * words in the shared list would let `text-align:upper-roman` parse as
 * something plausible that merely survives.
 *
 * `list-style` (the shorthand) stays closed on purpose: it carries
 * `list-style-image`, which takes `url()`, and ADR-042 decision 4 spent a
 * whole purpose-built grammar keeping `url(` out of `background-image`.
 * Opening a back door to it here would undo that.
 */
const listStyleTypeValues = [/^(?:disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman|none)$/i];

const allowedStyles = {
  '*': {
    'mso-line-height-rule': msoLineHeightRuleValues,
    'mso-hide': msoHideValues,
    'mso-table-lspace': msoTableSpaceValues,
    'mso-table-rspace': msoTableSpaceValues,
    color: safeStyleValues,
    'background-color': safeStyleValues,
    'font-family': safeStyleValues,
    'font-size': safeStyleValues,
    'font-style': safeStyleValues,
    'font-weight': safeStyleValues,
    'line-height': safeStyleValues,
    'text-align': safeStyleValues,
    'text-decoration': safeStyleValues,
    'vertical-align': safeStyleValues,
    width: safeStyleValues,
    height: safeStyleValues,
    'max-width': safeStyleValues,
    'min-width': safeStyleValues,
    // ADR-040: pure layout, and the only way a preheader can hide its text from the body
    // while still feeding the inbox preview line. `opacity` is deliberately excluded --
    // redundant once these three are here, and a second way to hide for no new capability.
    display: safeStyleValues,
    'max-height': safeStyleValues,
    overflow: safeStyleValues,
    border: safeShorthandStyleValues,
    'border-radius': safeShorthandStyleValues,
    'border-collapse': safeStyleValues,
    'border-spacing': safeShorthandStyleValues,
    margin: safeShorthandStyleValues,
    padding: safeShorthandStyleValues,
    // ADR-042: presentational-only, none can reference a URL or execute anything.
    'box-shadow': safeShorthandStyleValues,
    'letter-spacing': letterSpacingValues,
    'text-transform': textTransformValues,
    'background-image': backgroundImageValues,
    // ADR-048: presentational only -- no URL, no execution, no layout effect.
    'list-style-type': listStyleTypeValues,
  },
};

const unsafeCss = /(?:@import|url\s*\(|expression\s*\(|behavior\s*:|-moz-binding|javascript\s*:|data\s*:)/i;

/* ---------------------------------------------------------------------------
 * Measuring what was discarded.
 *
 * `2026-09-01-sanitizer-reports-what-it-removed-design.md` §3.1 rejected hooking
 * into sanitize-html -- it has no callback for what it drops, so knowing would
 * mean applying the allowlist a second time here, and two copies drift. ADR-038,
 * ADR-040 and ADR-042 each edited the allowlist inside a fortnight; the second
 * copy would have been stale on all three days.
 *
 * So nothing below knows a single allowlist rule. It counts declarations,
 * attributes and tags in the string going in and the string coming out, and
 * reports the shortfall. Change the allowlist however you like: this keeps
 * measuring the truth, because it measures the result.
 * ------------------------------------------------------------------------- */

type RemovalKind = 'stylesheet' | 'media' | 'tag' | 'image' | 'attribute' | 'style';
type Removal = { kind: RemovalKind; name: string; count: number };

/**
 * Removed before anything else reads the document, for two measured reasons --
 * one a content-destroying bug that had been here since M3-S1.
 *
 * 1. `stripUnsafeStyleBlocks` matches `<style ...>(anything)</style>`. A comment
 *    that merely MENTIONS `<style>` opens a match which then runs to the next
 *    REAL `</style>`, so the regex sees one enormous stylesheet spanning the
 *    comment and the author's actual CSS. One `url(` anywhere in that span --
 *    in the prose is enough -- and the whole thing is deleted. Measured on
 *    `evidence/s7-task43/lossy-import-sample.html`: 611 characters destroyed,
 *    including a working @media rule, with nothing said about it.
 *
 * 2. The removal counters would otherwise treat every tag, attribute and
 *    declaration NAMED inside a comment as removed, because sanitize-html
 *    discards comments at the end. The same sample's header made the report
 *    claim `<td>`, `<tr>`, `<a>` and `<body>` had all been deleted while they
 *    were still in the output.
 *
 * Neither is an edge case: real email HTML is full of comments, Outlook
 * conditional blocks most of all. Doing this changes no output -- sanitize-html
 * discards comments regardless -- it only stops their contents being read as
 * though they were markup. And a comment going missing is not a loss worth
 * reporting, because a comment never reached a reader in the first place.
 */
function withoutComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** Everything a `sanitize()` call can be asked about; `juice` is asked about media queries only. */
const COUNTERS: Record<'tag' | 'attribute' | 'style' | 'media' | 'stylesheet', (html: string) => string[]> = {
  // ADR-045: the hyphen is here so `<mso-ghost>` counts as `mso-ghost` rather
  // than as a phantom `mso` tag. No previously allowed tag contains one, so
  // nothing else counts differently than it did.
  tag: (html) => [...html.matchAll(/<([a-z][a-z0-9-]*)\b/gi)].map((match) => match[1].toLowerCase()),
  attribute: (html) => [...html.matchAll(/<[a-z][a-z0-9]*\b([^>]*)>/gi)]
    .flatMap((tag) => [...tag[1].matchAll(/(?:^|\s)([a-z_:][-a-z0-9_:.]*)\s*=/gi)].map((attribute) => attribute[1].toLowerCase())),
  style: (html) => [...html.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .flatMap((attribute) => (attribute[1] ?? attribute[2] ?? '').split(';'))
    .map((declaration) => declaration.split(':')[0]?.trim().toLowerCase() ?? '')
    .filter((property) => /^[a-z-]+$/.test(property)),
  media: (html) => [...html.matchAll(/@media\b/gi)].map(() => '@media'),
  stylesheet: (html) => [...html.matchAll(/<style\b/gi)].map(() => 'stylesheet'),
};

function tally(source: string, counter: (html: string) => string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of counter(source)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

/** Only a shortfall is a loss. Unchanged or increased counts stay silent (design §3.3). */
function shortfall(before: string, after: string, kind: RemovalKind & keyof typeof COUNTERS, skip: ReadonlySet<string> = new Set()): Removal[] {
  const seen = tally(before, COUNTERS[kind]);
  const left = tally(after, COUNTERS[kind]);
  const removals: Removal[] = [];
  for (const [name, count] of seen) {
    if (skip.has(name)) continue;
    const remaining = left.get(name) ?? 0;
    if (count > remaining) removals.push({ kind, name, count: count - remaining });
  }
  return removals;
}

/**
 * `<style>` is excluded from the second pass on purpose. It is allowed in the
 * first pass and disallowed in the second precisely so `juice` can inline it in
 * between -- its disappearance there is the pipeline working, not a loss, and
 * the media query it may have carried is reported by its own measurement.
 */
const SANITIZE_PASS_2_TAG_EXEMPTIONS: ReadonlySet<string> = new Set(['style']);

/**
 * Two attributes whose loss is always described better somewhere else, so
 * reporting them here would say the same thing twice:
 *
 * - `style` is dropped by sanitize-html once every declaration inside it has
 *   been rejected. The declarations are the loss and each gets its own line
 *   naming the property and, where one exists, the replacement.
 * - `src` is only ever allowed on `<img>`, so losing it means a picture went
 *   missing, which earns a sentence about the picture rather than a sentence
 *   about an attribute.
 */
const ATTRIBUTES_REPORTED_ELSEWHERE: ReadonlySet<string> = new Set(['style', 'src']);

/**
 * When an element is removed outright, everything it carried goes with it. The
 * tag sentence already says so, and adding "removed attribute type on 1 element"
 * after "removed 1 <script> tag" is noise that teaches a reader to skim.
 *
 * Only tags removed *completely* are blanked -- a tag kept in some places and
 * dropped in others still has surviving instances whose attribute losses are
 * real and must not be hidden. Under-reporting is the failure this whole slice
 * exists to end, so the narrower rule is the safe one.
 */
function withoutRemovedElements(before: string, after: string): string {
  const remaining = tally(after, COUNTERS.tag);
  const gone = [...tally(before, COUNTERS.tag).keys()].filter((name) => (remaining.get(name) ?? 0) === 0);
  if (gone.length === 0) return before;
  return before.replace(new RegExp(`<(?:${gone.join('|')})\\b[^>]*>`, 'gi'), '');
}

function measureSanitize(before: string, after: string, tagExemptions: ReadonlySet<string> = new Set()): Removal[] {
  const carriers = withoutRemovedElements(before, after);
  return [
    ...shortfall(before, after, 'tag', tagExemptions),
    ...shortfall(carriers, after, 'attribute', ATTRIBUTES_REPORTED_ELSEWHERE),
    ...shortfall(carriers, after, 'style'),
  ];
}

/**
 * Where a replacement exists, name it. This is the sentence that would have
 * saved both the CTA button and the table cell in the block audit: the author
 * did not need to be told `background` is unsupported, they needed to be told to
 * write `background-color`.
 */
const REPLACEMENT: Record<string, string> = {
  background: 'dùng background-color',
  'border-top': 'dùng một hàng bảng có height và background-color',
  'border-bottom': 'dùng một hàng bảng có height và background-color',
  'border-left': 'dùng một hàng bảng có width và background-color',
  'border-right': 'dùng một hàng bảng có width và background-color',
  font: 'tách thành font-size, font-weight và font-family',
  opacity: 'dùng display:none để ẩn hẳn',
  'aria-label': 'dùng title',
};

/**
 * Biggest loss first: a whole stylesheet changes more of the email than one
 * declaration does. Within a kind, the most frequent first, so the cap in
 * `describeRemovals` drops the least consequential lines rather than arbitrary
 * ones.
 */
const KIND_ORDER: readonly RemovalKind[] = ['stylesheet', 'media', 'tag', 'image', 'attribute', 'style'];

function sentence(removal: Removal): string {
  const hint = REPLACEMENT[removal.name];
  const suffix = hint ? ` — ${hint}.` : '.';
  switch (removal.kind) {
    case 'stylesheet':
      return `Đã loại bỏ ${String(removal.count)} biểu định kiểu <style> vì chứa tài nguyên hoặc biểu thức không an toàn.`;
    case 'media':
      return `Đã loại bỏ ${String(removal.count)} quy tắc @media — email sẽ dùng cùng một bố cục trên mọi thiết bị.`;
    case 'tag':
      return `Đã loại bỏ ${String(removal.count)} thẻ <${removal.name}>${suffix}`;
    case 'image':
      return `Đã loại bỏ nguồn của ${String(removal.count)} ảnh không dùng https — tải ảnh lên thư viện rồi chèn lại.`;
    case 'attribute':
      return `Đã loại bỏ thuộc tính ${removal.name} trên ${String(removal.count)} phần tử${suffix}`;
    case 'style':
      return `Đã loại bỏ ${String(removal.count)} khai báo ${removal.name}${hint ? ` — ${hint}.` : ' (không được hỗ trợ trong email).'}`;
  }
}

/**
 * Design §3.5: this runs on every autosave, not only on import. Fifteen lines
 * every couple of seconds is fifteen lines nobody reads by the end of day one.
 */
const MAX_CHANGE_LINES = 10;

function describeRemovals(removals: readonly Removal[]): string[] {
  const ordered = [...removals].sort((left, right) => (
    KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) || right.count - left.count || left.name.localeCompare(right.name)
  ));
  if (ordered.length <= MAX_CHANGE_LINES) return ordered.map(sentence);
  const shown = ordered.slice(0, MAX_CHANGE_LINES - 1).map(sentence);
  return [...shown, `…và ${String(ordered.length - shown.length)} loại khác.`];
}

/**
 * ADR-045 decision 1 -- the security boundary of the whole Outlook layer.
 *
 * Every expansion below is a CONSTANT in this file. The only thing an author
 * can influence is `data-w`, and that is parsed to a number, range-checked, and
 * re-serialised with `String()` rather than interpolated as written -- so no
 * character an author types can reach the inside of a conditional comment,
 * which is the one place `sanitize-html` cannot look.
 *
 * A `data-mso` outside the four keys, or a `data-w` that is not an integer in
 * 1..1000, DROPS the tag. It is not passed through unexpanded and it is not
 * expanded with a default: an unrecognised ghost is a bug or an attack, and
 * either way the safe output is nothing.
 *
 * Runs after the final `sanitize()` and after `measureSanitize`, so the change
 * counters compare like with like -- counting a comment's `<table>` as a tag
 * that appeared out of nowhere would report a removal in reverse.
 */
const GHOST_ROW_OPEN = '<!--[if mso]><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><![endif]-->';
const GHOST_ROW_CLOSE = '<!--[if mso]></tr></table><![endif]-->';
const GHOST_COL_CLOSE = '<!--[if mso]></td><![endif]-->';
const MSO_GHOST_MAX_WIDTH = 1000;

function ghostColumnOpen(rawWidth: string | undefined): string {
  if (!rawWidth || !/^[0-9]{1,4}$/.test(rawWidth)) return '';
  const width = Number(rawWidth);
  if (!Number.isInteger(width) || width < 1 || width > MSO_GHOST_MAX_WIDTH) return '';
  return `<!--[if mso]><td width="${String(width)}" valign="top"><![endif]-->`;
}

function expandMsoGhosts(html: string): string {
  return html
    .replace(/<mso-ghost\b([^>]*)>/gi, (_tag, rawAttributes: string) => {
      const attribute = (name: string): string | undefined =>
        new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'i').exec(rawAttributes)?.[1];
      switch (attribute('data-mso')) {
        case 'row-open': return GHOST_ROW_OPEN;
        case 'row-close': return GHOST_ROW_CLOSE;
        case 'col-open': return ghostColumnOpen(attribute('data-w'));
        case 'col-close': return GHOST_COL_CLOSE;
        default: return '';
      }
    })
    .replace(/<\/mso-ghost\s*>/gi, '');
}

/**
 * ADR-047 -- the dark-mode palette, and the only `<style>` block that may exist
 * in stored HTML.
 *
 * Built this way rather than by letting a stylesheet survive the pipeline,
 * because measurement said the second route is not the small change it looks
 * like: `sanitize-html`'s `allowedStyles` inspects `style="..."` ATTRIBUTES
 * only, never the CSS inside a `<style>` tag. Measured 2026-09-11 --
 * `.x{position:absolute;behavior:url(x.htc)}` inside a `<style>` came back
 * untouched with `allowedStyles` configured, while the same declarations in an
 * attribute were filtered to nothing. And CSS inside `@media` is never inlined
 * by `juice`, so it never meets the attribute filter at all. Since
 * `emitCustomHtml` emits `<style>` from author-typed CSS, opening that door
 * would have handed every one of the 27 allowlisted properties a bypass.
 *
 * So the text below is a CONSTANT. There is no parameter, no interpolation,
 * nothing an author can influence -- the emitter's only say is whether it
 * emits the marker tag at all, and which elements it puts the classes on.
 *
 * ADR-037 §2 is not reversed. The single `@media` here changes two colour
 * properties and no layout property; there is no breakpoint, no `max-width`,
 * and no route for another `@media` to appear, because this string is the only
 * one that can.
 *
 * Runs after the final `sanitize()` and after `measureSanitize`, for the same
 * reason `expandMsoGhosts` does: a `<style>` appearing out of nowhere would be
 * reported as a tag that was added rather than one that was never removed.
 */
const DARK_MODE_STYLE = '<style>@media (prefers-color-scheme:dark){'
  + '.mc-dark-bg{background-color:#0f1613!important}'
  + '.mc-dark-surface{background-color:#16211d!important}'
  + '.mc-dark-ink{color:#e6ede9!important}'
  + '}</style>';

/**
 * Expands the FIRST marker and drops every other trace of the tag.
 *
 * "First, then drop the rest" rather than "expand each" because of something
 * the ADR-047 gate caught and the ADR originally got wrong: a forged
 * `<mc-dark data-x="1">` cannot be told apart here, because `sanitize-html`
 * has already stripped the attribute -- `mc-dark` allows none -- so by the time
 * this runs every surviving marker is bare. Refusing to expand an attributed
 * marker is therefore not implementable at this layer, and it does not need to
 * be: the expansion takes no parameter, so an extra marker can only ask for the
 * same constant stylesheet. What it could do is ask for it fifty times, and
 * `<style>` is not free, so only one is ever written.
 */
function expandDarkMode(html: string): string {
  let expanded = false;
  return html
    .replace(/<mc-dark\s*>\s*<\/mc-dark\s*>/gi, () => {
      if (expanded) return '';
      expanded = true;
      return DARK_MODE_STYLE;
    })
    .replace(/<mc-dark(?![a-z0-9-])[^>]*>/gi, '')
    .replace(/<\/mc-dark\s*>/gi, '');
}

function isPermittedImageSource(value: string | undefined): boolean {
  return Boolean(value && /^(?:https:|cid:)/i.test(value));
}

function stripUnsafeStyleBlocks(html: string, warnings: string[]): string {
  return html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (block, css: string) => {
    if (!unsafeCss.test(css)) return block;
    warnings.push('Removed a stylesheet containing an unsafe resource or expression.');
    return '';
  });
}

function sanitize(html: string, allowStylesheet: boolean, warnings: string[], strippedImages?: { count: number }): string {
  return sanitizeHtml(html, {
    allowedTags: allowStylesheet ? [...emailTags, 'style'] : emailTags,
    allowedAttributes: emailAttributes,
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid'],
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    // Stylesheets exist only during the first pass; they are pre-screened,
    // inlined without resource loading, then removed by the final pass.
    allowVulnerableTags: allowStylesheet,
    allowedStyles,
    nestingLimit: 100,
    transformTags: {
      /**
       * ADR-045 decision 3, tightened after measurement. Dropping `http-equiv`
       * alone leaves the husk `<meta content="0;url=https://attacker.test">`
       * behind: inert in every client, but an attacker's URL sitting in stored
       * HTML is not something to shrug at, and a reviewer reading a template
       * should never have to decide whether it matters.
       *
       * So a `<meta>` must carry `charset` or a `name` to exist at all. That is
       * the same default-deny shape as the rest of the allowlist -- recognised
       * forms survive, everything else goes -- rather than a list of the ways a
       * meta tag can be abused.
       */
      meta: (tagName, attribs) => (attribs.charset || attribs.name ? { tagName, attribs } : { tagName: '', attribs: {} }),
      img: (tagName, attribs) => {
        // Only the two roles that mean "ignore this element". Anything else is
        // removed rather than left as a bare `role`, which is what the
        // allowlist's own `values` option produces and which reads as
        // `role=""` downstream.
        const withRole = attribs.role === 'presentation' || attribs.role === 'none'
          ? attribs
          : (() => { const { role: _role, ...rest } = attribs; return rest; })();
        if (isPermittedImageSource(withRole.src)) return { tagName, attribs: withRole };
        if (withRole.src) {
          warnings.push('Removed an image resource that is not HTTPS or cid.');
          // Counted here rather than derived from the attribute diff: `src` going
          // missing on an <img> is a picture disappearing from the email, which
          // deserves its own sentence, not a line about an attribute.
          if (strippedImages) strippedImages.count += 1;
        }
        const { src: _src, ...safeAttributes } = withRole;
        return { tagName, attribs: safeAttributes };
      },
    },
  });
}

/**
 * Produces the only HTML that may be persisted for a template draft. `juice()`
 * is deliberately used without resource-loading helpers, so CSS inlining never
 * performs a remote fetch.
 */
export function sanitizeTemplateHtml(input: string): TemplateSanitizationResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const changes: string[] = [];

  if (Buffer.byteLength(input, 'utf8') > MAX_TEMPLATE_HTML_BYTES) {
    return { html: '', warnings, errors: ['HTML import exceeds the 5 MB limit.'], changes };
  }

  // Four measurement points, one per place the pipeline can lose something.
  // Gap analysis §4.1: the design named two, and `@media` is lost at neither of
  // them -- `juice` discards it, which is why a report built to the letter of
  // §3.2 could never mention the one loss that breaks every phone.
  const strippedImages = { count: 0 };
  const removals: Removal[] = [];

  const document = withoutComments(input);
  const stripped = stripUnsafeStyleBlocks(document, warnings);
  removals.push(...shortfall(document, stripped, 'stylesheet'));

  const structural = sanitize(stripped, true, warnings, strippedImages);
  removals.push(...measureSanitize(stripped, structural));

  const inlined = juice(structural, { applyStyleTags: true, preserveMediaQueries: false, removeStyleTags: true });
  // Media queries only. Everything else `juice` does here -- moving declarations
  // out of <style> and into style="" -- is a legitimate transformation, and
  // counting it would report one declaration as several losses (design §3.2).
  removals.push(...shortfall(structural, inlined, 'media'));

  const sanitized = sanitize(inlined, false, warnings, strippedImages);
  removals.push(...measureSanitize(inlined, sanitized, SANITIZE_PASS_2_TAG_EXEMPTIONS));

  if (strippedImages.count > 0) removals.push({ kind: 'image', name: 'src', count: strippedImages.count });
  changes.push(...describeRemovals(removals));
  // ADR-045: last, and after every measurement -- see `expandMsoGhosts`.
  return { html: expandDarkMode(expandMsoGhosts(sanitized)), warnings: [...new Set(warnings)], errors, changes };
}
