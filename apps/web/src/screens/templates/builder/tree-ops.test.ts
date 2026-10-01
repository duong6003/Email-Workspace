import { describe, expect, it } from 'vitest';
import type { Doc, Node } from './document.js';
import { acceptedParentKinds, ancestorsOf, bindAsset, defaultInsertTarget, describeInsert, findNode, insertNode, moveNodeTo, planInsert, markDecorative, moveNode, removeNode, updateNode, withFreshIds } from './tree-ops.js';

function leaf(id: string, kind: 'text' | 'heading' | 'button' = 'text'): { id: string; kind: typeof kind; visible: boolean } {
  return { id, kind, visible: true };
}

function doc(overrides: Partial<Doc> = {}): Doc {
  return { title: 'Chào mừng', variables: [], nodes: [], ...overrides };
}

describe('insertNode (S4 Task 16)', () => {
  it('appends a section at the document root regardless of target', () => {
    const base = doc();
    const section = { id: 'section-1', kind: 'section' as const, visible: true, children: [] };
    const next = insertNode(base, null, section);
    expect(next.nodes).toEqual([section]);
  });

  it('inserts a row directly into a targeted section', () => {
    const section = { id: 'section-1', kind: 'section' as const, visible: true, children: [] };
    const base = doc({ nodes: [section] });
    const row = { id: 'row-1', kind: 'row' as const, visible: true, children: [] };

    const next = insertNode(base, 'section-1', row);

    expect(next.nodes[0]!.children).toEqual([row]);
  });

  it('inserts a column directly into a targeted row', () => {
    const row = { id: 'row-1', kind: 'row' as const, visible: true, children: [] };
    const section = { id: 'section-1', kind: 'section' as const, visible: true, children: [row] };
    const base = doc({ nodes: [section] });
    const column = { id: 'column-1', kind: 'column' as const, visible: true, children: [] };

    const next = insertNode(base, 'row-1', column);

    expect(next.nodes[0]!.children![0]!.children).toEqual([column]);
  });

  it('inserts a leaf block directly into a targeted column', () => {
    const column = { id: 'column-1', kind: 'column' as const, visible: true, children: [] };
    const row = { id: 'row-1', kind: 'row' as const, visible: true, children: [column] };
    const section = { id: 'section-1', kind: 'section' as const, visible: true, children: [row] };
    const base = doc({ nodes: [section] });
    const text = leaf('text-1');

    const next = insertNode(base, 'column-1', text);

    expect(next.nodes[0]!.children![0]!.children![0]!.children).toEqual([text]);
  });

  it('wraps a leaf block inserted directly on a section with a one-column row', () => {
    const section = { id: 'section-1', kind: 'section' as const, visible: true, children: [] };
    const base = doc({ nodes: [section] });
    const text = leaf('text-1');

    const next = insertNode(base, 'section-1', text);

    const wrappedRow = next.nodes[0]!.children![0]!;
    expect(wrappedRow.kind).toBe('row');
    const wrappedColumn = wrappedRow.children![0]!;
    expect(wrappedColumn.kind).toBe('column');
    expect(wrappedColumn.children).toEqual([text]);
  });

  it('wraps a leaf block inserted with no target in a full section/row/column chain', () => {
    const base = doc();
    const text = leaf('text-1');

    const next = insertNode(base, null, text);

    expect(next.nodes).toHaveLength(1);
    const section = next.nodes[0]!;
    expect(section.kind).toBe('section');
    const row = section.children![0]!;
    expect(row.kind).toBe('row');
    const column = row.children![0]!;
    expect(column.kind).toBe('column');
    expect(column.children).toEqual([text]);
  });

  it('does not mutate the doc passed in', () => {
    const section = { id: 'section-1', kind: 'section' as const, visible: true, children: [] };
    const base = doc({ nodes: [section] });
    insertNode(base, 'section-1', { id: 'row-1', kind: 'row', visible: true, children: [] });
    expect(base.nodes[0]!.children).toEqual([]);
  });
});

function threeLevel() {
  const text = leaf('text-1');
  const column = { id: 'column-1', kind: 'column' as const, visible: true, children: [text] };
  const row = { id: 'row-1', kind: 'row' as const, visible: true, children: [column] };
  const section = { id: 'section-1', kind: 'section' as const, visible: true, children: [row] };
  return { section, row, column, text, base: doc({ nodes: [section] }) };
}

