import { describe, expect, it } from 'vitest';
import { classifyJobStatus, customDataFromImportRow, validateClaimedImportRow } from './import-processor.js';

describe('import worker helpers', () => {
  it('reports partial_success when terminal row results include both successes and failures', () => {
    expect(classifyJobStatus({ total: 3, succeeded: 2, failed: 1, skipped: 0 })).toBe('partial_success');
  });

  it('does not reactivate an unsubscribed recipient from imported active data', () => {
    expect(() => validateClaimedImportRow({ existingStatus: 'unsubscribed', importedStatus: 'active' })).toThrow('CONSENT_REQUIRED');
  });

  it('builds custom data from explicit custom-field mappings only', () => {
    expect(customDataFromImportRow({ email: 'Email', firstName: 'First name', custom_department_code: 'Department' }, { Email: 'person@example.test', 'First name': 'Ada', Department: 'MKT' }))
      .toEqual({ department_code: 'MKT' });
  });
});
