import { IMAGE_BEARING_KINDS, type Kind, type Node } from './document.js';

/**
 * Node/theme -> the inspector's field list (S4 Task 18). Pure and data-only
 * (spec §2.1: web has no component-render tests) so `BuilderScreen.tsx` can
 * render a generic field for each entry rather than switching on kind itself.
 *
 * A control here must produce something the recipient can see; the sanitizer
 * decides what that is. `opacity` and the un-allowlisted shapes are still
 * absent for that reason, and `inspector-fields.test.ts` locks it.
 *
 * ADR-042's four -- `letterSpacing`, `textTransform`, `boxShadow`,
 * `backgroundImage` -- are NOT among them any more. They were built on
 * 2026-09-10: the two typography ones are in `textLikeFields` below, the two
 * surface ones are `SurfacePicker`'s in BuilderScreen.
 *
 * Worth keeping the history, because the shape of the failure is reusable. The
 * allowlist opened on 2026-09-02 and nothing was built for eight days, while
 * FOUR places went on asserting the opposite: this comment, the
 * `ARCH-MAILCRAFT-DOM` entry rejecting `v3-surface-presets`, the plan's own
 * status table, and -- worst -- a green test named "never generates a field for
 * a property the sanitizer strips" that listed all four. Three of those merely
 * described the gap. The test HELD it: building the controls required deleting
 * the guard that forbade them.
 *
 * So a stale reason is not just documentation drift. Encoded in a passing test
 * it becomes a rule, and nothing in the suite can tell the difference between a
 * rule that protects something and one whose reason expired.
 *
 * ADR-046 (2026-09-11) is the third round of the same lesson, applied on the
 * way IN rather than eight days late. Text and heading blocks are no longer
 * plain text: `content` still holds the words, and `Node.inline` holds ranges
 * that `emitter.ts` turns into `<strong>`/`<em>`/`<u>`/`<a href>`. There is no
 * field for it HERE on purpose -- formatting is a selection command, not a
 * property, so it is `InlineFormatToolbar` above the `content` textarea in
 * `BuilderScreen`, the same way the four ADR-042 surface controls are
 * `SurfacePicker` rather than rows in this list. Nothing in this file claims
 * text blocks carry only plain text, and nothing may start to.
 */
export type InspectorFieldType = 'text' | 'textarea' | 'number' | 'url' | 'color' | 'select' | 'align' | 'checkbox';

/**
 * ADR-044 Task SV-2: the prototype's inspector is three tabs (`v3-tabs`),
 * EOW's was one flat list. The split is data on the field rather than a
 * `key.startsWith` guess in the JSX, for the same reason `type` is -- a
 * renderer that has to infer meaning from a key name gets it wrong the first
 * time someone adds a key.
 *
 * `content` is what the block SAYS (text, destination, image source and its
 * description), `design` is how it LOOKS (typography, colour, spacing,
 * borders), `advanced` is what a reader never sees directly: the decorative
 * flag, the custom-HTML source, responsive rules.
 */
export type InspectorTab = 'content' | 'design' | 'advanced';

export type InspectorField = {
  key: string;
  label: string;
  type: InspectorFieldType;
  options?: ReadonlyArray<{ value: string; label: string }>;
  tab: InspectorTab;
  /** `select`/`number` fields whose stored value is a number, not a string (`width`, `headingLevel`, `fontWeight`) -- lets the generic field renderer know to coerce rather than string-compare every select by key name. */
  numeric?: boolean;
  /**
   * What a `checkbox` shows before the field has ever been written.
   *
   * Explicit per field, because the two that exist want opposite answers and
   * the renderer cannot guess: an unset `stackMobile` means "stack" (true,
   * the behaviour every document had before the field existed), while an unset
   * `ordered` means a bulleted list (false).
   *
   * It used to be hardcoded to `true`, justified by a comment about
   * `theme.stackColumns` -- a field that has its own toggle in the theme sheet
   * and never passes through this renderer at all. `ordered` inherited that
   * default and shipped inverted: a new list rendered as already-checked, and
   * clicking the box wrote `false`, so the control did nothing visible. Found
   * by clicking it in the running app; every unit test was green.
   */
  defaultOn?: boolean;
};