describe('findNode (S4 Task 17)', () => {
  it('finds a node nested several levels deep', () => {
    const { base, text } = threeLevel();
    expect(findNode(base, 'text-1')).toEqual(text);
  });

  it('returns undefined for an id not in the tree', () => {
    const { base } = threeLevel();
    expect(findNode(base, 'missing')).toBeUndefined();
  });
});

describe('ancestorsOf (S4 Task 17)', () => {
  it('lists ancestors root-first, excluding the node itself', () => {
    const { base, section, row, column } = threeLevel();
    expect(ancestorsOf(base, 'text-1')).toEqual([section, row, column]);
  });

  it('is empty for a top-level node and for an unknown id', () => {
    const { base } = threeLevel();
    expect(ancestorsOf(base, 'section-1')).toEqual([]);
    expect(ancestorsOf(base, 'missing')).toEqual([]);
  });
});

describe('removeNode (S4 Task 17)', () => {
  it('removes a deeply nested node without disturbing its siblings', () => {
    const { base, column } = threeLevel();
    const sibling = leaf('text-2');
    const withSibling = { ...base, nodes: [{ ...base.nodes[0]!, children: [{ ...column, children: [...column.children, sibling] }] }] };

    const next = removeNode(withSibling, 'text-1');

    expect(findNode(next, 'text-1')).toBeUndefined();
    expect(findNode(next, 'text-2')).toEqual(sibling);
  });
});

describe('moveNode (S4 Task 17)', () => {
  it('swaps a node with its previous sibling on "up"', () => {
    const first = leaf('a');
    const second = leaf('b');
    const base = doc({ nodes: [first, second] });

    const next = moveNode(base, 'b', 'up');

    expect(next.nodes).toEqual([second, first]);
  });

  it('swaps a node with its next sibling on "down"', () => {
    const first = leaf('a');
    const second = leaf('b');
    const base = doc({ nodes: [first, second] });

    const next = moveNode(base, 'a', 'down');

    expect(next.nodes).toEqual([second, first]);
  });

  it('is a no-op (same reference) at the top boundary', () => {
    const base = doc({ nodes: [leaf('a'), leaf('b')] });
    expect(moveNode(base, 'a', 'up')).toBe(base);
  });

  it('is a no-op (same reference) at the bottom boundary', () => {
    const base = doc({ nodes: [leaf('a'), leaf('b')] });
    expect(moveNode(base, 'b', 'down')).toBe(base);
  });

  it('moves within a nested sibling list, not just at the root', () => {
    const { base, column, row } = threeLevel();
    const secondText = leaf('text-2');
    const withTwo = { ...base, nodes: [{ ...base.nodes[0]!, children: [{ ...row, children: [{ ...column, children: [...column.children, secondText] }] }] }] };

    const next = moveNode(withTwo, 'text-2', 'up');

    expect(findNode(next, 'column-1')!.children).toEqual([secondText, column.children[0]]);
  });
});

describe('updateNode (S4 Task 18)', () => {
  it('merges a patch into the node with this id', () => {
    const { base } = threeLevel();
    const next = updateNode(base, 'text-1', { content: 'Nội dung mới' });
    expect(findNode(next, 'text-1')!.content).toBe('Nội dung mới');
  });

  it('leaves the doc unchanged for an id not in the tree', () => {
    const { base } = threeLevel();
    expect(updateNode(base, 'missing', { content: 'x' })).toBe(base);
  });
});

