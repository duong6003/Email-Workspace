import { describe, expect, it } from 'vitest';
import { TEMPLATE_CONFLICT_FIELD_LABEL, editorPathFor, groupTemplateCatalogue, insertTemplateVariable, templateConflictExcerpt, templateContentIsReadOnly, templateLoadFailure, textBodyIsEmpty } from './template-editor.js';

describe('template variable authoring', () => {
  it('inserts a token at the active selection', () => {
    expect(insertTemplateVariable('Xin chào !', 9, 9, 'first_name')).toEqual({ value: 'Xin chào {{first_name}}!', caret: 23 });
  });

  it('keeps catalogues isolated by their owner', () => {
    const groups = groupTemplateCatalogue([
      { key: 'department', label: 'Phòng ban', classification: 'custom', source: 'recipient', required: false, dataType: 'text' as const, format: null, timezone: null, example: null },
      { key: 'first_name', label: 'Tên', classification: 'system', source: 'system', required: false, dataType: 'text' as const, format: null, timezone: null, example: null },
      { key: 'campaign_note', label: 'Ghi chú', classification: 'custom', source: 'template', required: false, dataType: 'date' as const, format: 'dd/MM/yyyy', timezone: 'Asia/Ho_Chi_Minh', example: '01/09/2026' },
    ]);
    expect(groups.map((group) => [group.source, group.items.map((item) => item.key)])).toEqual([
      ['system', ['first_name']], ['global', []], ['recipient', ['department']], ['template', ['campaign_note']],
    ]);
  });
});

describe('template editor tabs', () => {
  // Deliberately not read from the server lint. `POST /templates/analyze` does
  // return TEXT_BODY_EMPTY for an empty `textBody`, but only after a debounced
  // round-trip; the tab marks what the author has typed, without the lag.
  it('marks the tab while the text body is empty', () => {
    expect(textBodyIsEmpty('')).toBe(true);
  });

  it('treats whitespace as empty, matching the server rule', () => {
    expect(textBodyIsEmpty('   \n\t ')).toBe(true);
  });

  it('leaves the tab unmarked once there is real text', () => {
    expect(textBodyIsEmpty('Xin chào')).toBe(false);
    expect(textBodyIsEmpty(' x ')).toBe(false);
  });
});

describe('template editor permission state (§5.1 permission_denied)', () => {
  it('is read-only for a role that can read template content but not change it', () => {
    expect(templateContentIsReadOnly(['session:manage', 'campaign:read', 'notification:read', 'content:read'])).toBe(true);
  });

  it('is editable once content:manage is held', () => {
    expect(templateContentIsReadOnly(['content:read', 'content:manage'])).toBe(false);
  });

  it('is read-only when the session has no permissions at all', () => {
    expect(templateContentIsReadOnly(undefined)).toBe(true);
    expect(templateContentIsReadOnly([])).toBe(true);
  });

  it('reads a 403 on load as a permission problem, not a broken template', () => {
    expect(templateLoadFailure(403)).toBe('permissionDenied');
  });

  it('keeps every other load failure on the retryable error card', () => {
    expect(templateLoadFailure(404)).toBe('loadError');
    expect(templateLoadFailure(500)).toBe('loadError');
    expect(templateLoadFailure(0)).toBe('loadError');
    expect(templateLoadFailure(undefined)).toBe('loadError');
  });
});

describe('editorPathFor (ADR-041: origin decides which editor a template opens in)', () => {
  it('sends a builder-origin template to the focus-mode builder route', () => {
    expect(editorPathFor({ id: 'tpl-1', origin: 'builder' })).toBe('/templates/tpl-1/build');
  });

  it('sends an imported-origin template to the code editor route', () => {
    expect(editorPathFor({ id: 'tpl-2', origin: 'imported' })).toBe('/templates/tpl-2/edit');
  });
});

describe('revision-conflict comparison cells (spec §2.7, S4 Task 23)', () => {
  it('collapses whitespace so an HTML body fits one readable line', () => {
    expect(templateConflictExcerpt('<p>\n  Xin chào\n</p>')).toBe('<p> Xin chào </p>');
  });

  it('truncates a long value rather than flooding the cell', () => {
    const excerpt = templateConflictExcerpt('x'.repeat(400));
    expect(excerpt).toHaveLength(121);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('says "(trống)" instead of rendering an empty cell', () => {
    expect(templateConflictExcerpt('')).toBe('(trống)');
    expect(templateConflictExcerpt('   ')).toBe('(trống)');
  });

  it('serialises projectData -- the builder patches a component tree, not a string', () => {
    expect(templateConflictExcerpt({ nodes: [{ kind: 'text' }] })).toBe('{"nodes":[{"kind":"text"}]}');
  });

  it('labels every field either editor can put in a conflicting patch', () => {
    // The builder patch carries html + projectData + textBody together
    // (BR-TPL-007); an unlabelled key would render as a raw field name.
    for (const field of ['name', 'subject', 'html', 'textBody', 'projectData']) {
      expect(TEMPLATE_CONFLICT_FIELD_LABEL[field], `no conflict label for "${field}"`).toBeTruthy();
    }
  });
});