const ALIGN_OPTIONS = [{ value: 'left', label: 'Trái' }, { value: 'center', label: 'Giữa' }, { value: 'right', label: 'Phải' }];

/**
 * The four padding sides, shared by every kind whose emitter actually writes
 * them. Text and Heading joined that set on 2026-09-10 -- until then
 * `blocks.ts` put 14px on each new text block, `canvas-style.ts` drew it, and
 * `emitText` silently dropped it, so the number was visible, unreachable and
 * absent from the mail all at once.
 */
const paddingFields = (): InspectorField[] => [
  { key: 'paddingTop', label: 'Đệm trên', type: 'number', tab: 'design' },
  { key: 'paddingRight', label: 'Đệm phải', type: 'number', tab: 'design' },
  { key: 'paddingBottom', label: 'Đệm dưới', type: 'number', tab: 'design' },
  { key: 'paddingLeft', label: 'Đệm trái', type: 'number', tab: 'design' },
];
const align = (key = 'align', label = 'Căn lề'): InspectorField => ({ key, label, type: 'align', tab: 'design', options: ALIGN_OPTIONS });

/**
 * Shared by Section and Column (spec Task 18 table combines the two rows):
 * padding, background, border, and the 4-corner radius decision 4 allows for
 * these two kinds only.
 *
 * `backgroundMode`/`gradientTo`/`gradientAngle`/`elevation`/`shadowColor` are
 * deliberately NOT here. They are the prototype's "Bề mặt nâng cao" group and
 * it draws them as a Segment, a slider and the `v3-surface-presets` tiles with
 * a caption underneath -- so they get `SurfacePicker` in BuilderScreen, for the
 * same reason `buttonVariant` does. A generic select for `elevation` would show
 * the shapes as words.
 */
function containerFields(): InspectorField[] {
  return [
    ...paddingFields(),
    { key: 'background', label: 'Nền', type: 'color', tab: 'design' },
    { key: 'borderColor', label: 'Màu viền', type: 'color', tab: 'design' },
    { key: 'borderWidth', label: 'Độ dày viền', type: 'number', tab: 'design' },
    { key: 'radiusTopLeft', label: 'Bo góc trên-trái', type: 'number', tab: 'design' },
    { key: 'radiusTopRight', label: 'Bo góc trên-phải', type: 'number', tab: 'design' },
    { key: 'radiusBottomRight', label: 'Bo góc dưới-phải', type: 'number', tab: 'design' },
    { key: 'radiusBottomLeft', label: 'Bo góc dưới-trái', type: 'number', tab: 'design' },
  ];
}

function textLikeFields(includeHeadingLevel: boolean): InspectorField[] {
  return [
    { key: 'content', label: 'Nội dung', type: 'textarea', tab: 'content' },
    ...(includeHeadingLevel ? [{ key: 'headingLevel', label: 'Cấp', type: 'select' as const, tab: 'content' as const, numeric: true, options: [1, 2, 3, 4].map((level) => ({ value: String(level), label: `H${level}` })) }] : []),
    { key: 'fontSize', label: 'Cỡ chữ', type: 'number', tab: 'design' },
    { key: 'fontWeight', label: 'Độ đậm', type: 'select', tab: 'design', numeric: true, options: [{ value: '400', label: 'Thường' }, { value: '700', label: 'Đậm' }] },
    { key: 'lineHeight', label: 'Giãn dòng', type: 'number', tab: 'design' },
    align(),
    { key: 'textColor', label: 'Màu chữ', type: 'color', tab: 'design' },
    { key: 'fontFamily', label: 'Phông chữ', type: 'text', tab: 'design' },
    ...paddingFields(),
    // ADR-042, built 2026-09-10. The two typography halves of that ADR; the two
    // surface halves are Section/Column's and get the prototype's own tile
    // picker instead (`SurfacePicker` in BuilderScreen), the same way
    // `buttonVariant` does.
    { key: 'letterSpacing', label: 'Giãn chữ (px)', type: 'number', tab: 'design' },
    {
      key: 'textTransform', label: 'Kiểu chữ hoa/thường', type: 'select', tab: 'design',
      // studio.tsx offers exactly these three. The sanitizer also accepts
      // `capitalize`, but ADR-044 makes the prototype the source of visual
      // truth -- a fourth option here would be inventing one.
      options: [{ value: 'none', label: 'Giữ nguyên' }, { value: 'uppercase', label: 'IN HOA' }, { value: 'lowercase', label: 'in thường' }],
    },
  ];
}