describe('withFreshIds (S5 Task 29: inserting a saved reusable block)', () => {
  const saved = {
    id: 'section-1', kind: 'section' as const, visible: true,
    children: [
      { id: 'row-1', kind: 'row' as const, visible: true, children: [
        { id: 'col-1', kind: 'column' as const, visible: true, children: [{ id: 'text-1', kind: 'text' as const, visible: true, content: 'Chân trang' }] },
      ] },
    ],
  };

  it('regenerates every id in the subtree, root and descendants alike', () => {
    const copy = withFreshIds(saved);
    const ids = (node: typeof saved | Node): string[] => [node.id, ...(node.children ?? []).flatMap(ids)];
    expect(ids(copy)).not.toContain('section-1');
    expect(ids(copy)).not.toContain('text-1');
    expect(new Set(ids(copy)).size).toBe(4);
  });

  it('keeps everything except the ids', () => {
    const copy = withFreshIds(saved);
    expect(copy.kind).toBe('section');
    expect(copy.children?.[0]?.children?.[0]?.children?.[0]).toMatchObject({ kind: 'text', content: 'Chân trang' });
  });

  it('gives two inserts of the same block disjoint ids -- the whole point', () => {
    const first = withFreshIds(saved);
    const second = withFreshIds(saved);
    const ids = (node: Node): string[] => [node.id, ...(node.children ?? []).flatMap(ids)];
    expect(ids(first).some((id) => ids(second).includes(id))).toBe(false);
  });

  it('regenerates social link ids, the only other id the model carries', () => {
    const social: Node = { id: 'social-1', kind: 'social', visible: true, social: [{ id: 'link-1', platform: 'facebook', url: '', enabled: true }] };
    const copy = withFreshIds(social);
    expect(copy.social?.[0]?.id).not.toBe('link-1');
    expect(copy.social?.[0]).toMatchObject({ platform: 'facebook', enabled: true });
  });

  it('does not mutate the saved block it copies from', () => {
    withFreshIds(saved);
    expect(saved.id).toBe('section-1');
    expect(saved.children[0]?.id).toBe('row-1');
  });
});

/**
 * MC-UI-005 `bind` and `mark_decorative` (S6 Task 39). ADR-043 §7 keeps these
 * off the AssetProvider port on purpose -- they change the document, so they
 * live here with every other structural rule and reach the UI through the
 * engine, the one route spec §2.13 allows.
 */
describe('bindAsset (S6 Task 39)', () => {
  const withImage = (node: Node): Doc => doc({ nodes: [{ id: 'section-1', kind: 'section', visible: true, children: [{ id: 'row-1', kind: 'row', visible: true, children: [{ id: 'col-1', kind: 'column', visible: true, children: [node] }] }] }] });
  const URL = 'https://app.example.test/api/v1/assets/a1/logo.png';

  it('sets src on an image nested anywhere in the tree', () => {
    const next = bindAsset(withImage({ id: 'img-1', kind: 'image', visible: true }), 'img-1', URL);
    expect(findNode(next, 'img-1')).toMatchObject({ src: URL });
  });

  it.each(['banner', 'logo'] as const)('binds a %s too -- every kind whose src reaches an <img>', (kind) => {
    const next = bindAsset(withImage({ id: 'n-1', kind, visible: true }), 'n-1', URL);
    expect(findNode(next, 'n-1')).toMatchObject({ src: URL });
  });

  it.each(['text', 'button', 'divider'] as const)('refuses to bind to a %s, which has no image to carry', (kind) => {
    const base = withImage({ id: 'n-1', kind, visible: true });
    expect(bindAsset(base, 'n-1', URL)).toBe(base);
  });

  it('refuses anything that is not absolute https -- Task 32 measured the sanitizer strips the rest, so binding one would create the very state the panel reports', () => {
    const base = withImage({ id: 'img-1', kind: 'image', visible: true });
    for (const src of ['http://cdn.test/a.png', '//cdn.test/a.png', '/api/v1/assets/a1/a.png', 'data:image/png;base64,AAA', '  ']) {
      expect(bindAsset(base, 'img-1', src)).toBe(base);
    }
  });

  it('is a no-op for an id that is not in the tree', () => {
    const base = withImage({ id: 'img-1', kind: 'image', visible: true });
    expect(bindAsset(base, 'nope', URL)).toBe(base);
  });

  it('replaces an existing src rather than appending a second image', () => {
    const base = withImage({ id: 'img-1', kind: 'image', visible: true, src: 'https://old.test/a.png' });
    expect(findNode(bindAsset(base, 'img-1', URL), 'img-1')).toMatchObject({ src: URL });
  });
});

