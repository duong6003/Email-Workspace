import type { Asset, AssetKind } from '../../api/assets.js';
import type { DropEdge } from './builder/tree-ops.js';
import type { EmailTemplate, TemplateAnalysis, TemplatePatch, TemplatePreview, TemplateVariableCatalogueItem } from '../../api/templates.js';

/**
 * The seam between the template editor screen and whatever authoring system is
 * behind it. Today there is exactly one implementation -- the imported-HTML
 * surface built directly on `api/templates.ts` -- but `email_template.origin`
 * already distinguishes `'imported'` from `'builder'`, and the builder will
 * need its own content store and preview without the screen learning about it.
 *
 * Only the four services this screen actually calls are declared. An asset
 * provider or a block library would be speculation until a caller exists --
 * which stopped being true at S6: `AssetProvider` is below, with a caller.
 */
export type VariableProvider = { list: () => Promise<readonly TemplateVariableCatalogueItem[]> };
export type PreviewService = { render: (input: { mergeData: Record<string, string> }) => Promise<TemplatePreview> };
export type LintService = { check: (input: { subject: string; html: string; textBody: string }) => Promise<TemplateAnalysis> };
/** `save` carries the revision it expects to overwrite; the transport turns it into `If-Match` and a 412 means someone else moved first. */
export type ContentStore = {
  load: () => Promise<EmailTemplate>;
  save: (input: TemplatePatch & { draftRevision: number }) => Promise<EmailTemplate>;
  publish: () => Promise<{ version: number }>;
};

/** The whole set, bundled so a second authoring system swaps one object rather than four props. */
export type TemplateEditorPorts = { variables: VariableProvider; preview: PreviewService; lint: LintService; content: ContentStore };

/**
 * S2 (ADR-039): wraps our own document model + emitter -- there is no GrapesJS
 * and never will be a second implementation of this shape, but the seam still
 * exists so a builder screen calls it rather than importing `document.ts` or
 * `emitter.ts` directly (spec §2.13). Every method stays primitive or
 * `unknown` on purpose: nothing outside `screens/templates/builder/` needs to
 * know what a `Doc`/`Node` looks like. Signature source:
 * `docs/frontend/mailcraft-integration-requirements.md` §3.
 */
