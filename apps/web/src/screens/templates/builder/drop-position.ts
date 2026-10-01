import type { DropEdge } from './tree-ops.js';

/**
 * Which side of a block the pointer is asking for: above its middle means the
 * dragged block goes before it, below means after.
 *
 * A pure function of two numbers rather than a DOM read inside the drag
 * handler, because this is the one part of the drop that has a right and a
 * wrong answer and it is worth being able to test at the midpoint and at the
 * edges without a browser.
 *
 * The exact midpoint resolves to `after` rather than being treated as a
 * separate case: a comparison that changed answer on equality would flicker the
 * insertion line at the one pointer position a user can hold still on.
 */
export function dropEdge(pointerY: number, box: { top: number; height: number }): DropEdge {
  return pointerY < box.top + box.height / 2 ? 'before' : 'after';
}