describe('markDecorative (S6 Task 39)', () => {
  const withImage = (node: Node): Doc => doc({ nodes: [{ id: 'section-1', kind: 'section', visible: true, children: [node] }] });

  it('sets the flag on an image-bearing node', () => {
    const next = markDecorative(withImage({ id: 'img-1', kind: 'image', visible: true, alt: 'Ảnh' }), 'img-1', true);
    expect(findNode(next, 'img-1')).toMatchObject({ decorative: true });
  });

  it('keeps the written alt while decorative, so unmarking restores it instead of losing the words', () => {
    const marked = markDecorative(withImage({ id: 'img-1', kind: 'image', visible: true, alt: 'Ảnh sản phẩm' }), 'img-1', true);
    expect(findNode(marked, 'img-1')).toMatchObject({ alt: 'Ảnh sản phẩm' });
    const unmarked = markDecorative(marked, 'img-1', false);
    expect(findNode(unmarked, 'img-1')).toMatchObject({ alt: 'Ảnh sản phẩm' });
  });

  it('drops the key entirely when unmarked, rather than storing decorative: false on every image in projectData', () => {
    const unmarked = markDecorative(withImage({ id: 'img-1', kind: 'image', visible: true, decorative: true }), 'img-1', false);
    expect(findNode(unmarked, 'img-1')).not.toHaveProperty('decorative');
  });

  it.each(['text', 'button'] as const)('refuses a %s -- there is no image for the flag to describe', (kind) => {
    const base = withImage({ id: 'n-1', kind, visible: true });
    expect(markDecorative(base, 'n-1', true)).toBe(base);
  });

  it('is a no-op for an id that is not in the tree', () => {
    const base = withImage({ id: 'img-1', kind: 'image', visible: true });
    expect(markDecorative(base, 'nope', true)).toBe(base);
  });
});

describe('insertNode with a drop position', () => {
  // Until now the third argument was the whole story: a drop resolved a
  // CONTAINER from the target and pushed onto the end of it. Measured, that
  // meant dropping on the first, middle or last child of a column produced the
  // identical document -- the cursor position had no effect at all, while the
  // canvas drew a dashed outline around the block under it as if it did.
  const column = (children: Node[]): Node => ({ id: 'col-1', kind: 'column', visible: true, children });
  const wrap = (children: Node[]): Doc => doc({
    nodes: [{ id: 'section-1', kind: 'section', visible: true, children: [{ id: 'row-1', kind: 'row', visible: true, children: [column(children)] }] }],
  });
  const ids = (next: Doc): string[] => (next.nodes[0]!.children![0]!.children![0]!.children ?? []).map((n) => n.id);
  const abc = (): Node[] => [leaf('a'), leaf('b'), leaf('c')] as Node[];
  const fresh = leaf('new') as Node;

  it('puts the node immediately before the block it was dropped on', () => {
    expect(ids(insertNode(wrap(abc()), 'b', fresh, 'before'))).toEqual(['a', 'new', 'b', 'c']);
  });

  it('puts the node immediately after the block it was dropped on', () => {
    expect(ids(insertNode(wrap(abc()), 'b', fresh, 'after'))).toEqual(['a', 'b', 'new', 'c']);
  });

  it('inserts at the head when dropped before the first block', () => {
    expect(ids(insertNode(wrap(abc()), 'a', fresh, 'before'))).toEqual(['new', 'a', 'b', 'c']);
  });

  it('inserts at the tail when dropped after the last block', () => {
    expect(ids(insertNode(wrap(abc()), 'c', fresh, 'after'))).toEqual(['a', 'b', 'c', 'new']);
  });

  it('appends when the target IS the container, because there is no sibling to sit beside', () => {
    expect(ids(insertNode(wrap(abc()), 'col-1', fresh, 'before'))).toEqual(['a', 'b', 'c', 'new']);
  });

  it('keeps the old append behaviour when no position is given', () => {
    expect(ids(insertNode(wrap(abc()), 'a', fresh))).toEqual(['a', 'b', 'c', 'new']);
  });

  it('positions a section against the top-level section it was dropped inside, not at the document end', () => {
    const base = doc({
      nodes: [
        { id: 'section-1', kind: 'section', visible: true, children: [{ id: 'row-1', kind: 'row', visible: true, children: [column([leaf('a') as Node])] }] },
        { id: 'section-2', kind: 'section', visible: true, children: [] },
      ],
    });
    const section = { id: 'new-section', kind: 'section' as const, visible: true, children: [] };
    // Dropped on a leaf deep inside section-1: the section it becomes a sibling
    // of is section-1, the ancestor that is a direct child of the root.
    expect(insertNode(base, 'a', section, 'before').nodes.map((n) => n.id)).toEqual(['new-section', 'section-1', 'section-2']);
  });

  it('leaves the existing column alone when the target id is not in the document', () => {
    // Pre-existing behaviour, asserted here so the position argument cannot
    // quietly change it: with no path to resolve, the wrap-and-recurse branch
    // builds a fresh section/row/column chain at the document end.
    const next = insertNode(wrap(abc()), 'nope', fresh, 'before');
    expect(ids(next)).toEqual(['a', 'b', 'c']);
    expect(next.nodes).toHaveLength(2);
    expect(findNode(next, 'new')).toBeDefined();
  });
});

