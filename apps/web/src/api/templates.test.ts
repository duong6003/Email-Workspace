import { describe, expect, it } from 'vitest';
import { templateQueryString } from './templates.js';

describe('template API query serialization', () => {
  it('serializes only active library filters', () => {
    expect(templateQueryString({ search: 'welcome', status: 'published', limit: 50 })).toBe('search=welcome&status=published&limit=50');
    expect(templateQueryString({})).toBe('');
  });
});
