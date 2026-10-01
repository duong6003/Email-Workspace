import { describe, expect, it } from 'vitest';
import { mergeConfiguredVariableValues } from './configured-variable-resolution.js';

const schema = {
  required: [],
  optional: ['brand_name', 'campaign_note'],
  defaults: { campaign_note: 'Mặc định theo template' },
  configured: {
    brand_name: { label: 'Thương hiệu', scope: 'global' as const, allowCampaignOverride: false },
    campaign_note: { label: 'Ghi chú', scope: 'template' as const, allowCampaignOverride: true },
  },
};

describe('configured variable resolution', () => {
  it('resolves global values, then immutable template defaults, then allowed campaign overrides', () => {
    expect(mergeConfiguredVariableValues(schema, [
      { scope: 'global', variableKey: 'brand_name', defaultValue: 'Alta' },
      { scope: 'template', variableKey: 'campaign_note', defaultValue: 'Giá trị hiện tại không được dùng sau publish' },
    ], { campaign_note: 'Giá trị của lượt gửi' })).toEqual({
      brand_name: 'Alta',
      campaign_note: 'Giá trị của lượt gửi',
    });
  });

  it('rejects overrides that the published template did not allow', () => {
    expect(() => mergeConfiguredVariableValues(schema, [
      { scope: 'global', variableKey: 'brand_name', defaultValue: 'Alta' },
    ], { brand_name: 'Khác' })).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'VARIABLE_OVERRIDE_NOT_ALLOWED' }) }));
  });
});
