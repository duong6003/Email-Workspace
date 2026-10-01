/**
 * The component tree behind a `builder`-origin template. Ported from the
 * Mailcraft prototype's `Doc`/`Node` (studio.tsx) and trimmed to the block
 * kinds S2 emits (see the vertical-slice plan, Task 5/6). No behavior here --
 * `emitter.ts` turns this into HTML, `engine.ts` wraps both behind the
 * `EmailEditorEngine` port.
 */

export type Align = 'left' | 'center' | 'right';

/**
 * The kind lists are runtime arrays and the unions are derived from them, not
 * the other way round. `ARCH-BUILDER-SANITIZER` reads `KINDS` to assert every
 * kind has a sample block run through the real sanitizer; with a type-only
 * union it could not, and a kind added without a sample would go unchecked
 * while the suite stayed green.
 */
export const LEAF_KINDS = ['text', 'heading', 'list', 'button', 'image', 'banner', 'logo', 'social', 'table', 'spacer', 'divider', 'contact', 'footer', 'preheader', 'customHtml'] as const;

/**
 * The kinds whose `src` reaches an `<img>` in the emitted HTML. One list, in
 * the model, because three separate places need the same answer and drifting
 * copies would each be wrong in a different way: `tree-ops` refuses to bind an
 * asset to anything else, `assets.ts` decides what counts as a missing image,
 * and the inspector decides who gets the decorative checkbox.
 */
export const IMAGE_BEARING_KINDS = ['image', 'banner', 'logo'] as const;
export const CONTAINER_KINDS = ['section', 'row', 'column'] as const;
export const KINDS = [...LEAF_KINDS, ...CONTAINER_KINDS] as const;

export type LeafKind = (typeof LEAF_KINDS)[number];
export type ContainerKind = (typeof CONTAINER_KINDS)[number];
export type Kind = (typeof KINDS)[number];

/**
 * ADR-046 decision 2. A CLOSED set of four: each maps to one constant tag in
 * `emitter.ts` (`<strong>`, `<em>`, `<u>`, `<a href>`), all four measured to
 * survive `sanitizeTemplateHtml` intact. Adding a fifth is an ADR, not an
 * array edit -- the emitter's `switch` has no default that renders anything.
 *
 * Lists and `blockquote` are deliberately NOT here. Measured 2026-09-11: a
 * `<ul>` inside the `<p>` that `emitText` produces splits the paragraph in two
 * and leaves an empty `<p></p>` behind, while the same `<ul>` inside an `<h2>`
 * nests normally -- one author action, two different results. A list is a
 * block, not a range, and belongs to a block kind of its own.
 */
export type InlineMarkKind = 'strong' | 'em' | 'underline' | 'link';

/** One formatting range over `Node.content`. `href` is present only for `link`, and is still put through `safeUrl` at emit time. */
export type InlineMark = {
  start: number;
  end: number;
  kind: InlineMarkKind;
  href?: string;
};

/**
 * ADR-048. The marker styles `list-style-type` accepts after that ADR opened it
 * -- measured, all nine survive `sanitizeTemplateHtml`, and every other route
 * to a marker (`list-style`, `list-style-position`, `type`, `start`) is still
 * stripped.
 */
export const LIST_STYLES = ['disc', 'circle', 'square', 'decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman', 'none'] as const;
export type ListStyle = (typeof LIST_STYLES)[number];

/**
 * ADR-052. Opened from the hardcoded five to include the three the audit
 * backlog names by name (Zalo, TikTok, Threads), plus `other` -- an escape
 * hatch for anything not on this list. `other` uses the link's own `label`
 * for both the accessible name and (its first letter) the emitted glyph
 * (`emitter.ts`'s `socialGlyph`), so a ninth platform never needs a code
 * change to be usable -- just a plainer badge until a real ADR adds it by
 * name, the same "declared, not guessed" posture `list-style-type` (ADR-048)
 * takes for its own closed vocabulary.
 */
export const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'linkedin', 'youtube', 'tiktok', 'zalo', 'threads', 'website', 'other'] as const;
export type SocialPlatformKind = (typeof SOCIAL_PLATFORMS)[number];

