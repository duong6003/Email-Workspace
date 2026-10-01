import { describe, expect, it } from 'vitest';
import { validateBulkAction } from './bulk-jobs.service.js';

describe('bulk job request validation', () => {
  it('requires custom-data bulk updates to name a field key and value', () => {
    expect(() => validateBulkAction('set_custom_data', {})).toThrow('set_custom_data requires key and value.');
  });

  it('requires tag operations to name a tag id', () => {
    expect(() => validateBulkAction('add_tag', {})).toThrow('add_tag requires tagId.');
  });

  it('accepts export and recipient soft-delete actions without an action payload', () => {
    expect(() => validateBulkAction('export', {})).not.toThrow();
    expect(() => validateBulkAction('delete', {})).not.toThrow();
  });
});