describe('planInsert -- where a drop will actually land', () => {
  /**
   * The indicator drew a line beside the leaf under the cursor while
   * `insertNode` resolved a container and put the block somewhere else
   * entirely. Measured on the running app: dropping a Row on a text leaf drew
   * the line inside that leaf's Column, and the Row landed as a sibling of the
   * Column's Row, one level up. Two independent calculations of "where does
   * this go" cannot be kept in agreement by care alone, so there is now one,
   * and the view reads it.
   */
  const doc3 = (): Doc => doc({
    nodes: [
      { id: 'sec-1', kind: 'section', visible: true, children: [
        { id: 'row-1', kind: 'row', visible: true, children: [
          { id: 'col-1', kind: 'column', visible: true, children: [leaf('a') as Node, leaf('b') as Node] },
        ] },
      ] },
      { id: 'sec-2', kind: 'section', visible: true, children: [] },
    ],
  });

  it('anchors a leaf beside the leaf it was dropped on', () => {
    expect(planInsert(doc3(), 'b', 'text', 'before')).toEqual({ at: 'beside', containerId: 'col-1', index: 1, edge: 'before', anchorId: 'b' });
  });

  it('anchors a ROW inside the COLUMN holding the leaf -- the nested layout studio.tsx builds', () => {
    // `accepts()` lets a Column hold a Row, and `add()` sends a layout aimed at
    // anything below a Section through `columnForTarget`. So a Row aimed at a
    // leaf nests beside that leaf rather than climbing out to the Section.
    expect(planInsert(doc3(), 'a', 'row', 'before')).toEqual({ at: 'beside', containerId: 'col-1', index: 0, edge: 'before', anchorId: 'a' });
  });

  it('anchors a SECTION against the top-level section, not the leaf', () => {
    expect(planInsert(doc3(), 'a', 'section', 'after')).toEqual({ at: 'beside', containerId: null, index: 0, edge: 'after', anchorId: 'sec-1' });
  });

  it('anchors a COLUMN against the column that contains the leaf', () => {
    expect(planInsert(doc3(), 'a', 'column', 'after')).toEqual({ at: 'beside', containerId: 'row-1', index: 0, edge: 'after', anchorId: 'col-1' });
  });

  it('reports "end of this container" when the target IS the container', () => {
    expect(planInsert(doc3(), 'col-1', 'text', 'before')).toEqual({ at: 'end', containerId: 'col-1' });
  });

  it('reports "end of this container" when no edge is given, which is what click-to-insert does', () => {
    expect(planInsert(doc3(), 'a', 'text')).toEqual({ at: 'end', containerId: 'col-1' });
  });

  it('reports the document end when there is no target at all', () => {
    expect(planInsert(doc3(), null, 'text', 'before')).toEqual({ at: 'end', containerId: null });
  });

  it('resolves through a container that has to be created: a leaf dropped on a Row', () => {
    // No column on the path, so `insertNode` wraps. The plan has to describe
    // the level the WRAPPER lands at, because that is what the reader sees.
    expect(planInsert(doc3(), 'row-1', 'text', 'before')).toEqual({ at: 'end', containerId: 'row-1' });
  });

  it('agrees with insertNode: the planned anchor is where the node really appears', () => {
    const base = doc3();
    const plan = planInsert(base, 'a', 'row', 'before');
    const next = insertNode(base, 'a', { id: 'new-row', kind: 'row', visible: true, children: [] }, 'before');
    expect(plan.at).toBe('beside');
    if (plan.at !== 'beside') return;
    const container = findNode(next, plan.containerId!)!;
    expect(container.children!.map((n) => n.id)).toEqual(['new-row', 'a', 'b']);
  });
});