const FIELD_BUILDERS: Partial<Record<Kind, () => InspectorField[]>> = {
  section: containerFields,
  /**
   * ADR-052. `width` is COLUMN-only (`document.ts`'s own doc comment on the
   * field), so it cannot live in `containerFields` -- Section has no use for
   * it and would show a control that changes nothing, the exact ADR-042
   * lesson this file's own top comment holds up. `RowLayoutPicker`'s presets
   * remain the fast path for a whole row; this is the free-text override
   * the audit backlog asked for (a 30/70 split, a 20/60/20 three-column row)
   * on ONE column at a time.
   */
  column: () => [{ key: 'width', label: 'Tỉ lệ cột (%)', type: 'number', tab: 'design' }, ...containerFields()],
  /**
   * The row's only field, and the reason it has one at all: `stackMobile` was
   * declared on `Node` with nothing reading it (audit backlog §1).
   *
   * On "Nâng cao" because it is a responsive rule rather than content or
   * appearance -- the same tab, and the same MC-UI-007 action, as the
   * document-wide `stackColumns` it overrides. The ratio picker stays on
   * "Nội dung" as its own `RowLayoutPicker`.
   */
  row: () => [{ key: 'stackMobile', label: 'Xếp dọc trên màn hình hẹp', type: 'checkbox', tab: 'advanced', defaultOn: true }],
  heading: () => textLikeFields(true),
  text: () => textLikeFields(false),
  /**
   * ADR-048. Reuses the `content` textarea rather than adding a per-item
   * editor: an item is a line, so the field an author already knows is the
   * field they need. `BuilderScreen` prints the convention under it -- ADR-048
   * §Consequences makes saying it part of the build, because a convention
   * nobody states is a trap.
   *
   * `listStyle` is the one marker route that survives the sanitizer. The other
   * four (`list-style` shorthand, `list-style-position`, `<ol type>`,
   * `<ol start>`) were measured stripped, so offering them would be four
   * controls producing nothing.
   */
  list: () => [
    { key: 'content', label: 'Các mục', type: 'textarea', tab: 'content' },
    { key: 'ordered', label: 'Đánh số thứ tự', type: 'checkbox', tab: 'content' },
    {
      key: 'listStyle', label: 'Ký hiệu đầu dòng', type: 'select', tab: 'design',
      options: [
        { value: 'disc', label: '● Chấm tròn' },
        { value: 'circle', label: '○ Vòng tròn' },
        { value: 'square', label: '■ Vuông' },
        { value: 'decimal', label: '1. Số' },
        { value: 'lower-alpha', label: 'a. Chữ thường' },
        { value: 'upper-alpha', label: 'A. Chữ hoa' },
        { value: 'lower-roman', label: 'i. La Mã thường' },
        { value: 'upper-roman', label: 'I. La Mã hoa' },
        { value: 'none', label: 'Không có' },
      ],
    },
    { key: 'fontSize', label: 'Cỡ chữ', type: 'number', tab: 'design' },
    { key: 'lineHeight', label: 'Giãn dòng', type: 'number', tab: 'design' },
    align(),
    { key: 'textColor', label: 'Màu chữ', type: 'color', tab: 'design' },
    { key: 'fontFamily', label: 'Phông chữ', type: 'text', tab: 'design' },
    ...paddingFields(),
  ],
  // buttonVariant/radius: ADR-044 (Task SV-3) restores these as the prototype's
  // own `v3-presets`/`v3-shapes` tile pickers (BuilderScreen's `ButtonStylePicker`)
  // rather than a generic select/number -- so they are deliberately absent here.
  button: () => [
    { key: 'content', label: 'Nhãn', type: 'text', tab: 'content' },
    { key: 'href', label: 'Đường dẫn (URL)', type: 'url', tab: 'content' },
    align(),
    { key: 'paddingTop', label: 'Khoảng cách trên', type: 'number', tab: 'design' },
    { key: 'accent', label: 'Màu nền', type: 'color', tab: 'design' },
    { key: 'textColor', label: 'Màu chữ', type: 'color', tab: 'design' },
    { key: 'buttonSize', label: 'Cỡ', type: 'select', tab: 'design', options: [{ value: 'sm', label: 'Nhỏ' }, { value: 'md', label: 'Vừa' }, { value: 'lg', label: 'Lớn' }] },
    // Both were already emitted and had no control: `emitButton` reads
    // `buttonWidth` to choose `width="100%"` over `auto`, and writes
    // `linkTitle` as the anchor's `title`. A full-width button is table stakes
    // on a phone, and the code for it had been shipping unreachable.
    { key: 'buttonWidth', label: 'Chiều rộng', type: 'select', tab: 'design', options: [{ value: 'auto', label: 'Vừa nội dung' }, { value: 'full', label: 'Toàn chiều ngang' }] },
    { key: 'linkTitle', label: 'Chú thích liên kết (title)', type: 'text', tab: 'content' },
  ],
  image: () => [
    { key: 'src', label: 'URL ảnh (https)', type: 'url', tab: 'content' },
    { key: 'alt', label: 'Mô tả ảnh (alt)', type: 'text', tab: 'content' },
    { key: 'maxWidth', label: 'Rộng (%)', type: 'number', tab: 'design' },
    align(),
    { key: 'href', label: 'Liên kết khi bấm vào ảnh', type: 'url', tab: 'content' },
    { key: 'radius', label: 'Bo góc', type: 'number', tab: 'design' },
    // `emitImage` has always rendered this as a `<p>` under the picture; nothing could set it.
    { key: 'caption', label: 'Chú thích ảnh', type: 'text', tab: 'content' },
  ],
  divider: () => [
    { key: 'height', label: 'Độ dày', type: 'number', tab: 'design' },
    { key: 'accent', label: 'Màu', type: 'color', tab: 'design' },
    { key: 'paddingTop', label: 'Khoảng cách trên', type: 'number', tab: 'design' },
    { key: 'paddingBottom', label: 'Khoảng cách dưới', type: 'number', tab: 'design' },
  ],
  spacer: () => [{ key: 'height', label: 'Chiều cao', type: 'number', tab: 'design' }],
  logo: () => [
    { key: 'src', label: 'URL ảnh (https)', type: 'url', tab: 'content' },
    { key: 'alt', label: 'Mô tả ảnh (alt)', type: 'text', tab: 'content' },
    { key: 'content', label: 'Chữ thay thế (khi chưa có ảnh)', type: 'text', tab: 'content' },
    { key: 'height', label: 'Chiều cao (px)', type: 'number', tab: 'design' },
    align(),
    { key: 'href', label: 'Liên kết khi bấm vào logo', type: 'url', tab: 'content' },
    { key: 'accent', label: 'Màu chữ thay thế', type: 'color', tab: 'design' },
  ],
  // No maxWidth: emitBanner always renders width:100% (a banner spans its column), unlike image.
  banner: () => [
    { key: 'src', label: 'URL ảnh (https)', type: 'url', tab: 'content' },
    { key: 'alt', label: 'Mô tả ảnh (alt)', type: 'text', tab: 'content' },
    { key: 'href', label: 'Liên kết khi bấm vào banner', type: 'url', tab: 'content' },
    { key: 'radius', label: 'Bo góc', type: 'number', tab: 'design' },
  ],
  // The `social` array itself is edited by a bespoke list in BuilderScreen (one row per
  // SocialLink), not a generic field -- InspectorField has no shape for "array of objects".
  // `socialStyle`/`socialSize` (ADR-052, restored from the prototype's own
  // Segment + slider) ARE scalar keys on the node, so they belong here rather
  // than in that bespoke list.
  social: () => [
    align(),
    { key: 'socialStyle', label: 'Hình dạng', type: 'select', tab: 'design', options: [{ value: 'circle', label: 'Tròn' }, { value: 'square', label: 'Vuông' }, { value: 'text', label: 'Chỉ chữ' }] },
    { key: 'socialSize', label: 'Kích thước (px)', type: 'number', tab: 'design' },
    { key: 'accent', label: 'Màu biểu tượng', type: 'color', tab: 'design' },
  ],
  // ADR-044. Five text fields, one per prototype `ContactData` member. Kept as
  // separate fields rather than one textarea because two of them become
  // `mailto:`/`tel:` links in the emitted HTML -- merging them would turn a
  // tappable contact block back into a paragraph.
  // The five ContactData members are edited by a bespoke component in
  // BuilderScreen, for the reason stated above `social`: this file keeps to
  // scalar keys read straight off the node, and `contact` is a nested object.
  contact: () => [align(), { key: 'textColor', label: 'Màu chữ', type: 'color', tab: 'design' }],
  // ADR-050. Same split as `contact` above, and for the same reason:
  // `companyName`/`address` live on the nested `footer` object, which this
  // file's scalar-key renderer has no shape for -- `FooterEditor` in
  // BuilderScreen edits them.
  footer: () => [align(), { key: 'textColor', label: 'Màu chữ', type: 'color', tab: 'design' }, { key: 'fontSize', label: 'Cỡ chữ', type: 'number', tab: 'design' }],
  // Entirely bespoke in BuilderScreen: settings (header/zebra/caption/colors/padding/align)
  // and the cell grid all live on the nested `node.table` object, which the generic
  // key-on-node field renderer has no way to address.
  table: () => [],
  preheader: () => [{ key: 'content', label: 'Nội dung xem trước (preview text)', type: 'textarea', tab: 'content' }],
  // The CodeMirror editor + validate/preview controls are bespoke in BuilderScreen (reusing
  // TemplateCodeView) -- no InspectorFieldType shape fits "sanitized-HTML code editor".
  customHtml: () => [],
};

