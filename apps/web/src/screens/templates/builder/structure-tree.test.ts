import { describe, expect, it } from 'vitest';
import type { Doc, Node } from './document.js';
import { collapseAllIds, expandAllIds, leftKeyResult, moveFocus, rightKeyResult, toggleExpanded, visibleTreeRows } from './structure-tree.js';

const leaf = (id: string): Node => ({ id, kind: 'text', visible: true, content: id });
const column = (id: string, children: Node[]): Node => ({ id, kind: 'column', visible: true, children });
const row = (id: string, children: Node[]): Node => ({ id, kind: 'row', visible: true, children });
const section = (id: string, children: Node[]): Node => ({ id, kind: 'section', visible: true, children });

function doc(nodes: Node[]): Doc {
  return { title: 't', nodes, variables: [] };
}

const TREE = doc([
  section('s1', [row('r1', [column('c1', [leaf('t1')]), column('c2', [leaf('t2')])])]),
  leaf('t3'),
]);

describe('visibleTreeRows (S4 Task 19)', () => {
  it('shows only root nodes when nothing is expanded', () => {
    const rows = visibleTreeRows(TREE, new Set());
    expect(rows.map((r) => r.id)).toEqual(['s1', 't3']);
  });

  it('reveals children of an expanded container, still collapsed one level down', () => {
    const rows = visibleTreeRows(TREE, new Set(['s1']));
    expect(rows.map((r) => r.id)).toEqual(['s1', 'r1', 't3']);
  });

  it('reveals grandchildren when every ancestor is expanded', () => {
    const rows = visibleTreeRows(TREE, new Set(['s1', 'r1', 'c1', 'c2']));
    expect(rows.map((r) => r.id)).toEqual(['s1', 'r1', 'c1', 't1', 'c2', 't2', 't3']);
  });

  it('assigns depth by nesting level, not by expansion state', () => {
    const rows = visibleTreeRows(TREE, new Set(['s1', 'r1', 'c1', 'c2']));
    expect(rows.find((r) => r.id === 's1')?.depth).toBe(0);
    expect(rows.find((r) => r.id === 'r1')?.depth).toBe(1);
    expect(rows.find((r) => r.id === 'c1')?.depth).toBe(2);
    expect(rows.find((r) => r.id === 't1')?.depth).toBe(3);
  });

  it('marks hasChildren correctly -- a leaf never has children, an empty container does not either', () => {
    const rows = visibleTreeRows(doc([section('empty', []), leaf('t')]), new Set());
    expect(rows.find((r) => r.id === 'empty')?.hasChildren).toBe(false);
    expect(rows.find((r) => r.id === 't')?.hasChildren).toBe(false);
  });

  it('carries parentId, null at the root', () => {
    const rows = visibleTreeRows(TREE, new Set(['s1', 'r1']));
    expect(rows.find((r) => r.id === 's1')?.parentId).toBeNull();
    expect(rows.find((r) => r.id === 'r1')?.parentId).toBe('s1');
    expect(rows.find((r) => r.id === 'c1')?.parentId).toBe('r1');
  });

  // ADR-044 Task SV-3 (MC-UI-003): the tree's per-row visibility/lock toggles
  // (`v3-layer`'s two trailing buttons) need the node's own flags on the row,
  // not just id/kind/depth -- otherwise the toggle button cannot show its
  // current state without a second lookup back into the tree.
  it('carries visible (default true) and locked (default false) from the node', () => {
    const rows = visibleTreeRows(doc([{ id: 'hidden', kind: 'text', visible: false, content: 'x' }, { id: 'locked', kind: 'text', visible: true, locked: true, content: 'y' }, leaf('plain')]), new Set());
    expect(rows.find((r) => r.id === 'hidden')?.visible).toBe(false);
    expect(rows.find((r) => r.id === 'locked')?.locked).toBe(true);
    expect(rows.find((r) => r.id === 'plain')).toMatchObject({ visible: true, locked: false });
  });
});

describe('toggleExpanded / expandAllIds / collapseAllIds', () => {
  it('toggles membership without mutating the input set', () => {
    const original = new Set(['a']);
    const added = toggleExpanded(original, 'b');
    expect(added.has('b')).toBe(true);
    expect(original.has('b')).toBe(false);
    const removed = toggleExpanded(added, 'b');
    expect(removed.has('b')).toBe(false);
  });

  it('expandAllIds includes every container, never a leaf', () => {
    const ids = expandAllIds(TREE);
    expect([...ids].sort()).toEqual(['c1', 'c2', 'r1', 's1']);
  });

  it('collapseAllIds is always empty', () => {
    expect(collapseAllIds().size).toBe(0);
  });
});