/** Vietnamese label per platform -- the editor's `<select>` options and the emitted `<a title>` fallback both read this one map, not two hand-copied lists. */
export const SOCIAL_PLATFORM_LABEL: Record<SocialPlatformKind, string> = {
  facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', youtube: 'YouTube',
  tiktok: 'TikTok', zalo: 'Zalo', threads: 'Threads', website: 'Website', other: 'Khác',
};

/**
 * ADR-052. Restored from the prototype's own `Segment(["circle","square","text"])`
 * (`studio.tsx`) -- `circle`/`square` size the glyph into a bordered badge,
 * `text` drops the border and underlines instead. The three CSS shapes
 * (`.v3-p-social.circle/.square/.text`, `globals.css`) were already vendored
 * by ARCH-HANDOFF's byte-for-byte copy; nothing ever set the class that
 * selects between them until now.
 */
export const SOCIAL_STYLES = ['circle', 'square', 'text'] as const;
export type SocialStyle = (typeof SOCIAL_STYLES)[number];

export type SocialLink = {
  id: string;
  platform: SocialPlatformKind;
  url: string;
  label?: string;
  enabled: boolean;
};

/**
 * ADR-044. The prototype's sixteenth kind (`studio.tsx:27`), and the one that
 * never made it here. It went missing without a record -- the string "contact"
 * appears nowhere in docs/ -- and nothing could catch that, because the only
 * gate touching Mailcraft checks actions and states, not the block set.
 *
 * Five fields, matching the prototype's `ContactData` exactly. They are separate
 * fields rather than one free-text block because the emitter turns two of them
 * into `mailto:` and `tel:` links, which is what makes the block worth having
 * over a plain paragraph.
 */
export type ContactBlock = {
  name: string;
  role: string;
  email: string;
  phone: string;
  address: string;
};

/**
 * ADR-050. Audit backlog §4's other legal-required half, closed: CAN-SPAM
 * requires a physical postal address on commercial email, and until now
 * nothing in the model, the emitter or the publish gate said one word about
 * it (measured -- grepping the whole repo for "postal"/"address"/"CAN-SPAM"
 * outside the audit doc and ADR-049 itself found nothing).
 *
 * Two fields, not one free-text block, for the same reason `ContactBlock`
 * splits: `hasPostalAddress` (`publish-readiness.ts`) has to check the ONE
 * field the law actually requires, and it cannot do that reliably against a
 * blob of free text with the company name mixed in. `companyName` is not
 * legally required and the gate never reads it -- it exists because an
 * address with no name above it reads as a fragment, not a signature block.
 *
 * `address` may hold several lines (street / city, region, postal code /
 * country): `\n`-split, one line per segment, blank lines dropped -- the same
 * convention ADR-048 gave `list`'s `content`.
 */
export type FooterBlock = {
  companyName: string;
  address: string;
};

export type TableBlock = {
  header: boolean;
  zebra: boolean;
  caption: string;
  cells: string[][];
  headerBg: string;
  headerColor: string;
  rowBg: string;
  altBg: string;
  borderColor: string;
  cellPadding: number;
  align: Align;
};

