import { describe, expect, it } from 'vitest';
import type { EmailTemplateSummary } from '../../../api/templates.js';
import { filterLibraryTemplates, TEMPLATE_LIBRARY_FILTERS, templateThumbTone } from './template-library.js';

const template = (over: Partial<EmailTemplateSummary>): EmailTemplateSummary => ({
  id: 't', name: 'Thư chào mừng', status: 'draft', origin: 'builder', draftRevision: 1,
  subject: '', projectData: null, validation: { warnings: [], errors: [], changes: [] },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', latestVersionId: null,
  ...over,
});

/**
 * ADR-044 Task SV-2, decision 1. The prototype's "Kho mẫu" rail destination
 * filters a hard-coded `templatePresets` array by an hr/internal/event
 * category that EOW has no concept of. Decision 1 says the rail must reach
 * what EOW already has, so the panel lists the tenant's real templates and
 * filters them by the one axis the contract actually carries: status.
 */
describe('template-library (ADR-044 Task SV-2)', () => {
  it('offers the three filters the template contract can answer, not the prototype four', () => {
    // `TemplateQuery.status` is 'draft' | 'published'. There is no category
    // field on EmailTemplateSummary, so hr/internal/event would be a filter
    // over data that does not exist.
    expect(TEMPLATE_LIBRARY_FILTERS.map((f) => f.id)).toEqual(['all', 'draft', 'published']);
  });

  it('shows everything under "all"', () => {
    const items = [template({ id: 'a' }), template({ id: 'b', status: 'published' })];
    expect(filterLibraryTemplates(items, 'all', '').map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('narrows to one status', () => {
    const items = [template({ id: 'a' }), template({ id: 'b', status: 'published' })];
    expect(filterLibraryTemplates(items, 'published', '').map((t) => t.id)).toEqual(['b']);
  });

  it('searches by name without the reader having to type the diacritics', () => {
    // Same fold the Insert panel search uses (SV-3), for the same reason:
    // "thu chao" has to find "Thư chào mừng".
    const items = [template({ id: 'a', name: 'Thư chào mừng' }), template({ id: 'b', name: 'Báo cáo tuần' })];
    expect(filterLibraryTemplates(items, 'all', 'thu chao').map((t) => t.id)).toEqual(['a']);
    expect(filterLibraryTemplates(items, 'all', 'BAO CAO').map((t) => t.id)).toEqual(['b']);
  });

  it('applies the status filter and the search together, not one or the other', () => {
    const items = [
      template({ id: 'a', name: 'Thư chào mừng', status: 'draft' }),
      template({ id: 'b', name: 'Thư chào mừng', status: 'published' }),
    ];
    expect(filterLibraryTemplates(items, 'published', 'chao').map((t) => t.id)).toEqual(['b']);
  });

  it('hides archived templates from every filter -- they are out of the active library by definition', () => {
    const items = [template({ id: 'a' }), template({ id: 'z', status: 'archived' })];
    expect(filterLibraryTemplates(items, 'all', '').map((t) => t.id)).toEqual(['a']);
  });

  it('gives each card a stable thumbnail tone, so the grid does not reshuffle colours on every render', () => {
    // `v3-template-thumb` takes a tone modifier class in the prototype; the
    // presets carry one by hand. Derived from the id here, so the same
    // template keeps the same tone across loads.
    const first = templateThumbTone('a1b2');
    expect(templateThumbTone('a1b2')).toBe(first);
    // Exactly the four `studio.css` styles: `.v3-template-thumb.sage/.sand/.blue/.plum`.
    // A fifth name would render an unstyled grey card.
    expect(['sage', 'sand', 'blue', 'plum']).toContain(first);
    expect(new Set(['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'].map(templateThumbTone)).size).toBeGreaterThan(1);
    expect(templateThumbTone('')).toBe('sage');
  });
});
