import type { Node, SocialPlatformKind } from './document.js';
import { ROW_LAYOUT_PRESETS, type RowLayoutPreset } from './row-layouts.js';

/**
 * The block library -- all 14 kinds `document.ts`'s `KINDS` declares
 * (MC-UI-002, screen-catalog.yaml). An earlier version of the vertical-slice
 * plan cut this to 9 kinds as a "product decision"; that decision was not
 * anyone's to make and was reverted (plan §"Nguyên tắc chi phối phần còn
 * lại"). `logo`/`banner`/`table`/`social`/`preheader` (S4 Task 18) had
 * emitter support and tests since S2 -- only the library entry and inspector
 * were missing.
 *
 * Every `createNode` is a factory (not a constant) so each click produces a
 * fresh id -- and none defaults a link field to `"#"`, which `LINK_PLACEHOLDER`
 * (spec §2.8) would flag the instant the block landed on the canvas.
 *
 * MC-UI-002 actions (S4 Task 21 fidelity gate touch point): insert_section,
 * insert_row and insert_column are the three structural catalog entries
 * below; insert_element is every leaf kind, all routed through the same
 * `BuilderScreen.insertBlock` -> `engine.addBlock(kind, targetId)` call.
 */
export type LaunchBlockKind = 'section' | 'row' | 'column' | 'heading' | 'text' | 'list' | 'button' | 'image' | 'divider' | 'spacer' | 'logo' | 'banner' | 'table' | 'social' | 'contact' | 'footer' | 'preheader' | 'customHtml';

/**
 * ADR-052. Three, not all nine of `document.ts`'s `SOCIAL_PLATFORMS` --
 * pre-populating every known platform stopped scaling the moment the list
 * grew past five. These are the ones almost every business account already
 * has; `SocialLinksEditor`'s own "+ Thêm mạng xã hội" adds any other.
 */
const DEFAULT_SOCIAL_PLATFORMS: readonly SocialPlatformKind[] = ['facebook', 'instagram', 'website'];

/**
 * ADR-044 (Task SV-3). The prototype groups its Insert panel into five
 * sections (`studio.tsx`'s `blocks` array: content/media/action/layout/email)
 * with a count badge per section -- lost when the panel became a flat grid.
 * `row` and `column` have no prototype entry of their own (its six
 * `layoutSpecs` presets stand in for them there), but `blocks.ts`'s own doc
 * comment ties them to the `insert_row`/`insert_column` fidelity actions, so
 * they cannot be dropped; ADR-044 clause 2 ("additions are free") is why they
 * fold into `layout` rather than blocking the restoration on a model change.
 */
export type BlockGroup = 'content' | 'media' | 'action' | 'layout' | 'email';

export const BLOCK_GROUP_LABEL: Record<BlockGroup, string> = {
  content: 'Nội dung',
  media: 'Hình ảnh & thương hiệu',
  action: 'Hành động',
  layout: 'Khung bố cục',
  email: 'Chuyên biệt email',
};

export type BlockCatalogEntry = {
  kind: LaunchBlockKind;
  label: string;
  group: BlockGroup;
  createNode: () => Node;
};

/**
 * `studio.tsx`'s `newLeaf` base: `{padding: 14, align: "left", textColor:
 * "#30463d", accent: "#173f33", radius: 8}`. EOW created every block bare, so a
 * new email emitted `padding:0` everywhere and blocks sat flush against each
 * other and against the sheet.
 *
 * EOW's model has no `padding` shorthand -- `paddingCss` reads the four sides --
 * so the one number becomes four. Containers take their own value; see
 * `container`.
 */
const PAD = 14;
const LEAF_INK = { align: 'left', textColor: '#30463d', accent: '#173f33', radius: 8 } as const;

const pad = (value: number) => ({ paddingTop: value, paddingRight: value, paddingBottom: value, paddingLeft: value });

const base = (kind: LaunchBlockKind): Pick<Node, 'id' | 'kind' | 'visible'> => ({ id: crypto.randomUUID(), kind, visible: true });

/** A leaf as the handoff builds it. Containers do not take `LEAF_INK` -- ink and corners on a Section are the author's to set, and studio.tsx leaves them unset too. */
const leaf = (kind: LaunchBlockKind, padding = PAD) => ({ ...base(kind), ...pad(padding), ...LEAF_INK });

