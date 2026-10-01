import type { Asset } from '../../../api/assets.js';
import { IMAGE_BEARING_KINDS, type Doc, type Node } from './document.js';

/**
 * The rule-bearing half of MC-UI-005, kept out of the component for the reason
 * spec §2.1 gives: web has no component-render test, so anything with a rule in
 * it has to live somewhere unit-testable.
 */

/** Why a node counts as missing its image. Two causes, one list -- both end with the picture absent from the delivered email. */
export type MissingAssetReason = 'unbound' | 'not_https';

export type MissingAsset = { id: string; kind: Node['kind']; reason: MissingAssetReason; src: string | null };

/**
 * Task 32 measured this against the real sanitizer: `^https:` is the whole
 * test. `http:`, `data:`, a protocol-relative `//host/...` and even a
 * root-relative `/api/v1/assets/...` on our own origin are all stripped, so an
 * image carrying one of those is a broken image in mail nobody can edit any
 * more.
 */
function isServableImageSource(src: string): boolean {
  return src.startsWith('https:');
}

/**
 * `image` and `banner` emit nothing at all without a `src` (`emitter.ts`
 * returns an empty string), so the node is visible on the canvas and absent
 * from the email -- exactly the failure spec §1.3 calls a design error rather
 * than an implementation one. `logo` is deliberately not in this list: it falls
 * back to a real text wordmark, so nothing goes missing.
 */
const DROPPED_WITHOUT_SOURCE: ReadonlyArray<Node['kind']> = ['image', 'banner'];

/**
 * The `missing_assets` state, in document order.
 *
 * ADR-043 defines the concept once for MC-UI-005 and MC-UI-006 alike: an image
 * pointing at a URL that cannot be served. Listing only, never repair -- the
 * same rule S7 Task 45 applies to the import report.
 */
export function missingAssetNodes(doc: Doc): MissingAsset[] {
  const found: MissingAsset[] = [];

  function walk(nodes: readonly Node[]): void {
    for (const node of nodes) {
      const src = node.src?.trim() ?? '';
      if ((IMAGE_BEARING_KINDS as readonly Node['kind'][]).includes(node.kind)) {
        if (src.length === 0) {
          if (DROPPED_WITHOUT_SOURCE.includes(node.kind)) found.push({ id: node.id, kind: node.kind, reason: 'unbound', src: null });
        } else if (!isServableImageSource(src)) {
          found.push({ id: node.id, kind: node.kind, reason: 'not_https', src });
        }
      }
      if (node.children) walk(node.children);
    }
  }

  walk(doc.nodes);
  return found;
}

/** Vietnamese decimal comma, matching how the rest of the UI writes numbers. */
export function assetSizeLabel(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  const kb = byteSize / 1024;
  if (kb < 1024) return `${kb.toFixed(1).replace('.', ',')} KB`;
  return `${(kb / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Attribution only -- everyone with `content:manage` may replace or archive any asset in the tenant. */
export function assetUploaderLabel(asset: Asset): string {
  return asset.createdByName?.trim() || 'Không rõ người tải lên';
}
