/**
 * BR-TPL-012 (docs/superpowers/specs/2026-08-31-mailcraft-builder-screen-design.md:365):
 * a campaign's pinned templateVersionId must never change on its own -- a
 * sent campaign has to trace back to the exact immutable version it
 * rendered from. This module only ever answers "is a newer version
 * available"; it never picks one. ComposeDraftScreen decides whether to
 * offer the prompt at all (only while the draft is still editable) and,
 * when the user clicks it, switches through the same change({
 * templateVersionId }) path TemplatePickerOverlay already uses -- there is
 * no second write path here.
 */
export type TemplateVersionRef = { id: string; version: number };

export type VersionUpdatePrompt =
  | { available: false }
  | { available: true; latest: TemplateVersionRef };

/** Highest `version` number in the list, independent of input order. Null for an empty list (e.g. an archived template with no versions left). */
export function pickLatestVersion<T extends TemplateVersionRef>(versions: readonly T[]): T | null {
  return versions.reduce<T | null>((latest, item) => (!latest || item.version > latest.version ? item : latest), null);
}

export function computeVersionUpdatePrompt(pinnedVersionId: string, versions: readonly TemplateVersionRef[]): VersionUpdatePrompt {
  const latest = pickLatestVersion(versions);
  if (!latest || latest.id === pinnedVersionId) return { available: false };
  return { available: true, latest };
}