export const BLOCK_CATALOG: readonly BlockCatalogEntry[] = [
  { kind: 'text', label: 'Đoạn văn', group: 'content', createNode: () => ({ ...leaf('text'), content: 'Nhập nội dung của bạn tại đây.', fontSize: 14, lineHeight: 1.6, fontWeight: 400 }) },
  { kind: 'heading', label: 'Tiêu đề', group: 'content', createNode: () => ({ ...leaf('heading'), headingLevel: 2, content: 'Tiêu đề phần mới', fontSize: 28, lineHeight: 1.2, fontWeight: 700 }) },
  // ADR-048. `paddingLeft: 24` is the indent the marker needs -- client defaults
  // for it differ widely enough to be worth stating. Seeded with three items so
  // the "one line per item" convention is visible before it is explained.
  { kind: 'list', label: 'Danh sách', group: 'content', createNode: () => ({ ...leaf('list'), content: 'Mục thứ nhất\nMục thứ hai\nMục thứ ba', fontSize: 14, lineHeight: 1.6, paddingLeft: 24 }) },
  { kind: 'image', label: 'Hình ảnh', group: 'media', createNode: () => ({ ...leaf('image'), src: '', alt: '', maxWidth: 100 }) },
  { kind: 'banner', label: 'Banner', group: 'media', createNode: () => ({ ...leaf('banner'), src: '', alt: '', href: '' }) },
  // The handoff's own logo points at Altasoftware's asset -- seed data, not a default. Only its metrics are taken.
  { kind: 'logo', label: 'Logo', group: 'media', createNode: () => ({ ...leaf('logo'), src: '', alt: '', content: 'Logo', align: 'center', height: 36, href: '' }) },
  { kind: 'button', label: 'Nút bấm', group: 'action', createNode: () => ({ ...leaf('button'), content: 'Nút hành động', href: '', align: 'center', textColor: '#ffffff', buttonVariant: 'solid', buttonSize: 'md' }) },
  { kind: 'social', label: 'Mạng xã hội', group: 'action', createNode: () => ({ ...leaf('social'), align: 'center', socialStyle: 'circle', socialSize: 32, social: DEFAULT_SOCIAL_PLATFORMS.map((platform) => ({ id: crypto.randomUUID(), platform, url: '', label: '', enabled: true })) }) },
  { kind: 'section', label: 'Section trống', group: 'layout', createNode: () => ({ ...base('section'), background: '#ffffff', children: [] }) },
  { kind: 'row', label: 'Hàng (Row)', group: 'layout', createNode: () => ({ ...base('row'), children: [] }) },
  // studio.tsx's `newColumn`: 18px, its own number and larger than a leaf's.
  { kind: 'column', label: 'Cột (Column)', group: 'layout', createNode: () => ({ ...base('column'), ...pad(18), width: 100, children: [] }) },
  {
    kind: 'table', label: 'Bảng dữ liệu', group: 'layout', createNode: () => ({
      ...leaf('table'),
      table: { header: true, zebra: false, caption: '', cells: [['', ''], ['', '']], headerBg: '#173f33', headerColor: '#ffffff', rowBg: '#ffffff', altBg: '#f2f6f4', borderColor: '#dbe5e0', cellPadding: 8, align: 'left' },
    }),
  },
  { kind: 'divider', label: 'Đường ngăn', group: 'layout', createNode: () => ({ ...leaf('divider', 12), height: 1, accent: '#dbe5e0' }) },
  { kind: 'spacer', label: 'Khoảng cách', group: 'layout', createNode: () => ({ ...leaf('spacer', 0), height: 32 }) },
  // ADR-044: restored. The prototype's own default fills the name and role so a
  // freshly inserted block shows what it is for; the reachable fields start empty
  // because a placeholder email address is worse than a blank one -- LINK_PLACEHOLDER
  // exists precisely because sample addresses ship to real recipients.
  { kind: 'contact', label: 'Liên hệ', group: 'email', createNode: () => ({ ...leaf('contact'), align: 'center', fontSize: 12, lineHeight: 1.6, contact: { name: 'Phòng Nhân sự', role: '', email: '', phone: '', address: '' } }) },
  // ADR-050. `companyName`/`address` start empty for the same reason `contact`'s
  // reachable fields do (LINK_PLACEHOLDER exists because sample data ships to
  // real recipients) -- an invented address is worse than a blank one, and
  // `hasPostalAddress` (publish-readiness.ts) will not let a blank one publish.
  { kind: 'footer', label: 'Chân thư', group: 'email', createNode: () => ({ ...leaf('footer'), align: 'center', fontSize: 12, lineHeight: 1.6, footer: { companyName: '', address: '' } }) },
  { kind: 'preheader', label: 'Preheader', group: 'email', createNode: () => ({ ...leaf('preheader'), content: '', fontSize: 11 }) },
  { kind: 'customHtml', label: 'HTML/CSS tùy chỉnh', group: 'email', createNode: () => ({ ...leaf('customHtml'), html: '' }) },
];

