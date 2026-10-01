import type { EmailTemplateSummary, TemplateStatus } from '../../../api/templates.js';
import { foldVietnamese } from './reusable-blocks.js';

/**
 * The "Kho mẫu" rail destination's data (ADR-044 Task SV-2, decision 1).
 *
 * `studio.tsx`'s `TemplateLibrary` filters a hard-coded `templatePresets`
 * array by an `hr | internal | event` category. EOW has no such field, and
 * decision 1 is explicit that a rail entry must reach what the product
 * already has rather than grow a parallel one -- so the panel lists the
 * tenant's own templates through `listTemplates`, and filters them by the
 * only axis `TemplateQuery` carries: status.
 *
 * That is a divergence in the *data*, not in the DOM: `v3-library-filters`,
 * `v3-template-grid`, `v3-template-thumb`, `v3-template-copy` and
 * `v3-template-empty` are all ported as the prototype writes them.
 */

export type TemplateLibraryFilter = 'all' | Extract<TemplateStatus, 'draft' | 'published'>;

export const TEMPLATE_LIBRARY_FILTERS: ReadonlyArray<{ id: TemplateLibraryFilter; label: string }> = [
  { id: 'all', label: 'Tất cả' },
  { id: 'draft', label: 'Nháp' },
  { id: 'published', label: 'Đã xuất bản' },
];

/**
 * Archived templates never appear, under any filter. "Lưu trữ" means out of
 * the active library (TemplatesScreen's own archive overlay says so), and a
 * starting point nobody may start from is worse than one fewer card.
 */
export function filterLibraryTemplates(
  items: ReadonlyArray<EmailTemplateSummary>,
  filter: TemplateLibraryFilter,
  query: string,
): EmailTemplateSummary[] {
  const needle = foldVietnamese(query);
  return items.filter((item) => item.status !== 'archived'
    && (filter === 'all' || item.status === filter)
    && (needle.length === 0 || foldVietnamese(item.name).includes(needle)));
}

/**
 * `studio.css` styles exactly four thumbnail tones
 * (`.v3-template-thumb.sage/.sand/.blue/.plum`); the prototype's presets carry
 * one each by hand. Real templates have no tone, so it is derived from the id
 * -- deterministically, or a card would change colour on every re-render and
 * the grid would flicker while someone reads it.
 */
const THUMB_TONES = ['sage', 'sand', 'blue', 'plum'] as const;

export function templateThumbTone(id: string): (typeof THUMB_TONES)[number] {
  let sum = 0;
  for (let index = 0; index < id.length; index += 1) sum = (sum + id.charCodeAt(index)) % THUMB_TONES.length;
  return THUMB_TONES[sum]!;
}
