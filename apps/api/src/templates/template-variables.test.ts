import { describe, expect, it } from 'vitest';
import { RESERVED_CUSTOM_FIELD_KEYS } from '../custom-fields/dto/custom-field.dto.js';
import {
  parseTemplateVariableTokens,
  SYSTEM_TEMPLATE_VARIABLES,
  TemplateVariableError,
  analyzeTemplateVariables,
} from './template-variables.js';

describe('template variable analysis (M3-S2: BR-TPL-003)', () => {
  const customFields = [
    { fieldKey: 'employee_grade', dataType: 'enum' as const, required: true, defaultValue: null },
    { fieldKey: 'office_name', dataType: 'text' as const, required: true, defaultValue: 'Bangkok' },
    { fieldKey: 'floor', dataType: 'number' as const, required: false, defaultValue: 0 },
  ];

  it('reports stable field and character offsets for guided repair', () => {
    expect(parseTemplateVariableTokens({ subject: 'Hi {{email}}', html: '<p>{{customer_tier}}</p>', textBody: '' })).toEqual([
      { field: 'subject', key: 'email', start: 3, end: 12 },
      { field: 'html', key: 'customer_tier', start: 3, end: 20 },
    ]);
  });

  it('derives a canonical required, optional, and defaults schema from all template fields', () => {
    const result = analyzeTemplateVariables({
      subject: 'Hello {{ email }}',
      html: '<p>{{employee_grade}} at {{office_name}}</p>',
      textBody: 'Use {{unsubscribe_url}} from floor {{floor}}',
    }, customFields);

    expect(result.schema).toEqual({
      required: ['email', 'employee_grade'],
      optional: ['floor', 'office_name', 'unsubscribe_url'],
      defaults: { floor: 0, office_name: 'Bangkok' },
    });
    expect([...SYSTEM_TEMPLATE_VARIABLES.map((variable) => variable.key)].sort()).toEqual([...RESERVED_CUSTOM_FIELD_KEYS].sort());
  });

  it('records configured variable scope, defaults and campaign override permission', () => {
    const result = analyzeTemplateVariables({
      subject: 'Thông báo từ {{company_name}}',
      html: '<p>{{campaign_note}}</p>',
      textBody: '',
    }, customFields, [
      { variableKey: 'company_name', label: 'Tên công ty', scope: 'global', defaultValue: 'Alta', required: false, allowCampaignOverride: false },
      { variableKey: 'campaign_note', label: 'Ghi chú chiến dịch', scope: 'template', defaultValue: 'Xin chào', required: true, allowCampaignOverride: true },
    ]);

    expect(result.schema).toEqual({
      required: [],
      optional: ['campaign_note', 'company_name'],
      defaults: { campaign_note: 'Xin chào' },
      configured: {
        campaign_note: { label: 'Ghi chú chiến dịch', scope: 'template', allowCampaignOverride: true },
        company_name: { label: 'Tên công ty', scope: 'global', allowCampaignOverride: false },
      },
    });
  });

  it('lets a template-owned variable override a global definition with the same key', () => {
    const result = analyzeTemplateVariables({ subject: '{{company_name}}', html: '<p>Body</p>', textBody: '' }, customFields, [
      { variableKey: 'company_name', label: 'Tên công ty chung', scope: 'global', defaultValue: 'Alta', required: false, allowCampaignOverride: false },
      { variableKey: 'company_name', label: 'Tên công ty của template', scope: 'template', defaultValue: 'Alta Software', required: false, allowCampaignOverride: true },
    ]);

    expect(result.schema.defaults).toEqual({ company_name: 'Alta Software' });
    expect(result.schema.configured?.company_name).toEqual({ label: 'Tên công ty của template', scope: 'template', allowCampaignOverride: true });
  });

  it('rejects a variable that is not a system key or current-tenant custom field', () => {
    expect(() => analyzeTemplateVariables({ subject: 'Hi {{not_in_this_tenant}}', html: '<p>Body</p>', textBody: '' }, customFields))
      .toThrow(expect.objectContaining<Partial<TemplateVariableError>>({ code: 'UNKNOWN_VARIABLE', variableKey: 'not_in_this_tenant' }));
  });

  it('allows one known variable to be referenced repeatedly across template fields', () => {
    const result = analyzeTemplateVariables({
      subject: 'Hi {{email}}',
      html: '<p>{{email}} / {{email}}</p>',
      textBody: 'Email: {{email}}',
    }, customFields);

    expect(result.schema).toEqual({ required: ['email'], optional: [] });
    expect(result.tokens).toHaveLength(4);
  });

  it('reports an unknown variable before considering repeated references', () => {
    expect(() => analyzeTemplateVariables({
      subject: '',
      html: '<p>{{not_in_this_tenant}}</p>',
      textBody: '{{not_in_this_tenant}}',
    }, customFields)).toThrow(expect.objectContaining<Partial<TemplateVariableError>>({
      code: 'UNKNOWN_VARIABLE',
      variableKey: 'not_in_this_tenant',
    }));
  });

  it('reports an unknown referenced identity before unrelated catalogue collisions', () => {
    expect(() => analyzeTemplateVariables({
      subject: '{{not_in_this_tenant}}',
      html: '<p>Body</p>',
      textBody: '',
    }, [...customFields, { ...customFields[0] }])).toThrow(expect.objectContaining<Partial<TemplateVariableError>>({
      code: 'UNKNOWN_VARIABLE',
      variableKey: 'not_in_this_tenant',
    }));
  });

  it('rejects duplicate variable definitions in the tenant custom-field catalogue', () => {
    expect(() => analyzeTemplateVariables({
      subject: '{{employee_grade}}',
      html: '<p>Body</p>',
      textBody: '',
    }, [...customFields, { ...customFields[0] }])).toThrow(expect.objectContaining<Partial<TemplateVariableError>>({
      code: 'DUPLICATE_VARIABLE',
      variableKey: 'employee_grade',
    }));
  });

  it('rejects a custom-field definition that shadows a system variable identity', () => {
    expect(() => analyzeTemplateVariables({
      subject: '{{email}}',
      html: '<p>Body</p>',
      textBody: '',
    }, [...customFields, { fieldKey: 'email', dataType: 'text', required: false, defaultValue: null }]))
      .toThrow(expect.objectContaining<Partial<TemplateVariableError>>({
        code: 'DUPLICATE_VARIABLE',
        variableKey: 'email',
      }));
  });

  it.each([
    ['unclosed expression', { subject: '{{email', html: '<p>Body</p>', textBody: '' }, 'MALFORMED_TEMPLATE_SYNTAX'],
    ['helper', { subject: '{{uppercase email}}', html: '<p>Body</p>', textBody: '' }, 'UNSAFE_TEMPLATE_EXPRESSION'],
    ['block', { subject: '{{#if email}}', html: '<p>Body</p>', textBody: '' }, 'UNSAFE_TEMPLATE_EXPRESSION'],
    ['partial', { subject: '{{> recipient}}', html: '<p>Body</p>', textBody: '' }, 'UNSAFE_TEMPLATE_EXPRESSION'],
    ['triple braces', { subject: '{{{email}}}', html: '<p>Body</p>', textBody: '' }, 'UNSAFE_TEMPLATE_EXPRESSION'],
    ['prototype path', { subject: '{{this.constructor}}', html: '<p>Body</p>', textBody: '' }, 'UNSAFE_TEMPLATE_EXPRESSION'],
  ] as const)('rejects %s without evaluating it', (_name, template, code) => {
    expect(() => analyzeTemplateVariables(template, customFields)).toThrow(expect.objectContaining<Partial<TemplateVariableError>>({ code }));
  });

  it('enforces a bounded occurrence budget without recursion', () => {
    const repeated = Array.from({ length: 1_001 }, () => '{{email}}').join(' ');
    expect(() => analyzeTemplateVariables({ subject: repeated, html: '<p>Body</p>', textBody: '' }, customFields))
      .toThrow(expect.objectContaining<Partial<TemplateVariableError>>({ code: 'TEMPLATE_VARIABLE_LIMIT_EXCEEDED' }));
  });
});
