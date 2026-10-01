import { describe, expect, it } from 'vitest';
import { renderTemplateVariables } from './template-variable-renderer.js';
import { fallbackText } from './templates.service.js';

describe('template variable rendering (M3-S2: TC-TPL-004)', () => {
  const template = {
    subject: 'Hello {{email}}',
    html: '<p>{{office_name}}</p><p>{{first_name}}</p>',
    textBody: '{{office_name}} / {{first_name}}',
  };
  const schema = {
    required: ['email'],
    optional: ['first_name', 'office_name'],
    defaults: { office_name: 'Bangkok' },
  };

  it('renders subject, HTML, and text using immutable optional defaults', () => {
    expect(renderTemplateVariables(template, schema, { email: 'person@example.test' })).toEqual({
      subject: 'Hello person@example.test',
      html: '<p>Bangkok</p><p></p>',
      textBody: 'Bangkok / ',
    });
  });

  it('returns every missing required key without a partial payload', () => {
    expect(renderTemplateVariables(template, schema, {})).toEqual({
      code: 'MISSING_REQUIRED_VARIABLE',
      missingKeys: ['email'],
    });
  });

  it('renders a preview while reporting every required key that has no merge value', () => {
    expect(renderTemplateVariables(
      { subject: 'Hello {{email}}', html: '<p>{{email}}</p><p>{{first_name}}</p>', textBody: '{{email}} / {{first_name}}' },
      { required: ['email'], optional: ['first_name'] },
      {},
      { mode: 'preview' },
    )).toEqual({
      subject: 'Hello ',
      html: '<p></p><p></p>',
      textBody: ' / ',
      missingKeys: ['email'],
    });
  });

  it('generates readable fallback text that decodes entities and keeps link destinations', () => {
    expect(fallbackText('<p>Hà Nội &amp; <a href="https://example.test/x">xem thêm</a></p>')).toBe('Hà Nội & xem thêm (https://example.test/x)');
  });

  it('preserves false and zero defaults without recursive evaluation', () => {
    const result = renderTemplateVariables(
      { subject: '{{count}} {{enabled}}', html: '<p>{{count}}</p>', textBody: '{{enabled}}' },
      { required: [], optional: ['count', 'enabled'], defaults: { count: 0, enabled: false } },
      { ignored: '{{email}}' },
    );

    expect(result).toEqual({ subject: '0 false', html: '<p>0</p>', textBody: 'false' });
  });
});

/**
 * ADR-036. Formatting is applied inside the renderer, so every caller --
 * preview, draft preview, test send and the campaign snapshot freeze that
 * produces the real send -- gets it by construction rather than by each
 * remembering to format first.
 */
describe('typed variable formatting inside the renderer (ADR-036)', () => {
  const template = {
    subject: 'Hạn dùng {{ngay_het_han}}',
    html: '<p>Hạn dùng {{ngay_het_han}}</p>',
    textBody: 'Hạn dùng {{ngay_het_han}}',
  };
  const schema = { required: [], optional: ['ngay_het_han'] };
  const dateDefinition = { dataType: 'date' as const, format: null, timezone: null };

  it('renders a date variable as a local calendar date, with no T separator and no Z suffix', () => {
    const rendered = renderTemplateVariables(template, schema, { ngay_het_han: '2026-08-31T00:00:00.000Z' }, {
      formatting: { definitions: { ngay_het_han: dateDefinition }, tenantTimezone: 'Etc/UTC' },
    });

    expect(rendered).toEqual({
      subject: 'Hạn dùng 31/08/2026',
      html: '<p>Hạn dùng 31/08/2026</p>',
      textBody: 'Hạn dùng 31/08/2026',
    });
    expect(JSON.stringify(rendered)).not.toMatch(/\d{4}-\d{2}-\d{2}T|Z<|Z"/);
  });

  it('keeps a +07:00 value on its intended calendar day for a +07:00 tenant', () => {
    const stored = new Date('2026-09-01T00:00+07:00').toISOString();

    const rendered = renderTemplateVariables(template, schema, { ngay_het_han: stored }, {
      formatting: { definitions: { ngay_het_han: dateDefinition }, tenantTimezone: 'Asia/Bangkok' },
    });

    expect(rendered).toMatchObject({ subject: 'Hạn dùng 01/09/2026' });
  });

  it('produces identical output in preview mode and in strict send mode', () => {
    const formatting = { definitions: { ngay_het_han: dateDefinition }, tenantTimezone: 'Asia/Bangkok' };
    const context = { ngay_het_han: '2026-08-31T17:00:00.000Z' };

    const preview = renderTemplateVariables(template, schema, context, { mode: 'preview', formatting });
    const send = renderTemplateVariables(template, schema, context, { formatting });

    expect('code' in send).toBe(false);
    const { missingKeys: _missingKeys, ...previewFields } = preview;
    expect(previewFields).toEqual(send);
  });

  it('escapes a formatted value in HTML exactly as an unformatted one is', () => {
    const rendered = renderTemplateVariables(
      { subject: '', html: '<p>{{note}}</p>', textBody: '' },
      { required: [], optional: ['note'] },
      { note: '<script>' },
      { formatting: { definitions: { note: { dataType: 'text', format: null, timezone: null } }, tenantTimezone: null } },
    );

    expect(rendered).toMatchObject({ html: '<p>&lt;script&gt;</p>' });
  });

  it('renders exactly as before when no formatting is supplied', () => {
    expect(renderTemplateVariables(template, schema, { ngay_het_han: '2026-08-31T00:00:00.000Z' }))
      .toMatchObject({ subject: 'Hạn dùng 2026-08-31T00:00:00.000Z' });
  });
});