describe('moveNodeTo -- dragging a block that is already on the canvas', () => {
  /**
   * The prototype makes every leaf a drag SOURCE (`studio.tsx:822`,
   * `dataTransfer.setData("mc/node", node.id)`) and moves it on drop, with two
   * refusals: onto itself, and into its own subtree. The port carried the drop
   * half and none of the drag half -- measured, the whole builder had exactly
   * one draggable element, the palette button -- so once a block was on the
   * canvas the only way to reorder it was the inspector's up/down pair.
   */
  const two = (): Doc => doc({
    nodes: [
      { id: 'sec-1', kind: 'section', visible: true, children: [
        { id: 'row-1', kind: 'row', visible: true, children: [
          { id: 'col-1', kind: 'column', visible: true, children: [leaf('a') as Node, leaf('b') as Node, leaf('c') as Node] },
          { id: 'col-2', kind: 'column', visible: true, children: [leaf('x') as Node] },
        ] },
      ] },
    ],
  });
  const col = (next: Doc, id: string): string[] => {
    const found = findNode(next, id)!;
    return (found.children ?? []).map((n) => n.id);
  };

  it('reorders within one column', () => {
    expect(col(moveNodeTo(two(), 'c', 'a', 'before'), 'col-1')).toEqual(['c', 'a', 'b']);
  });

  it('reorders without an off-by-one when the node moves down past its old slot', () => {
    // `a` is removed first, so `c`'s index shifts. Planning before the removal
    // would land it in the wrong place.
    expect(col(moveNodeTo(two(), 'a', 'c', 'after'), 'col-1')).toEqual(['b', 'c', 'a']);
  });

  it('moves a leaf into a different column', () => {
    const next = moveNodeTo(two(), 'a', 'x', 'before');
    expect(col(next, 'col-2')).toEqual(['a', 'x']);
    expect(col(next, 'col-1')).toEqual(['b', 'c']);
  });

  it('moves a whole container, children intact', () => {
    const next = moveNodeTo(two(), 'col-2', 'col-1', 'before');
    expect(col(next, 'row-1')).toEqual(['col-2', 'col-1']);
    expect(col(next, 'col-2')).toEqual(['x']);
  });

  it('refuses to drop a node on itself', () => {
    const base = two();
    expect(moveNodeTo(base, 'a', 'a', 'before')).toBe(base);
  });

  it('refuses to drop a container into its own subtree, which would detach the tree', () => {
    const base = two();
    expect(moveNodeTo(base, 'col-1', 'b', 'after')).toBe(base);
    expect(moveNodeTo(base, 'row-1', 'x', 'before')).toBe(base);
  });

  it('refuses an id that is not in the document', () => {
    const base = two();
    expect(moveNodeTo(base, 'nope', 'a', 'before')).toBe(base);
    expect(moveNodeTo(base, 'a', 'nope', 'before')).toBe(base);
  });
});

describe('describeInsert -- what to tell the author afterwards', () => {
  /**
   * A4/A5: the port never refused and never explained, so an insert always
   * succeeded somewhere and the author was told nothing. `insertNode` will
   * happily build a Section, a Row and a Column to hold one text block, which
   * is a reasonable thing to do and an unreasonable thing to do silently.
   */
  const nested = (): Doc => doc({
    nodes: [
      { id: 'sec-1', kind: 'section', visible: true, children: [
        { id: 'row-1', kind: 'row', visible: true, children: [
          { id: 'col-1', kind: 'column', visible: true, children: [leaf('a') as Node] },
        ] },
      ] },
    ],
  });

  it('names the column a leaf lands in, with nothing invented', () => {
    expect(describeInsert(nested(), 'a', 'text')).toEqual({ containerKind: 'column', wraps: false });
  });

  it('names the column a nested row lands in', () => {
    expect(describeInsert(nested(), 'a', 'row')).toEqual({ containerKind: 'column', wraps: false });
  });

  it('reports the document root for a section', () => {
    expect(describeInsert(nested(), 'a', 'section')).toEqual({ containerKind: null, wraps: false });
  });

  it('reports that containers get built when a leaf has nowhere to go', () => {
    // The case that surprises people: nothing selected on an empty canvas, and
    // one click produces a Section, a Row and a Column as well as the block.
    expect(describeInsert(doc(), null, 'text')).toEqual({ containerKind: null, wraps: true });
  });

  it('reports wrapping when a leaf is dropped on a Row, which has no column yet', () => {
    const rowOnly = doc({ nodes: [{ id: 'sec-1', kind: 'section', visible: true, children: [{ id: 'row-1', kind: 'row', visible: true, children: [] }] }] });
    expect(describeInsert(rowOnly, 'row-1', 'text')).toEqual({ containerKind: 'row', wraps: true });
  });

  it('does not call it wrapping when the container is already the right kind', () => {
    expect(describeInsert(nested(), 'col-1', 'text')).toEqual({ containerKind: 'column', wraps: false });
  });
});

