import { describe, expect, it } from 'vitest';
import { periodKeyFor } from './quota-period.js';

describe('BR-CFG-006: quota period keys', () => {
  it('derives a month key in UTC', () => {
    expect(periodKeyFor(new Date('2026-08-19T23:30:00Z'), 'month')).toBe('2026-08');
  });

  it('derives a day key in UTC', () => {
    expect(periodKeyFor(new Date('2026-08-19T23:30:00Z'), 'day')).toBe('2026-08-19');
  });

  it('does not shift the key by the host timezone', () => {
    expect(periodKeyFor(new Date('2026-08-31T23:30:00Z'), 'month')).toBe('2026-08');
    expect(periodKeyFor(new Date('2026-09-01T00:30:00Z'), 'month')).toBe('2026-09');
  });
});
