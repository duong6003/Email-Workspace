import { describe, expect, it } from 'vitest';
import { buildTemplateAnalysisCatalogue, classifyTemplateAnalysisTokens } from './template-analysis.js';

describe('template analysis ownership', () => {
  it('classifies variable sources independently', () => {
    const tokens = ['first_name', 'department', 'company_name', 'campaign_note', 'missing'].map((key, index) => ({ field: 'html' as const, key, start: index, end: index + 1 }));
    expect(classifyTemplateAnalysisTokens(tokens, [{ fieldKey: 'department', label: 'Phòng ban' }], [
      { variableKey: 'company_name', label: 'Tên công ty', scope: 'global' },
      { variableKey: 'campaign_note', label: 'Ghi chú', scope: 'template' },
    ]).map(({ key, source }) => [key, source])).toEqual([
      ['first_name', 'system'], ['department', 'recipient'], ['company_name', 'global'], ['campaign_note', 'template'], ['missing', 'unknown'],
    ]);
  });

  it('uses required metadata from each owning source', () => {
    const catalogue = buildTemplateAnalysisCatalogue([{ fieldKey: 'department', label: 'Phòng ban', required: true }], [
      { variableKey: 'company_name', label: 'Tên công ty', scope: 'global', required: true },
      { variableKey: 'campaign_note', label: 'Ghi chú', scope: 'template', required: true },
    ]);
    expect(catalogue.find((item) => item.key === 'department')?.required).toBe(true);
    expect(catalogue.find((item) => item.key === 'company_name')?.required).toBe(false);
    expect(catalogue.find((item) => item.key === 'campaign_note')?.required).toBe(true);
  });
});

/**
 * ADR-036 scope item 5. The catalogue is the editor's variable panel, so it is
 * where an author has to be able to see how a date will actually render --
 * they cannot infer it from `{{ngay_het_han}}`, which is deliberately
 * unchanged by this work.
 */
describe('catalogue formatting preview (ADR-036)', () => {
  const reference = new Date('2026-08-31T17:00:00.000Z');

  it('shows a date variable with its effective format, zone and a worked example', () => {
    const [item] = buildTemplateAnalysisCatalogue(
      [{ fieldKey: 'ngay_het_han', label: 'Hạn dùng', required: false, dataType: 'date', format: null, timezone: null }],
      [],
      { tenantTimezone: 'Asia/Bangkok', reference },
    ).filter((entry) => entry.key === 'ngay_het_han');

    expect(item).toMatchObject({ dataType: 'date', format: 'dd/MM/yyyy', timezone: 'Asia/Bangkok', example: '01/09/2026' });
  });

  it("prefers the variable's own format and zone in the example", () => {
    const [item] = buildTemplateAnalysisCatalogue([], [
      { variableKey: 'ngay_khai_truong', label: 'Khai trương', scope: 'global', required: false, dataType: 'date', format: 'yyyy-MM-dd', timezone: 'Etc/UTC' },
    ], { tenantTimezone: 'Asia/Bangkok', reference }).filter((entry) => entry.key === 'ngay_khai_truong');

    expect(item).toMatchObject({ format: 'yyyy-MM-dd', timezone: 'Etc/UTC', example: '2026-08-31' });
  });

  it('leaves every type without presentation of its own without an example', () => {
    const catalogue = buildTemplateAnalysisCatalogue(
      [{ fieldKey: 'department', label: 'Phòng ban', required: false, dataType: 'text', format: null, timezone: null }],
      [],
      { tenantTimezone: 'Asia/Bangkok', reference },
    );

    expect(catalogue.find((item) => item.key === 'department')).toMatchObject({ dataType: 'text', format: null, timezone: null, example: null });
    expect(catalogue.find((item) => item.key === 'email')).toMatchObject({ dataType: 'text', example: null });
  });
});