describe('defaultInsertTarget -- where an unaimed click goes', () => {
  /**
   * D10. Clicking a palette button with nothing selected passed `null` as the
   * target, which sent `insertNode` down its wrap-and-recurse path and built a
   * fresh Section, Row and Column for every click. Measured: two clicks, two
   * separate sections, so an email became a stack of one-block sections.
   *
   * The prototype resolves an existing column instead (`columnForTarget` falls
   * back to `firstColumn`), and only refuses when the document has none. This
   * takes the LAST such container rather than the first: "thêm khối" means add
   * to what I have, and dropping a block silently at the top of a long email is
   * worse than either alternative. Dropping on the bare canvas still makes a new
   * Section -- that path is `dropRoot` in the prototype and is deliberately
   * different, because the background is the one place that means "outside
   * everything".
   */
  const two = (): Doc => doc({
    nodes: [
      { id: 'sec-1', kind: 'section', visible: true, children: [
        { id: 'row-1', kind: 'row', visible: true, children: [{ id: 'col-1', kind: 'column', visible: true, children: [] }] },
      ] },
      { id: 'sec-2', kind: 'section', visible: true, children: [
        { id: 'row-2', kind: 'row', visible: true, children: [{ id: 'col-2', kind: 'column', visible: true, children: [] }] },
      ] },
    ],
  });

  it('sends a leaf to the last column in the document', () => {
    expect(defaultInsertTarget(two(), 'text')).toBe('col-2');
  });

  it('sends a row to the last section', () => {
    expect(defaultInsertTarget(two(), 'row')).toBe('sec-2');
  });

  it('sends a column to the last row', () => {
    expect(defaultInsertTarget(two(), 'column')).toBe('row-2');
  });

  it('has nothing to say about a section, which lives at the root anyway', () => {
    expect(defaultInsertTarget(two(), 'section')).toBeNull();
  });

  it('returns null on an empty document, leaving the wrap-and-recurse path to build one', () => {
    expect(defaultInsertTarget(doc(), 'text')).toBeNull();
  });

  it('ignores containers of the wrong kind', () => {
    const rowsOnly = doc({ nodes: [{ id: 'sec-1', kind: 'section', visible: true, children: [{ id: 'row-1', kind: 'row', visible: true, children: [] }] }] });
    expect(defaultInsertTarget(rowsOnly, 'text')).toBeNull();
  });
});

/**
 * A row's columns are NOT rebalanced when the count changes.
 *
 * An earlier pass here added that: insert a third column into a 50/50 row and
 * every width was rewritten to 33/34/33. `studio.tsx`'s own `addColumn` appends
 * `newColumn()` -- width 100, nothing else touched -- so a 50/50 row that gains
 * a column becomes 50/50/100, and the author picks a ratio from the Inspector's
 * six presets if they want one. The rebalance was mine, not the handoff's, and
 * these tests are what stop it coming back.
 */
