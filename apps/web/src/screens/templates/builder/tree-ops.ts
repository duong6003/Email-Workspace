import { BLOCK_CATALOG } from './blocks.js';
import { IMAGE_BEARING_KINDS, type ContainerKind, type Doc, type Node } from './document.js';

/**
 * Pure structural operations on the `Doc` tree (S4 Task 16/17). No React, no
 * engine, no history -- `engine.ts` calls these and commits the result the
 * same way it already commits everything else (spec §2.1: web has no
 * component-render tests, so nesting rules have to live somewhere unit-testable).
 */

/**
 * Every container kind a node of `kind` may live directly under, in the order
 * `insertNode` prefers them. `null` means top-level (only `section`).
 *
 * This is `studio.tsx`'s `accepts()`, ported: "a Section takes rows, a Row takes
 * columns, a Column takes anything that is not a Section and not another
 * Column". The last clause is why a Row appears here with two parents -- a Row
 * inside a Column is the prototype's nested layout, built by its Inspector's
 * "＋ Thêm layout 2 cột bên trong". EOW allowed one parent per kind, so a Row
 * aimed at a Column read as unplaceable and arrived wrapped in a Section that
 * nobody asked for.
 */
export function acceptedParentKinds(kind: Node['kind']): readonly ContainerKind[] | null {
  if (kind === 'section') return null;
  if (kind === 'row') return ['section', 'column'];
  if (kind === 'column') return ['row'];
  return ['column'];
}

/** The container kind to CREATE when a node has nowhere to go -- the first parent it accepts. `null` means top-level (only `section`). */
export function requiredParentKind(kind: Node['kind']): ContainerKind | null {
  return acceptedParentKinds(kind)?.[0] ?? null;
}

function pathTo(nodes: Node[], id: string, trail: Node[] = []): Node[] | null {
  for (const n of nodes) {
    if (n.id === id) return [...trail, n];
    if (n.children) {
      const found = pathTo(n.children, id, [...trail, n]);
      if (found) return found;
    }
  }
  return null;
}

/** The node with this id, searched depth-first, or `undefined` if it isn't in the tree. */
export function findNode(doc: Doc, id: string): Node | undefined {
  return pathTo(doc.nodes, id)?.at(-1);
}

/** Ancestors of `id`, root-first, excluding the node itself -- the breadcrumb's raw material (decision 3). Empty if `id` isn't found. */
export function ancestorsOf(doc: Doc, id: string): Node[] {
  const path = pathTo(doc.nodes, id);
  return path ? path.slice(0, -1) : [];
}

function replaceNode(nodes: Node[], id: string, update: (n: Node) => Node): Node[] {
  return nodes.map((n) => {
    if (n.id === id) return update(n);
    if (n.children) return { ...n, children: replaceNode(n.children, id, update) };
    return n;
  });
}

/**
 * Insert `node` respecting the launch nesting rule -- section takes row,
 * row takes column, column takes a leaf. `targetId` is where the user's
 * selection currently is; if it (or its nearest ancestor) isn't a valid
 * parent for `node`'s kind, this wraps `node` one level up and retries,
 * building exactly the missing chain (spec: "chèn lá thẳng vào section thì
 * tự bọc một row/column một cột", generalised to every kind and to no
 * selection at all).
 */
/** Which side of the block under the cursor a drop lands on. */
export type DropEdge = 'before' | 'after';

/**
 * The index, among `siblings`, of the child of the container that the drop
 * target sits inside (or is). -1 when there is no such child, which is the
 * honest answer in two cases: the target IS the container, and the target is
 * not in the document at all. Both mean "no sibling to sit beside", and both
 * fall back to appending.
 */
function siblingIndexFor(siblings: readonly Node[], path: readonly Node[] | null, containerId: string | null): number {
  if (!path) return -1;
  const containerAt = containerId === null ? -1 : path.findIndex((n) => n.id === containerId);
  const child = path[containerAt + 1];
  return child ? siblings.findIndex((n) => n.id === child.id) : -1;
}

function spliceBeside(siblings: readonly Node[], index: number, node: Node, edge: DropEdge): Node[] {
  const at = edge === 'before' ? index : index + 1;
  return [...siblings.slice(0, at), node, ...siblings.slice(at)];
}