describe('moveFocus (arrow up/down)', () => {
  it('moves to the next/previous row in visible order', () => {
    const rows = visibleTreeRows(TREE, new Set());
    expect(moveFocus(rows, 's1', 'down')).toBe('t3');
    expect(moveFocus(rows, 't3', 'up')).toBe('s1');
  });

  it('clamps at the first and last row', () => {
    const rows = visibleTreeRows(TREE, new Set());
    expect(moveFocus(rows, 's1', 'up')).toBe('s1');
    expect(moveFocus(rows, 't3', 'down')).toBe('t3');
  });

  it('starts at the first row when nothing is focused yet', () => {
    const rows = visibleTreeRows(TREE, new Set());
    expect(moveFocus(rows, null, 'down')).toBe('s1');
  });
});

describe('rightKeyResult / leftKeyResult (WAI-ARIA treeview expand/collapse + move-into/out)', () => {
  it('ArrowRight on a collapsed container expands it and keeps focus there', () => {
    const rows = visibleTreeRows(TREE, new Set());
    const result = rightKeyResult(rows, 's1', new Set());
    expect(result.expandedIds.has('s1')).toBe(true);
    expect(result.focusId).toBe('s1');
  });

  it('ArrowRight on an already-expanded container moves focus to its first child', () => {
    const rows = visibleTreeRows(TREE, new Set(['s1']));
    const result = rightKeyResult(rows, 's1', new Set(['s1']));
    expect(result.focusId).toBe('r1');
  });

  it('ArrowRight on a leaf is a no-op', () => {
    const rows = visibleTreeRows(TREE, new Set());
    const result = rightKeyResult(rows, 't3', new Set());
    expect(result.focusId).toBe('t3');
    expect(result.expandedIds.size).toBe(0);
  });

  it('ArrowLeft on an expanded container collapses it and keeps focus there', () => {
    const rows = visibleTreeRows(TREE, new Set(['s1']));
    const result = leftKeyResult(rows, 's1', new Set(['s1']));
    expect(result.expandedIds.has('s1')).toBe(false);
    expect(result.focusId).toBe('s1');
  });

  it('ArrowLeft on a collapsed or leaf node moves focus to its parent', () => {
    const rows = visibleTreeRows(TREE, new Set(['s1', 'r1']));
    const result = leftKeyResult(rows, 'r1', new Set(['s1']));
    expect(result.focusId).toBe('s1');
  });

  it('ArrowLeft on a root node with no parent is a no-op', () => {
    const rows = visibleTreeRows(TREE, new Set());
    const result = leftKeyResult(rows, 's1', new Set());
    expect(result.focusId).toBe('s1');
  });
});

/**
 * `Node.name` was declared and read by nothing (audit backlog §1). The tree is
 * where it finally reads: the prototype's `nodeName(n, l)` has always been
 * `n.name || <default for the kind>`, and EOW only had the fallback half.
 */
describe('TreeRow.name', () => {
  const doc = (name?: string): Doc => ({
    title: 'T', variables: [], theme: {},
    nodes: [{ id: 'sec', kind: 'section', visible: true, children: [{ id: 'r', kind: 'row', visible: true, ...(name === undefined ? {} : { name }) }] }],
  } as unknown as Doc);

  it('carries the author name onto the row when there is one', () => {
    const rows = visibleTreeRows(doc('Hàng tiêu đề'), new Set(['sec']));
    expect(rows.find((r) => r.id === 'r')?.name).toBe('Hàng tiêu đề');
  });

  it('leaves it absent when unnamed, so the renderer falls back to the kind label', () => {
    const rows = visibleTreeRows(doc(), new Set(['sec']));
    expect(rows.find((r) => r.id === 'r')?.name).toBeUndefined();
  });

  it('treats a blank or whitespace name as unnamed rather than as an empty label', () => {
    expect(visibleTreeRows(doc('   '), new Set(['sec'])).find((r) => r.id === 'r')?.name).toBeUndefined();
    expect(visibleTreeRows(doc(''), new Set(['sec'])).find((r) => r.id === 'r')?.name).toBeUndefined();
  });

  it('trims the stored name, so a stray space cannot shift the row label', () => {
    expect(visibleTreeRows(doc('  Hàng A  '), new Set(['sec'])).find((r) => r.id === 'r')?.name).toBe('Hàng A');
  });
});
