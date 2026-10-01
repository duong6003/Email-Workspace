/**
 * MC-UI-006 `missing_assets`, for imported HTML.
 *
 * ADR-043 defines the concept once for MC-UI-005 and MC-UI-006 alike: an image
 * pointing somewhere that cannot be served. **List, never repair** -- the import
 * report tells the author which pictures will not arrive and leaves the choice
 * of what to do about it with them.
 *
 * Read from the HTML the author supplied, not from the sanitized output, for the
 * obvious reason: by the time the API has sanitized it the offending `src` is
 * already gone, so the sanitized copy can only say *how many* went, never
 * *which*. The browser is holding the original either way.
 *
 * The predicate mirrors the API's `isPermittedImageSource`
 * (`template-html-sanitizer.ts`): `https:` or `cid:` survive, everything else is
 * stripped. It is deliberately looser than the builder's rule in
 * `builder/assets.ts`, which accepts `https:` only -- the builder cannot mint a
 * `cid:` reference in the first place, while an imported newsletter legitimately
 * can, and calling that image missing would be a lie.
 */

/** One image that will not reach the inbox, in document order. */
export type MissingImportedImage = { src: string; alt: string | null };

/** `<img ...>` open tags. Attribute order is not fixed, so each tag is searched rather than pattern-matched whole. */
const IMAGE_TAG = /<img\b([^>]*)>/gi;
const ATTRIBUTE = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');

function attribute(tag: string, name: string): string | null {
  const found = ATTRIBUTE(name).exec(tag);
  if (!found) return null;
  return found[1] ?? found[2] ?? found[3] ?? null;
}

/** Matches the API: only these two schemes survive sanitization. */
function survivesSanitizer(src: string): boolean {
  return /^(?:https:|cid:)/i.test(src.trim());
}

/**
 * Every image in the supplied HTML whose source the sanitizer will strip.
 *
 * An `<img>` with no `src` at all is not listed: nothing is being taken away
 * from it, and the author can see an empty image tag without being told.
 * Duplicates are collapsed -- one line per distinct address, because a logo
 * repeated in eight rows is one thing to fix, not eight.
 */
export function missingImportedImages(html: string): MissingImportedImage[] {
  const found = new Map<string, MissingImportedImage>();

  for (const tag of html.matchAll(IMAGE_TAG)) {
    const src = attribute(tag[1], 'src')?.trim();
    if (!src || survivesSanitizer(src)) continue;
    if (!found.has(src)) found.set(src, { src, alt: attribute(tag[1], 'alt') });
  }

  return [...found.values()];
}