/** Field list for one node, driven only by its `kind`. Row has none -- nothing set on it survives to HTML (`emitRow` reads only `children`). */
export function inspectorFieldsForNode(node: Node): InspectorField[] {
  return FIELD_BUILDERS[node.kind]?.() ?? [];
}

/**
 * The Document row of Task 18's table used to live here as
 * `inspectorFieldsForDocument`, six generic fields the inspector rendered when
 * nothing was selected. ADR-044 Task SV-2 (decision 2) moved MC-UI-007 into the
 * prototype's own theme sheet, where each setting gets the widget the prototype
 * gives it -- a Segment for the three widths, a 12..18 slider for the base
 * size, a four-option select for the font. `theme-sheet.ts` holds those values
 * and `ARCH-MAILCRAFT-FIDELITY` checks THEM, because a list nothing renders is
 * not a control: a gate over it would pass while the screen showed nothing,
 * which is the exact shape of failure ADR-044 exists to stop.
 *
 * MC-UI-007's action mapping, kept here because this is where it was written:
 * change_width is `width`, change_typography is `fontFamily`/`baseFontSize`,
 * change_surface is `outerBg`/`contentBg`, change_responsive_rules is
 * `stackColumns` -- see its doc comment on `EmailTheme` for what it changes in
 * the emitted HTML.
 */