export type EmailEditorEngine = {
  loadHtml: (html: string) => Promise<void>;
  /** Always derived from the current model -- never a cached/raw string (spec §1.3: `projectData` is what Mailcraft owns, `draftHtml` is what it produces). */
  getHtml: () => Promise<string>;
  loadProjectData: (data: unknown) => Promise<void>;
  getProjectData: () => Promise<unknown>;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  setDevice: (device: 'desktop' | 'mobile') => void;
  /** `targetId` is the currently selected node (S4 Task 16); omitted/`null` inserts at the document root. Nesting is resolved by `tree-ops.insertNode` -- a leaf dropped somewhere that needs a row/column wraps automatically. */
  /**
   * `edge` is the side of `targetId` the block lands on. Omitted means "append
   * to the resolved container", which is what click-to-insert wants: a click
   * has no cursor position on a block, so it has no side.
   */
  addBlock: (blockId: string, targetId?: string | null, edge?: DropEdge) => string;
  /**
   * Inserts a whole saved subtree (MC-UI-004 `insert`), not a catalog kind.
   * Separate from `addBlock` because the two take different things -- a kind
   * the engine builds, versus a tree the caller already holds -- and because
   * this one owes the caller fresh ids, which `addBlock` never has to think
   * about. Components never touch the model directly (spec §2.13), so this is
   * the only way a library block reaches the canvas.
   */
  insertSubtree: (node: unknown, targetId?: string | null, edge?: DropEdge) => string;
  /**
   * Moves a node already on the canvas next to `targetId` (ADR-044, the drag
   * half of the prototype's canvas). Refuses -- leaving the document and the
   * history untouched -- when the node is dropped on itself or into its own
   * subtree.
   */
  moveBlockTo: (nodeId: string, targetId: string, edge?: DropEdge) => void;
  /**
   * Swaps the entire document for another one, as an undoable step (ADR-044
   * Task SV-2: the "Kho mẫu" rail destination starting a draft from an
   * existing template). Deliberately not `loadProjectData`, which resets
   * history -- that is right when the screen mounts and wrong for a button
   * someone presses to try a template out, because it would throw the current
   * canvas away with nothing to undo.
   */
  replaceDocument: (data: unknown) => void;
  /** The inspector's "di chuyển/xoá" buttons (S4 Task 17, decision 2's keyboard-equivalent for drag reordering). No-op if `id` is missing or already at that edge. */
  removeBlock: (id: string) => void;
  moveBlock: (id: string, direction: 'up' | 'down') => void;
  /** Merges `patch` into one node (S4 Task 18). `Record<string, unknown>`, not `Partial<Node>`, to keep the port's shape opaque outside `builder/` (spec §2.13). */
  updateNode: (id: string, patch: Record<string, unknown>) => void;
  /**
   * MC-UI-005 `bind` and `mark_decorative` (S6 Task 39). Deliberately here and
   * not on `AssetProvider`: both change the document, and ADR-043 §7 refuses to
   * give the UI a second route into the model. They are separate from
   * `updateNode` because each carries a rule -- `bindAsset` accepts only
   * absolute https (Task 32 measured that the sanitizer strips everything
   * else), and both refuse a node kind that has no image to describe.
   */
  /** Returns false when the operation refused -- an unknown id, a kind with no image, or a source the sanitizer would strip. The caller has to be able to say so: a bind that quietly does nothing is the silent failure this whole slice exists to remove. */
  bindAsset: (id: string, src: string) => boolean;
  markDecorative: (id: string, decorative: boolean) => void;
  /** Same for the document-level theme (S4 Task 18: width/outer bg/content bg/font/base size). */
  updateTheme: (patch: Record<string, unknown>) => void;
  on: (event: 'change' | 'select', handler: (payload: unknown) => void) => () => void;
};

/**
 * S6 (ADR-043 §7): the sixth port, and the one spec §1.4 listed as
 * "deliberately deferred" -- there was no asset store to put behind it. There
 * is now, so the seam closes the set.
 *
 * The row type is the contract's `Asset`, not a narrower restatement. ADR-043
 * §7 sketched seven fields; the served resource also carries uploader
 * attribution and `archivedAt`, and the library panel shows both. Restating a
 * subset here would only mean a second place to keep in step with the contract.
 *
 * `bind` and `mark_decorative` are absent on purpose, and that absence is the
 * design: they change the document (a node's `src`, a node's decorative flag),
 * so they belong to `tree-ops.ts`. Putting them here would give the UI a second
 * route into the model, which spec §2.13 exists to prevent.
 */
export type AssetProvider = {
  /** Live assets only. An archived asset is gone from the library and still served (ADR-043 §5). */
  list: () => Promise<readonly Asset[]>;
  upload: (file: File, kind?: AssetKind) => Promise<Asset>;
  /** Returns a new asset and archives the old one; it never overwrites stored bytes, because a published version still points at the old URL (ADR-043 §7). Callers rebind to what comes back. */
  replace: (assetId: string, file: File) => Promise<Asset>;
  archive: (assetId: string) => Promise<void>;
  /**
   * ADR-044 Task SV-4: reclassify logo/image. The one mutable field on an
   * asset -- no bytes move and no id is minted, so unlike `replace` this does
   * not disturb anything already published.
   */
  setKind: (assetId: string, kind: AssetKind) => Promise<Asset>;
};

export type { Asset, AssetKind };

/** The one factory that builds `EmailEditorEngine`, re-exported here so a builder screen (S3) has a single import site for the port and its implementation, and never reaches into `./builder/` directly. */
export { createEmailEditorEngine } from './builder/engine.js';