export type Node = {
  id: string;
  kind: Kind;
  name?: string;
  children?: Node[];
  visible?: boolean;
  /**
   * ADR-044 (Task SV-3) -- the structure tree's per-row lock, restored from
   * the prototype (`studio.tsx`'s `Layers`/`Inspector`). UI-only: `emitDoc`
   * never reads it, so a locked node still ships in the email exactly as an
   * unlocked one would. It only gates the editor's own write paths
   * (`BuilderScreen`'s `removeSelected`/`moveSelected`/`updateSelectedField`
   * etc.), the same way `readOnly` does.
   */
  locked?: boolean;

  content?: string;
  /**
   * ADR-046: inline formatting for `text` and `heading`, as ranges over
   * `content` rather than markup inside it.
   *
   * `content` stays the ONLY place the author's words live, and stays plain
   * text -- which is what lets `insertTemplateVariable`, the preheader meter,
   * `content-review`, `publish-readiness` and the canvas variable chips go on
   * reading it without learning anything new.
   *
   * Absent or empty means "no formatting", and `emitText` then takes exactly
   * the path it took before this field existed. That is the migration
   * (ADR-046 decision 6): a document saved before today has no `inline`, so a
   * `<` in its `content` can never be reinterpreted as a tag. Detection is the
   * field's presence -- never sniffing `content` for markup.
   */
  inline?: InlineMark[];
  /**
   * ADR-048, for the `list` kind only: `true` emits `<ol>`, anything else
   * `<ul>`. Absent means an unordered list, which is what a new block gets.
   */
  ordered?: boolean;
  /**
   * ADR-048. The bullet or number style. `undefined` lets the client pick its
   * own default, which is `disc`/`decimal` everywhere that matters -- so an
   * untouched block still emits no declaration, the same byte-economy rule
   * `emitText` follows for `letter-spacing`.
   */
  listStyle?: ListStyle;
  align?: Align;

  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;

  background?: string;
  /**
   * ADR-042's other half, for Section and Column: the prototype's "Bề mặt nâng
   * cao" group (`studio.tsx`'s `SurfaceExtras`, class `v3-surface-presets`).
   * `ARCH-MAILCRAFT-DOM` had that control REJECTED on two grounds -- the model
   * had no fields, and "the properties it sets are stripped by the sanitizer".
   * The second stopped being true when ADR-042 was accepted; these five fields
   * settle the first.
   *
   * `elevation` is three values, not the prototype's four. `inset` is excluded
   * with an address rather than silently: ADR-042 §Consequences states that
   * `box-shadow:inset` is not supported and that supporting it would be a NEW
   * decision, because the `inset` keyword plus four tokens exceeds the 4-token
   * shorthand cap the allowlist enforces. The prototype's other three fit
   * inside it -- `0 8px 18px #c4d0ca` is exactly four.
   *
   * The gradient never replaces `background`; it layers over it. That is what
   * makes the prototype's own promise true -- "luôn xuất màu nền phẳng và viền
   * làm fallback" -- for the clients that drop `background-image`.
   */
  backgroundMode?: 'solid' | 'gradient';
  gradientTo?: string;
  gradientAngle?: number;
  elevation?: 'flat' | 'soft' | 'strong';
  shadowColor?: string;
  /**
   * COLUMN only: its share of `theme.width`, in percent -- `columnPixelWidth`
   * (`emitter.ts`) is the one function that turns this into the real pixel
   * cap both the `<div>` and the Outlook ghost `<td>` use. Independent per
   * column, not a partition: nothing sums siblings' widths and checks they
   * total 100 (measured, ADR-052 Context) -- `RowLayoutPicker`'s presets
   * always wrote a set that already did, so nothing needed to check until
   * ADR-052 opened a free-text override next to them.
   */
  width?: number;
  /**
   * ADR-037 §2's fluid-hybrid stacking, per ROW rather than per document.
   *
   * `EmailTheme.stackColumns` is the document-wide default and stays that;
   * this overrides it for one row, which is the shape the prototype has
   * (`studio.tsx`'s Row inspector, a "Xếp dọc trên mobile" toggle) and the
   * point at which an author actually wants the choice -- a header row of
   * three logos should not stack, while the article row beneath it must.
   *
   * The prototype reaches it with a `mc-stack` class plus a `@media` rule.
   * EOW cannot: ADR-037 §2 strips `@media`. What it does instead costs
   * nothing, because `emitColumn` already had the branch -- `width:100%`
   * shrinks and stacks, a fixed pixel width does not.
   *
   * Declared for two days with nothing reading it (audit backlog §1). It reads
   * now.
   */
  stackMobile?: boolean;

  href?: string;
  linkTitle?: string;
  src?: string;
  alt?: string;
  /**
   * MC-UI-005 `mark_decorative` (ADR-043 §8). The emitter turns this into
   * `alt=""` AND `role="presentation"` -- both halves, because an empty alt on
   * its own cannot be told apart from one somebody forgot. The written `alt` is
   * kept rather than erased, so unmarking gives the words back.
   */
  decorative?: boolean;
  caption?: string;
  /** Single-value corner radius (button/image/banner). Section/column use the four `radius*` corners below instead (S4 decision 4 -- ADR-038 lifted ADR-037 §1's one-value restriction for those two). */
  radius?: number;
  radiusTopLeft?: number;
  radiusTopRight?: number;
  radiusBottomRight?: number;
  radiusBottomLeft?: number;
  borderColor?: string;
  borderWidth?: number;

  headingLevel?: 1 | 2 | 3 | 4;
  fontSize?: number;
  lineHeight?: number;
  fontWeight?: number;
  fontFamily?: string;
  textColor?: string;
  accent?: string;
  /**
   * ADR-042 opened `letter-spacing` and `text-transform` in the sanitizer on
   * 2026-09-02 for exactly these two fields, and then nothing was built: the
   * model had no home for them, so the inspector had nothing to bind and its
   * doc comment went on claiming the sanitizer stripped them. This is that half
   * of ADR-042 finally landing.
   *
   * Shapes are the prototype's own (`studio.tsx`): a number of px for tracking
   * -- negative allowed, which is why ADR-042 gave the property a signed
   * grammar of its own -- and three keywords for case. The prototype has no
   * `capitalize` even though the sanitizer accepts it; ADR-044 makes the
   * prototype the source of visual truth, so the option set is its three.
   */
  letterSpacing?: number;
  textTransform?: 'none' | 'uppercase' | 'lowercase';

  buttonVariant?: 'solid' | 'outline' | 'soft' | 'link';
  buttonSize?: 'sm' | 'md' | 'lg';
  buttonWidth?: 'auto' | 'full';

  social?: SocialLink[];
  /** ADR-052, `social` only. `undefined` behaves as `circle`, matching the prototype's own default and the shape the CSS's un-suffixed `.v3-p-social a` rule already assumes (a bordered chip). */
  socialStyle?: SocialStyle;
  /** ADR-052, `social` only. `undefined` behaves as 32 (px), the prototype's own default (`studio.tsx`'s slider: 24-48, default 32). Ignored under `socialStyle: 'text'`, which sizes itself off `font-size` instead. */
  socialSize?: number;
  table?: TableBlock;
  contact?: ContactBlock;
  footer?: FooterBlock;
  height?: number;
  maxWidth?: number;
  /** `customHtml` only (MC-UI-011, S4 Task 20) -- raw sanitized HTML the author typed, emitted verbatim by `emitCustomHtml`. Safety is not this field's job: the whole document still passes through `sanitizeTemplateHtml` server-side before storage, same as every other block. */
  html?: string;
  /**
   * `customHtml` only (MC-UI-011, ADR-044 Task SV-5) -- the second tab of the
   * prototype's code panel (`v3-code-tabs`), emitted as a `<style>` block
   * ahead of `html`. Added rather than excused because, unlike the two
   * controls the DOM register rejects for editing fields EOW does not have,
   * this one reaches the recipient: the server sanitizer INLINES a `<style>`
   * block's declarations into `style=""` before dropping the tag, so what is
   * written here survives into the sent email. Scope is the whole document,
   * exactly as in the prototype -- CSS is global wherever the block sits.
   */
  css?: string;
};

export type EmailTheme = {
  width: 600 | 640 | 720;
  outerBg: string;
  contentBg: string;
  fontFamily: string;
  baseFontSize: number;
  /** MC-UI-007 `change_responsive_rules` (S4 Task 20). `true`/undefined (default) keeps every row's columns stacking fluid-hybrid style (`width:100%`, the only mobile technique available -- ADR-037 §2, `@media` is stripped). `false` forces a fixed pixel width instead, so columns stay side-by-side even in a narrow client -- for layouts (e.g. a small fixed logo beside a wordmark) that must never collapse. */
  stackColumns?: boolean;
};

export const defaultTheme: EmailTheme = { width: 640, outerBg: '#f3f1ed', contentBg: '#ffffff', fontFamily: 'Arial, Helvetica, sans-serif', baseFontSize: 14 };

export type Variable = {
  key: string;
  name: string;
  scope: 'system' | 'global' | 'recipient' | 'template';
  fallback: string;
  required: boolean;
};

export type Doc = {
  title: string;
  nodes: Node[];
  variables: Variable[];
  theme?: EmailTheme;
};

export type History = {
  past: Doc[];
  present: Doc;
  future: Doc[];
};