/**
 * Where a drop will land, resolved once so the canvas and the model cannot
 * disagree about it.
 *
 * They did disagree, and visibly. The indicator drew its line beside the leaf
 * under the cursor; `insertNode` resolved a CONTAINER of the required kind and
 * inserted there. For a leaf those are the same place, which is why it looked
 * right. For a Row dropped on a text leaf they are two levels apart --
 * measured on the running app: the line appeared inside the leaf's Column and
 * the Row landed beside that Column's Row. A Section dropped on a leaf drew a
 * line inside a Column and went to the top of the document.
 *
 * Two independent calculations of "where does this go" cannot be kept in step
 * by being careful. So there is one, and both callers read it.
 *
 * `at: 'beside'` names an EXISTING node to sit next to, which is what the
 * indicator needs to position itself; `at: 'end'` names the container it will
 * be appended to (`containerId: null` meaning the document root), which is
 * what the indicator needs in order to draw at the foot of that container
 * instead of pretending to a precision the drop does not have.
 */
export type InsertPlan =
  | { at: 'beside'; containerId: string | null; index: number; edge: DropEdge; anchorId: string }
  | { at: 'end'; containerId: string | null };

export function planInsert(doc: Doc, targetId: string | null, kind: Node['kind'], edge?: DropEdge): InsertPlan {
  const accepted = acceptedParentKinds(kind);
  const required = requiredParentKind(kind);
  const path = targetId ? pathTo(doc.nodes, targetId) : null;

  // A section has no required parent, so its siblings are the document's own
  // top-level nodes and the "container" is the root itself.
  if (required === null) {
    const index = edge ? siblingIndexFor(doc.nodes, path, null) : -1;
    return index === -1
      ? { at: 'end', containerId: null }
      : { at: 'beside', containerId: null, index, edge: edge!, anchorId: doc.nodes[index]!.id };
  }

  // Nearest accepted container walking OUT from the target, so a Row dropped on
  // a Column lands in that Column rather than climbing past it to the Section.
  const container = path ? [...path].reverse().find((n) => accepted!.includes(n.kind as ContainerKind)) : undefined;
  if (container) {
    const children = container.children ?? [];
    const index = edge ? siblingIndexFor(children, path, container.id) : -1;
    return index === -1
      ? { at: 'end', containerId: container.id }
      : { at: 'beside', containerId: container.id, index, edge: edge!, anchorId: children[index]!.id };
  }

  // No container of the required kind on the path, so one gets created. What
  // the reader will see is the WRAPPER arriving, so the plan is resolved for
  // the wrapper's own kind rather than for the node inside it.
  return planInsert(doc, targetId, required, edge);
}

/**
 * `edge` is what makes a drop's POSITION mean something. Without it this
 * resolved a container from `targetId` and pushed onto the end of it, so
 * dropping on the first, middle or last child of a column produced the
 * identical document -- measured, all three gave `[a, b, c, new]`.
 *
 * Omitting `edge` keeps the append behaviour, which is what the panel's
 * click-to-insert path wants: there is no cursor, so there is no side.
 *
 * The placement itself comes from `planInsert`, not from a second copy of the
 * same walk -- see the note there for what a second copy cost.
 */
export function insertNode(doc: Doc, targetId: string | null, node: Node, edge?: DropEdge): Doc {
  const plan = planInsert(doc, targetId, node.kind, edge);
  const required = requiredParentKind(node.kind);

  // The plan resolved against a container the node cannot sit in directly:
  // wrap it and re-plan for the wrapper, exactly as before.
  const accepted = acceptedParentKinds(node.kind);
  if (required !== null) {
    const container = plan.containerId === null ? undefined : findNode(doc, plan.containerId);
    if (!container || !accepted!.includes(container.kind as ContainerKind)) {
      // Built by the catalog, so a container the author never asked for still
      // carries the same defaults as one they insert themselves. Minting it
      // inline gave a padding-less Column beside an 18px one in the same
      // document.
      const entry = BLOCK_CATALOG.find((candidate) => candidate.kind === required);
      const wrapped: Node = { ...(entry ? entry.createNode() : { id: crypto.randomUUID(), kind: required, visible: true }), children: [node] };
      return insertNode(doc, targetId, wrapped, edge);
    }
  }

  const place = (siblings: readonly Node[]): Node[] =>
    plan.at === 'end' ? [...siblings, node] : spliceBeside(siblings, plan.index, node, plan.edge);

  if (plan.containerId === null) return { ...doc, nodes: place(doc.nodes) };
  return { ...doc, nodes: replaceNode(doc.nodes, plan.containerId, (n) => ({ ...n, children: place(n.children ?? []) })) };
}

