/**
 * Pure data behind the tool rail and the shared workspace-panel shell (S4
 * Task 17, `ui/UI-HANDOFF.md` §2). Kept out of `BuilderScreen.tsx` for the
 * same reason every other builder module is a plain function -- web has no
 * component-render test (spec §2.1), so the only part of this that can be
 * unit-tested is the data, not the JSX built from it.
 *
 * ADR-044 Task SV-2 widened the rail from four destinations to the
 * prototype's ten. `ui/UI-HANDOFF.md` §2 wrote four; `studio.tsx` renders ten;
 * ADR-044 clause 3 says the prototype code wins when the two disagree, and the
 * SV plan's decision 1 settled it explicitly.
 *
 * The six new destinations all reach something EOW already has, which is the
 * whole point of decision 1 -- a rail entry that grows a second copy of a
 * feature is the drift ADR-044 exists to stop. `kind` is how that rule is
 * stated in data rather than in a comment: `navigate` leaves the builder for
 * the screen that owns the feature, `sheet` opens the prototype's own overlay,
 * `panel` fills the left workspace panel.
 */

/**
 * The rail's nine destinations, in the order `studio.tsx`'s own `v3-rail`
 * renders them. Every one must render -- an unbuilt destination shows an
 * explained `empty` state (Task 17), it is never removed from the rail.
 *
 * Nine, not the prototype's ten: "Nhập HTML" was removed on 2026-09-10, and it
 * is the one exception this comment now carries rather than hides. It never
 * opened anything. Importing INTO the builder is forbidden -- an imported
 * template is HTML with no component tree (ADR-037) -- so the button navigated
 * OUT of the builder to TemplatesScreen's overlay. A rail is where panels open;
 * a rail entry that ejects the user mid-edit is a false promise, and the
 * capability is not lost: Import HTML sits beside "Soạn bằng Mailcraft" in the
 * template library, which is the level it belongs to. Recorded in
 * docs/superpowers/specs/2026-09-10-mailcraft-brand-and-entry-design.md §3.
 *
 * This is the only removal. The rule above stands for the other nine.
 */
export type RailDestination =
  | 'templates' | 'insert' | 'reusable' | 'structure'
  | 'theme' | 'variables' | 'assets' | 'review' | 'history';

/**
 * Where a rail button leads. See the file comment: this encodes decision 1.
 * `navigate` went with "Nhập HTML" -- it existed for that one entry, and a kind
 * no destination uses would be an invitation to add another one that leaves.
 */
export type RailKind = 'panel' | 'sheet';

export type RailEntry = {
  id: RailDestination;
  label: string;
  kind: RailKind;
  /** `nav` is the prototype's first `<nav>`, `foot` its second -- History sits alone at the bottom of the rail. */
  group: 'nav' | 'foot';
  /** Renders `v3-rail-separator` after this entry, as the prototype does under "Kho mẫu". */
  separatorAfter?: true;
};

export const RAIL_DESTINATIONS: ReadonlyArray<RailEntry> = [
  { id: 'templates', label: 'Kho mẫu', kind: 'panel', group: 'nav', separatorAfter: true },
  // The four original labels are load-bearing: six e2e specs select rail
  // buttons by their text. ADR-044 ports DOM and class names, not wording.
  { id: 'insert', label: 'Chèn khối', kind: 'panel', group: 'nav' },
  { id: 'reusable', label: 'Khối dùng lại', kind: 'panel', group: 'nav' },
  { id: 'structure', label: 'Cấu trúc', kind: 'panel', group: 'nav' },
  { id: 'theme', label: 'Chủ đề', kind: 'sheet', group: 'nav' },
  { id: 'variables', label: 'Biến', kind: 'panel', group: 'nav' },
  { id: 'assets', label: 'Thư viện ảnh', kind: 'panel', group: 'nav' },
  { id: 'review', label: 'Soát lỗi', kind: 'panel', group: 'nav' },
  { id: 'history', label: 'Lịch sử', kind: 'sheet', group: 'foot' },
];

/** The subset the left panel can actually render, so `railPanel` can never be handed a sheet. */
export const RAIL_PANEL_IDS = RAIL_DESTINATIONS.filter((entry) => entry.kind === 'panel').map((entry) => entry.id);

export type RailPanelId = Extract<RailDestination, 'templates' | 'insert' | 'reusable' | 'structure' | 'variables' | 'assets' | 'review'>;

export function railDestination(id: string): RailEntry | undefined {
  return RAIL_DESTINATIONS.find((entry) => entry.id === id);
}

/** Every tool panel and the inspector share one compact/expanded toggle (UI-HANDOFF §2). */
export type PanelSize = 'compact' | 'expanded';

/** Workspace panel: 320px compact, expandable to 480px. */
export const WORKSPACE_PANEL_WIDTH: Record<PanelSize, number> = { compact: 320, expanded: 480 };
/** Inspector: 336px compact, expandable to 480px -- a different compact width than the workspace panel, so the two need separate lookups rather than one shared constant. */
export const INSPECTOR_PANEL_WIDTH: Record<PanelSize, number> = { compact: 336, expanded: 480 };

export const otherPanelSize = (size: PanelSize): PanelSize => (size === 'compact' ? 'expanded' : 'compact');
