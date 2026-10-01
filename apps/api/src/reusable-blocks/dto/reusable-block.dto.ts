import { z } from 'zod';

/**
 * The saved subtree. The API deliberately does NOT validate its shape beyond
 * "a non-null object": `node` is the builder's own document model and the API
 * never learns it (ADR-019, and the same contract `project_data` carries).
 * Teaching the server the block schema would put a second, drifting copy of
 * `document.ts` in `apps/api`, and every new block kind would need a backend
 * release before it could be saved.
 *
 * What IS checked is that a block is usable at all: a tree must have a `kind`,
 * because a node without one can never be inserted back onto the canvas, and
 * storing it would be storing a row that can only fail later.
 */
const reusableBlockNode = z.object({ kind: z.string().trim().min(1) }).passthrough();

export const createReusableBlockSchema = z.object({
  name: z.string().trim().min(1).max(120),
  node: reusableBlockNode,
}).strict();

/** Rename only. The tree is immutable once saved: re-saving a changed tree is a new block, which keeps a template's inserted copy and the library entry from silently diverging in meaning. */
export const updateReusableBlockSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();

export type CreateReusableBlockDto = z.infer<typeof createReusableBlockSchema>;
export type UpdateReusableBlockDto = z.infer<typeof updateReusableBlockSchema>;