/**
 * Where a click with nothing selected should put a block.
 *
 * Passing `null` straight to `insertNode` sends it down the wrap-and-recurse
 * path, which builds a fresh Section, Row and Column every time -- measured,
 * two clicks produced two separate one-block sections. The prototype resolves
 * an existing column instead (`columnForTarget` -> `firstColumn`).
 *
 * This takes the LAST container of the required kind rather than the first.
 * "Thêm khối" means add to what I have, and putting a block silently at the top
 * of a long email is worse than either alternative. Returns `null` when the
 * document has no such container yet, which leaves the wrapping path to build
 * one -- the empty-canvas case, where creating a Section is exactly right.
 *
 * Deliberately not used for a drop on the bare canvas: that is the one place
 * that means "outside everything", and the prototype's `dropRoot` makes a new
 * Section there for the same reason.
 */
export function defaultInsertTarget(doc: Doc, kind: Node['kind']): string | null {
  const required = requiredParentKind(kind);
  if (required === null) return null;
  let found: string | null = null;
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (node.kind === required) found = node.id;
      if (node.children) walk(node.children);
    }
  };
  walk(doc.nodes);
  return found;
}

/**
 * What an insert is about to do, in terms the author can be told.
 *
 * `insertNode` will build a Section, a Row and a Column to hold one text block
 * if it has to. That is the right behaviour -- refusing would mean a click on
 * an empty canvas does nothing -- but doing it silently is why "chèn xong
 * không biết nó đi đâu" was a fair complaint. `wraps` is the difference
 * between "it went into the column you had selected" and "it went into a new
 * block at the end", which are the two sentences worth saying.
 *
 * `containerKind: null` means the document root: either a Section, which lives
 * there, or a leaf on an empty canvas that is about to get a whole chain built
 * for it (`wraps: true` says which).
 */
export type InsertDestination = { containerKind: Node['kind'] | null; wraps: boolean };

export function describeInsert(doc: Doc, targetId: string | null, kind: Node['kind']): InsertDestination {
  const required = requiredParentKind(kind);
  const plan = planInsert(doc, targetId, kind);
  const container = plan.containerId === null ? null : findNode(doc, plan.containerId) ?? null;
  const containerKind = container ? container.kind : null;
  // The plan resolves through whatever wrapping `insertNode` will do, so the
  // container it lands on is the wrapper's parent, not the node's own. When
  // those differ, containers are about to be created.
  // "Wraps" means containers are about to be BUILT -- so it has to ask whether
  // the resolved container accepts this kind, not whether it is the one kind
  // `insertNode` would create. A Row landing in a Column accepts directly, and
  // reporting that as wrapping would have the toast announce a Section that
  // never appears.
  const wraps = required !== null && (containerKind === null || !acceptedParentKinds(kind)!.includes(containerKind as ContainerKind));
  return { containerKind, wraps };
}

/** True when `id` is `root` or sits anywhere beneath it. The guard that stops a container being dropped into its own subtree, which would detach that subtree from the document entirely. */
function subtreeContains(root: Node, id: string): boolean {
  if (root.id === id) return true;
  return (root.children ?? []).some((child) => subtreeContains(child, id));
}

/**
 * Moves a node that is already on the canvas to a new position, the drag half
 * the port never carried.
 *
 * The prototype makes every leaf a drag source and moves it on drop
 * (`studio.tsx:822`); EOW had one draggable element in the whole builder -- the
 * palette button -- so a block, once placed, could only be nudged with the
 * inspector's up/down pair.
 *
 * Two refusals, both returning `doc` unchanged so the caller can tell nothing
 * happened: onto itself, and into its own subtree. The second is not
 * defensive tidiness -- `removeNode` then `insertNode` with a target inside the
 * removed subtree would insert into a tree that is no longer attached, and the
 * node would vanish from the document.
 *
 * The plan is computed AFTER the removal on purpose. Moving a node down past
 * its own old slot shifts every index behind it, and planning first puts it one
 * place too high -- which is the classic off-by-one in every reorder, and has
 * its own test.
 */
export function moveNodeTo(doc: Doc, nodeId: string, targetId: string, edge?: DropEdge): Doc {
  if (nodeId === targetId) return doc;
  const moving = findNode(doc, nodeId);
  if (!moving || !findNode(doc, targetId)) return doc;
  if (subtreeContains(moving, targetId)) return doc;

  const detached = removeNode(doc, nodeId);
  return insertNode(detached, targetId, moving, edge);
}

