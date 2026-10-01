import { describe, expect, it } from 'vitest';
import { renderExportCsv } from '../../src/campaigns/export-render.js';
import { recipientVariableContext } from '../../src/campaigns/recipient-variable-context.js';
import { renderTemplateVariables } from '../../src/templates/template-variable-renderer.js';

const XSS = `<img src=x onerror="alert(1)">`;
const XSS_SVG = `<svg/onload=alert(1)>`;
const XSS_ATTR = `" onmouseover="alert(1)`;

describe('M7-S2 stored XSS negatives (TC-SEC-014)', () => {
  it.each([XSS, XSS_SVG, XSS_ATTR])('escapes a stored recipient value at the HTML render boundary: %s', (payload) => {
    const context = recipientVariableContext({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'xss@example.test', firstName: payload, lastName: null, customData: { office: payload },
    }, [{ fieldKey: 'office' }], 'https://app.example.test');
    const rendered = renderTemplateVariables(
      { subject: '{{first_name}}', html: '<p>{{first_name}}</p><div>{{office}}</div>', textBody: '{{first_name}}' },
      { required: [], optional: ['first_name', 'office'] },
      context,
    );
    expect(rendered).not.toHaveProperty('code');
    if ('html' in rendered) {
      expect(rendered.html).not.toContain('<img');
      expect(rendered.html).not.toContain('<svg');
      expect(rendered.html).not.toContain(payload);
      expect(rendered.html).toMatch(/&lt;|&quot;/);
    }
  });

  it.each(['=2+3', '+SUM(A1:A2)', '-1+1', '@cmd'])('neutralizes spreadsheet-formula prefix %s in CSV', (payload) => {
    const csv = renderExportCsv([{
      recipientEmail: payload, status: 'failed', skippedReason: null, attemptCount: 1,
      lastErrorCode: payload, lastErrorClass: null, lastErrorReason: payload, submittedAt: null, deliveredAt: null,
    }]);
    const dataRow = csv.split('\r\n')[1]!;
    expect(dataRow).not.toMatch(new RegExp(`(^|,)${payload[0]!.replace(/[+\-]/g, '\\$&')}`));
  });
});
