import type { Doc, Kind, Node } from './document.js';

/**
 * Pure logic behind MC-UI-003 (Structure workspace, Task 19). Web has no
 * component-render test (spec §2.1), so every branch a keyboard press or a
 * click can take lives here as a plain function; `BuilderScreen.tsx` only
 * renders `visibleTreeRows`' output and calls these on key/click events.
 *
 * Expansion state is caller-owned (a `Set<string>` of expanded node ids) --
 * these functions never mutate it, they return the next set.
 *
 * MC-UI-003 actions (S4 Task 21 fidelity gate touch point): select_node is
 * `BuilderScreen`'s `setSelectedId`; expand_node/collapse_node is
 * `toggleExpanded` below (and `rightKeyResult`/`leftKeyResult`'s own
 * expand/collapse branches); expand_all/collapse_all are `expandAllIds`/
 * `collapseAllIds`.
 */

/**
 * `visible`/`locked` default the same way `Node`'s own fields do (undefined
 * reads as visible and unlocked) -- so the row's toggle button and the CSS
 * class it drives (Task SV-3) never have to repeat that default logic.
 */
export type TreeRow = { id: string; kind: Kind; depth: number; parentId: string | null; hasChildren: boolean; visible: boolean; locked: boolean;
  /**
   * The author's own name for this node, when they have given it one.
   *
   * `Node.name` was declared and read by nothing (audit backlog §1) while the
   * tree labelled every row by kind, so a document with nine "Cột" rows offered
   * nine identical labels. The prototype has always had the other half --
   * `nodeName(n, l)` returns `n.name || <default for the kind>` -- and this
   * carries it into the row so the renderer does not have to reach back into
   * the document for one string.
   */
  name?: string };

/** Depth-first, document order -- a container's children only appear if its id is in `expandedIds`. Root nodes are always visible regardless of expansion state. */
export function visibleTreeRows(doc: Doc, expandedIds: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (nodes: readonly Node[], depth: number, parentId: string | null): void => {
    for (const node of nodes) {
      const hasChildren = Boolean(node.children && node.children.length > 0);
      rows.push({ id: node.id, kind: node.kind, depth, parentId, hasChildren, visible: node.visible !== false, locked: Boolean(node.locked), ...(node.name?.trim() ? { name: node.name.trim() } : {}) });
      if (hasChildren && expandedIds.has(node.id)) walk(node.children!, depth + 1, node.id);
    }
  };
  walk(doc.nodes, 0, null);
  return rows;
}

export function toggleExpanded(expandedIds: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expandedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** `expand_all` (screen-catalog.yaml MC-UI-003) -- every container, walked regardless of current expansion, so this is idempotent and total. */
export function expandAllIds(doc: Doc): Set<string> {
  const ids = new Set<string>();
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        ids.add(node.id);
        walk(node.children);
      }
    }
  };
  walk(doc.nodes);
  return ids;
}

/** `collapse_all` -- always the empty set; root nodes stay visible regardless (`visibleTreeRows` never hides a root). */
export function collapseAllIds(): Set<string> {
  return new Set();
}

/** ArrowDown/ArrowUp: move focus to the next/previous visible row, clamped at the ends. `currentId: null` (nothing focused yet) starts at the first row. */
export function moveFocus(rows: readonly TreeRow[], currentId: string | null, direction: 'down' | 'up'): string | null {
  if (rows.length === 0) return null;
  if (currentId === null) return rows[0]!.id;
  const index = rows.findIndex((row) => row.id === currentId);
  if (index === -1) return rows[0]!.id;
  const nextIndex = direction === 'down' ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0);
  return rows[nextIndex]!.id;
}

type KeyResult = { expandedIds: Set<string>; focusId: string };

/**
 * ArrowRight (WAI-ARIA treeview pattern): a collapsed container expands and
 * keeps focus; an already-expanded one moves focus into its first child; a
 * leaf (or an empty container) does nothing.
 */
export function rightKeyResult(rows: readonly TreeRow[], currentId: string, expandedIds: ReadonlySet<string>): KeyResult {
  const row = rows.find((r) => r.id === currentId);
  if (!row || !row.hasChildren) return { expandedIds: new Set(expandedIds), focusId: currentId };
  if (!expandedIds.has(row.id)) return { expandedIds: toggleExpanded(expandedIds, row.id), focusId: currentId };
  const firstChild = rows.find((r) => r.parentId === row.id);
  return { expandedIds: new Set(expandedIds), focusId: firstChild?.id ?? currentId };
}

/** ArrowLeft: an expanded container collapses and keeps focus; a collapsed node (or a leaf) moves focus to its parent; a root node with no parent does nothing. */
export function leftKeyResult(rows: readonly TreeRow[], currentId: string, expandedIds: ReadonlySet<string>): KeyResult {
  const row = rows.find((r) => r.id === currentId);
  if (!row) return { expandedIds: new Set(expandedIds), focusId: currentId };
  if (row.hasChildren && expandedIds.has(row.id)) return { expandedIds: toggleExpanded(expandedIds, row.id), focusId: currentId };
  return { expandedIds: new Set(expandedIds), focusId: row.parentId ?? currentId };
}
