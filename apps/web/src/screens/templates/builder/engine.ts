import { defaultTheme, type Doc, type History, type Node } from './document.js';
import { emitDoc } from './emitter.js';
import { BLOCK_CATALOG, INSERT_PANEL } from './blocks.js';
import { bindAsset, insertNode, markDecorative, moveNode, moveNodeTo, removeNode, updateNode, withFreshIds, type DropEdge } from './tree-ops.js';
import type { EmailEditorEngine } from '../editor-ports.js';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let seq = 0;
const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++seq}`;

/** Fallback for a `blockId` the launch catalog (`blocks.ts`) doesn't carry -- the emitter still supports 5 more kinds (S4 decision 1) that S4's UI never offers, so this keeps `addBlock` total rather than throwing on them. */
function blankNode(blockId: string): Node {
  return { id: uid(blockId), kind: blockId as Node['kind'], visible: true, content: '', align: 'left' };
}

/**
 * Implements `EmailEditorEngine` on top of `document.ts` + `emitter.ts`.
 * `undo`/`redo` keep the prototype's `past`/`present`/`future` shape
 * (studio.tsx) rather than reinventing history management -- it already
 * works there.
 */
export function createEmailEditorEngine(initial: Doc): EmailEditorEngine {
  let history: History = { past: [], present: clone(initial), future: [] };
  const listeners: Record<'change' | 'select', Set<(payload: unknown) => void>> = { change: new Set(), select: new Set() };

  const notifyChange = (): void => { for (const handler of listeners.change) handler(history.present); };

  const commit = (next: Doc): void => {
    history = { past: [...history.past, history.present], present: next, future: [] };
    notifyChange();
  };

  return {
    // HTML canonical stays one-directional (ADR-019, ADR-037 §3): the builder
    // never reconstructs a component tree from HTML, so there is nothing for
    // this to parse. It exists to satisfy the port shape.
    loadHtml: async () => {},

    getHtml: async () => emitDoc(history.present),

    loadProjectData: async (data: unknown) => {
      history = { past: [], present: clone(data as Doc), future: [] };
      notifyChange();
    },

    getProjectData: async () => clone(history.present),

    undo: () => {
      if (!history.past.length) return;
      const previous = history.past[history.past.length - 1]!;
      history = { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
      notifyChange();
    },

    redo: () => {
      if (!history.future.length) return;
      const next = history.future[0]!;
      history = { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
      notifyChange();
    },

    canUndo: () => history.past.length > 0,
    canRedo: () => history.future.length > 0,

    // Device is a canvas-rendering concern only (S3/S4); the emitter is
    // fluid/hybrid and produces the same HTML regardless (ADR-037 §2).
    setDevice: () => {},

    // Returns the id so the caller can select what it just created -- the
    // prototype's `finishAdd` does the same, and without it an insert leaves
    // the inspector empty and the author hunting for the block.
    addBlock: (blockId: string, targetId: string | null = null, edge?: DropEdge) => {
      // `INSERT_PANEL` first: six of its items are layout presets that all
      // build a `row`, so they can only be addressed by id. Its ids are the
      // catalog's kinds for every other item, which is why the existing
      // `addBlock('text')` callers keep resolving.
      const item = INSERT_PANEL.find((entry) => entry.id === blockId)
        ?? BLOCK_CATALOG.find((entry) => entry.kind === blockId);
      const node = item ? item.createNode() : blankNode(blockId);
      commit(insertNode(history.present, targetId, node, edge));
      return node.id;
    },

    // `withFreshIds` is applied here rather than at the call site so no caller
    // can forget it: inserting one library block twice would otherwise put two
    // nodes with the same id in the tree, and every id-keyed operation would
    // then hit the wrong one.
    insertSubtree: (node: unknown, targetId: string | null = null, edge?: DropEdge) => {
      // `withFreshIds` runs first and its result is what goes in, so the id
      // handed back is the one now in the document -- never the saved block's.
      const fresh = withFreshIds(clone(node as Node));
      commit(insertNode(history.present, targetId, fresh, edge));
      return fresh.id;
    },

    // A refused move must not land in `past`: undo is for taking back what
    // happened, and pressing it after a drop that did nothing would rewind the
    // edit before it instead -- which reads as the app losing work.
    moveBlockTo: (nodeId: string, targetId: string, edge?: DropEdge) => {
      const next = moveNodeTo(history.present, nodeId, targetId, edge);
      if (next !== history.present) commit(next);
    },

    // Cloned for the same reason `loadProjectData` clones: the caller holds a
    // template summary it will keep rendering in the library panel, and a
    // later `updateNode` must not reach back into it.
    replaceDocument: (data: unknown) => {
      commit(clone(data as Doc));
    },

    removeBlock: (id: string) => {
      commit(removeNode(history.present, id));
    },

    // moveNode/updateNode return the same reference for a no-op (missing id,
    // already at the edge) -- skip the commit so those never push a no-op
    // step onto undo history.
    moveBlock: (id: string, direction: 'up' | 'down') => {
      const next = moveNode(history.present, id, direction);
      if (next !== history.present) commit(next);
    },

    updateNode: (id: string, patch: Record<string, unknown>) => {
      const next = updateNode(history.present, id, patch as Partial<Node>);
      if (next !== history.present) commit(next);
    },

    // Same no-op discipline as moveBlock/updateNode: both tree operations
    // return the same reference when they refuse (unknown id, a kind with no
    // image, a URL the sanitizer would strip), and a refusal must not land on
    // the undo stack as a step that changed nothing.
    bindAsset: (id: string, src: string) => {
      const next = bindAsset(history.present, id, src);
      if (next === history.present) return false;
      commit(next);
      return true;
    },

    markDecorative: (id: string, decorative: boolean) => {
      const next = markDecorative(history.present, id, decorative);
      if (next !== history.present) commit(next);
    },

    updateTheme: (patch: Record<string, unknown>) => {
      commit({ ...history.present, theme: { ...defaultTheme, ...history.present.theme, ...patch } });
    },

    on: (event, handler) => {
      listeners[event].add(handler);
      return () => listeners[event].delete(handler);
    },
  };
}