/**
 * `IMAGE_ALT_MISSING` (spec §2.8) surfaced client-side as soon as the field
 * goes empty, without waiting on a lint round-trip.
 *
 * A decorative image is exempt (S6 Task 39, ADR-043 §8): its alt is empty on
 * purpose, and the emitter says so with `role="presentation"`. Warning there
 * would be telling someone to undo the thing they just deliberately did -- and
 * it would disagree with the server lint, which Task 40 teaches the same rule.
 *
 * `IMAGE_BEARING_KINDS`, not `kind === 'image'`. Measured 2026-09-10 and fixed
 * 2026-09-11: this used to check the `image` kind alone, while the server lint
 * scans EVERY `<img>` in the emitted HTML -- so a `banner` or a `logo` with no
 * alt drew no warning beside the field, then failed the lint on the way out.
 * The same defect, reported or not depending on which door the author came
 * through, which is worse than either behaviour on its own.
 *
 * The list is the one in `document.ts` rather than a second copy, for the
 * reason that file gives: three places need the same answer to "does this kind
 * reach an `<img>`", and copies of it would each be wrong differently.
 */
export function imageAltMissing(node: Node): boolean {
  return (IMAGE_BEARING_KINDS as readonly Node['kind'][]).includes(node.kind) && !node.decorative && !node.alt?.trim();
}