/**
 * The Insert panel, in the prototype's own order.
 *
 * `BLOCK_CATALOG` above is the MODEL's catalog: exactly one entry per kind in
 * `document.ts`'s `KINDS`, which is what `ARCH-MAILCRAFT-FIDELITY` checks and
 * what keeps `insert_section`/`insert_row`/`insert_column` satisfiable. It is
 * not the panel. `studio.tsx` builds its panel as
 * `[...block kinds, ...Object.entries(layoutSpecs)]` -- so six of its buttons
 * are LAYOUTS, not kinds: pick "Hai cột đều" and a Row arrives with its two
 * columns already in it. A Row is never inserted bare there, and neither is a
 * Column.
 *
 * EOW shipped none of the six and invented two buttons in their place, "Hàng
 * (Row)" and "Cột (Column)". The six are restored here from
 * `ROW_LAYOUT_PRESETS` rather than retyped, so the panel and the Inspector's
 * ratio tiles cannot drift apart -- they are the same six shapes, offered at
 * two moments.
 *
 * The two invented buttons are gone, and the three Inspector buttons the
 * prototype composes structure with are in: "＋ Thêm hàng 2 cột" on a Section,
 * "＋ Thêm một cột" on a Row, "＋ Thêm layout 2 cột bên trong" on a Column. Row
 * and Column keep their `BLOCK_CATALOG` entries -- `MC-UI-002` declares
 * `insert_row` and `insert_column`, and `ARCH-MAILCRAFT-FIDELITY` checks the
 * catalog, not the panel.
 */
export type InsertPanelItem = {
  /** Distinct from `kind`: all six presets insert a `row`, so the kind cannot address them. */
  id: string;
  kind: LaunchBlockKind;
  label: string;
  icon: string;
  group: BlockGroup;
  /** Set only on a layout preset. `studio.tsx` shows it as the button's sub-label ("35 / 65"). */
  widths?: readonly number[];
  createNode: () => Node;
};

/** studio.tsx's `blocks` icons, by kind. The presets bring their own from `ROW_LAYOUT_PRESETS`. */
const KIND_ICON: Record<LaunchBlockKind, string> = {
  text: 'T', heading: 'H', list: '☰', image: '▧', banner: '▰', logo: 'A', button: '↗', social: '◎',
  section: '▱', row: '▬', column: '❘', table: '▤', divider: '—', spacer: '↕',
  contact: '@', footer: '⎯', preheader: 'P', customHtml: '</>',
};

const catalogItem = (kind: LaunchBlockKind): InsertPanelItem => {
  const entry = BLOCK_CATALOG.find((candidate) => candidate.kind === kind)!;
  return { id: entry.kind, kind: entry.kind, label: entry.label, icon: KIND_ICON[kind], group: entry.group, createNode: entry.createNode };
};

/** `newLayout` -> `newRow(spec.widths.length, spec.widths)`: a Row whose columns already carry the preset's widths. */
const layoutItem = (preset: RowLayoutPreset): InsertPanelItem => ({
  id: preset.id,
  kind: 'row',
  label: preset.label,
  icon: preset.icon,
  group: 'layout',
  widths: preset.widths,
  createNode: () => ({
    ...base('row'),
    children: preset.widths.map((width) => ({ ...base('column'), width, children: [] })),
  }),
});

export const INSERT_PANEL: readonly InsertPanelItem[] = [
  catalogItem('text'), catalogItem('heading'), catalogItem('list'),
  catalogItem('image'), catalogItem('banner'), catalogItem('logo'),
  catalogItem('button'), catalogItem('social'),
  catalogItem('section'),
  ...ROW_LAYOUT_PRESETS.map(layoutItem),
  catalogItem('table'), catalogItem('divider'), catalogItem('spacer'),
  catalogItem('contact'), catalogItem('footer'), catalogItem('preheader'), catalogItem('customHtml'),
];
