import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/problem.js';
import { templatePublishError } from './template-errors.js';

describe('templatePublishError', () => {
  it('includes the unknown variable key returned by the API', () => {
    const error = new ApiError(422, {
      type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'invalid variable',
      code: 'UNKNOWN_VARIABLE', category: 'validation', messageKey: 'template.unknownVariable',
      retryable: false, nextAction: 'OPEN_CUSTOM_FIELDS', traceId: 'trace-template',
      variableKey: 'department_code',
    } as never);

    expect(templatePublishError(error)).toContain('{{department_code}}');
  });

  it('provides an actionable incomplete-draft message', () => {
    const error = new ApiError(422, {
      type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'incomplete',
      code: 'TEMPLATE_DRAFT_INCOMPLETE', category: 'validation', messageKey: 'template.incomplete',
      retryable: false, traceId: 'trace-template',
    });

    expect(templatePublishError(error)).toContain('tiêu đề');
  });
});
