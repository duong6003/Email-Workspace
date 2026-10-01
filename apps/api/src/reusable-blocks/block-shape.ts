/**
 * Two numbers the block library's row preview needs (ADR-044 Task SV-4,
 * MC-UI-004): how many columns to draw, and how many elements the block holds.
 *
 * Derived from the tree the listing is already projecting, so it costs no
 * extra query and no extra round trip. `node` itself stays out of the listing
 * -- ADR-035's projection is about payload size, and two integers are not a
 * tree.
 *
 * Everything here is defensive because `reusable_block.node` is untyped JSON
 * that this service deliberately never parses (ADR-035): the builder writes it
 * and the builder reads it back. A listing must not fail over a preview, so a
 * shape this cannot read yields the neutral answer rather than throwing.
 */

/** studio.tsx draws at most four bars; past that the strip is unreadable and the exact number is not what anyone is scanning for. */
const MAX_PREVIEW_COLUMNS = 4;

/** The three kinds that only ever hold other nodes. Anything else is something a reader can see, so it counts as an element. */
const CONTAINER_KINDS = new Set(['section', 'row', 'column']);

function childrenOf(node: unknown): unknown[] {
  if (typeof node !== 'object' || node === null) return [];
  const children = (node as { children?: unknown }).children;
  return Array.isArray(children) ? children : [];
}

function isContainer(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const kind = (node as { kind?: unknown }).kind;
  return typeof kind === 'string' && CONTAINER_KINDS.has(kind);
}

function countElements(node: unknown): number {
  if (typeof node !== 'object' || node === null) return 0;
  if (!isContainer(node)) return 1;
  return childrenOf(node).reduce<number>((total, child) => total + countElements(child), 0);
}

export function blockShape(node: unknown): { columns: number; elements: number } {
  const children = childrenOf(node);
  // A saved Column, or a bare leaf, is one column: a preview with no bars at
  // all reads as a broken row rather than as a simple block.
  const columns = Math.max(1, Math.min(MAX_PREVIEW_COLUMNS, children.length || 1));
  return { columns, elements: countElements(node) };
}