/**
 * A structural copy with every id regenerated, used when a saved reusable block
 * is inserted (MC-UI-004). Without it, inserting the same library block twice
 * puts two nodes with one id in the tree, and every id-keyed operation --
 * selection, `findNode`, `updateNode`, `removeNode`, the Structure tree's
 * expand set -- would then act on both at once or on the wrong one.
 *
 * `social[].id` is regenerated too: it is the only other id the model carries,
 * and the inspector keys its rows off it.
 */
export function withFreshIds(node: Node): Node {
  const copy: Node = { ...node, id: crypto.randomUUID() };
  if (node.children) copy.children = node.children.map(withFreshIds);
  if (node.social) copy.social = node.social.map((link) => ({ ...link, id: crypto.randomUUID() }));
  return copy;
}

/** Removes the node with this id, wherever it sits in the tree. No-op (same shape) if it isn't found. Sibling widths are left alone: `studio.tsx` never redistributes them either, and the Inspector's six ratio presets are where a row is re-divided. */
export function removeNode(doc: Doc, id: string): Doc {
  function remove(nodes: Node[]): Node[] {
    return nodes.filter((n) => n.id !== id).map((n) => (n.children ? { ...n, children: remove(n.children) } : n));
  }
  return { ...doc, nodes: remove(doc.nodes) };
}

/** Swaps the node with this id with its previous (`'up'`) or next (`'down'`) sibling. Returns `doc` unchanged (same reference) if the node is missing or already at that edge. */
export function moveNode(doc: Doc, id: string, direction: 'up' | 'down'): Doc {
  function moveWithin(nodes: Node[]): Node[] {
    const index = nodes.findIndex((n) => n.id === id);
    if (index !== -1) {
      const swapWith = direction === 'up' ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= nodes.length) return nodes;
      const next = [...nodes];
      [next[index], next[swapWith]] = [next[swapWith]!, next[index]!];
      return next;
    }
    let changed = false;
    const next = nodes.map((n) => {
      if (!n.children) return n;
      const movedChildren = moveWithin(n.children);
      if (movedChildren === n.children) return n;
      changed = true;
      return { ...n, children: movedChildren };
    });
    return changed ? next : nodes;
  }
  const nextNodes = moveWithin(doc.nodes);
  return nextNodes === doc.nodes ? doc : { ...doc, nodes: nextNodes };
}

/** Merges `patch` into the node with this id. No-op if it isn't found. */
export function updateNode(doc: Doc, id: string, patch: Partial<Node>): Doc {
  if (!findNode(doc, id)) return doc;
  return { ...doc, nodes: replaceNode(doc.nodes, id, (n) => ({ ...n, ...patch })) };
}

/**
 * MC-UI-005 `bind` and `mark_decorative` (S6 Task 39).
 *
 * ADR-043 §7 keeps both off the `AssetProvider` port: they change the document,
 * and a second route into the model is what spec §2.13 exists to prevent. They
 * live here with the other structural rules and reach the UI through the
 * engine, like every other edit.
 */

/**
 * Points an image node at an asset URL.
 *
 * Absolute `https:` only. Task 32 measured the sanitizer against the real
 * thing: `http:`, `data:`, a protocol-relative `//host/...` and a root-relative
 * `/api/v1/assets/...` on our own origin are all stripped, so binding one would
 * manufacture the exact `missing_assets` state the panel reports. Library URLs
 * are always absolute https, so this only ever refuses a mistake.
 *
 * Returns `doc` unchanged (same reference) when the node is missing, cannot
 * carry an image, or the URL is unusable.
 */
export function bindAsset(doc: Doc, id: string, src: string): Doc {
  const node = findNode(doc, id);
  if (!node || !(IMAGE_BEARING_KINDS as readonly Node['kind'][]).includes(node.kind)) return doc;
  const trimmed = src.trim();
  if (!trimmed.startsWith('https:')) return doc;
  return updateNode(doc, id, { src: trimmed });
}

/**
 * Flags an image as decorative, or clears the flag.
 *
 * Clearing deletes the key instead of storing `decorative: false`, so
 * `projectData` does not grow a false on every image anyone ever toggled. The
 * written `alt` is never touched: the emitter decides what to emit, so
 * unmarking restores the words rather than losing them.
 */
export function markDecorative(doc: Doc, id: string, decorative: boolean): Doc {
  const node = findNode(doc, id);
  if (!node || !(IMAGE_BEARING_KINDS as readonly Node['kind'][]).includes(node.kind)) return doc;
  if (decorative) return updateNode(doc, id, { decorative: true });
  return { ...doc, nodes: replaceNode(doc.nodes, id, ({ decorative: _dropped, ...rest }) => rest) };
}