describe('a row leaves its column widths alone', () => {
  const rowWith = (columns: Node[]): Doc => doc({
    nodes: [{ id: 'sec-1', kind: 'section', visible: true, children: [{ id: 'row-1', kind: 'row', visible: true, children: columns }] }],
  });
  const column = (id: string, width: number, children: Node[] = []): Node => ({ id, kind: 'column', visible: true, width, children });
  const widthsOf = (next: Doc): (number | undefined)[] => (findNode(next, 'row-1')?.children ?? []).map((child) => child.width);

  it('keeps the widths it had when a column is added', () => {
    const next = insertNode(rowWith([column('col-1', 50), column('col-2', 50)]), 'row-1', column('col-3', 100));
    expect(widthsOf(next)).toEqual([50, 50, 100]);
  });

  it('keeps them when a column is deleted, leaving a row that no longer fills itself', () => {
    const next = removeNode(rowWith([column('col-1', 33), column('col-2', 34), column('col-3', 33)]), 'col-2');
    expect(widthsOf(next)).toEqual([33, 33]);
  });

  it('inserts a column exactly as handed over, without stamping a width onto it', () => {
    const bare: Node = { id: 'col-2', kind: 'column', visible: true, children: [] };
    const next = insertNode(rowWith([column('col-1', 100)]), 'row-1', bare);
    expect((findNode(next, 'row-1')?.children ?? [])[1]).toEqual(bare);
  });
});

/**
 * A Row may sit inside a Column -- the prototype's nested layout.
 *
 * `studio.tsx`'s `accepts()` reads: a Section takes rows, a Row takes columns,
 * and a **Column takes anything except a Section and another Column** -- which
 * includes a Row. That is what its Inspector's "＋ Thêm layout 2 cột bên trong"
 * builds, and `emitColumn` already emits whatever its children emit, so the
 * mail side has always supported it.
 *
 * `requiredParentKind` answered with ONE kind, so a Row aimed at a Column was
 * treated as unplaceable and wrapped in a fresh Section -- inside the column.
 */
describe('nested layout (studio.tsx accepts())', () => {
  const nested = (): Doc => doc({
    nodes: [{
      id: 'sec-1', kind: 'section', visible: true, children: [
        { id: 'row-1', kind: 'row', visible: true, children: [{ id: 'col-1', kind: 'column', visible: true, children: [] }] },
      ],
    }],
  });
  const row = (id: string): Node => ({ id, kind: 'row', visible: true, children: [{ id: `${id}-c`, kind: 'column', visible: true, children: [] }] });

  it('puts a row aimed at a column directly inside it, with no Section invented in between', () => {
    const next = insertNode(nested(), 'col-1', row('row-2'));
    expect((findNode(next, 'col-1')?.children ?? []).map((child) => child.kind)).toEqual(['row']);
    expect(findNode(next, 'row-2')).toBeDefined();
  });

  it('still wraps a row in a Section when there is no column or section to take it', () => {
    const next = insertNode(doc(), null, row('row-2'));
    expect(next.nodes.map((node) => node.kind)).toEqual(['section']);
    expect(next.nodes[0]!.children!.map((child) => child.kind)).toEqual(['row']);
  });

  it('still refuses a column anywhere but a row, and a section anywhere but the root', () => {
    expect(acceptedParentKinds('column')).toEqual(['row']);
    expect(acceptedParentKinds('section')).toBeNull();
    expect(acceptedParentKinds('text')).toEqual(['column']);
    expect(acceptedParentKinds('row')).toEqual(['section', 'column']);
  });
});

/**
 * The Section, Row and Column built on the author's behalf are built the way
 * the palette builds them.
 *
 * `insertNode` wraps an orphan block in whatever container it needs, and it was
 * minting those inline: `{id, kind, visible, children}`. So a click on an empty
 * canvas produced a Column with no padding while the same Column inserted from
 * the panel carried the handoff's 18px -- two Columns in one document, styled
 * differently, for no reason the author could see.
 */
describe('wrapped containers use the catalog, not a bare object', () => {
  it('gives an auto-built Column the same padding the palette gives it', () => {
    const next = insertNode(doc(), null, { id: 'text-1', kind: 'text', visible: true, content: 'xin chào' });
    const column = findNode(next, next.nodes[0]!.children![0]!.children![0]!.id)!;
    expect(column.kind).toBe('column');
    expect(column.paddingTop).toBe(18);
  });

  it('gives an auto-built Section the catalog\'s background', () => {
    const next = insertNode(doc(), null, { id: 'text-1', kind: 'text', visible: true, content: 'xin chào' });
    expect(next.nodes[0]!.background).toBe('#ffffff');
  });
});
