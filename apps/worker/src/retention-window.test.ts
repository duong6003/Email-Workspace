import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_EVENT_RETENTION_DAYS,
  RETENTION_FLOOR_DAYS,
  historyRetentionDefaultDays,
  retentionCutoff,
} from './retention-window.js';

/**
 * M6-S4 CP4 (A15). Pure and database-free: the cutoff arithmetic the purge
 * depends on is unit-testable on its own, and the database function's own
 * floor (migration 032) is the second, independent guard.
 */
describe('historyRetentionDefaultDays', () => {
  it('defaults to 365 when unset or blank', () => {
    expect(historyRetentionDefaultDays(undefined)).toBe(DEFAULT_HISTORY_EVENT_RETENTION_DAYS);
    expect(historyRetentionDefaultDays('')).toBe(365);
  });

  it('accepts a configured integer inside the bounds', () => {
    expect(historyRetentionDefaultDays('30')).toBe(30);
    expect(historyRetentionDefaultDays('3650')).toBe(3650);
  });

  it('throws on a value below the floor, above the ceiling, or non-integer', () => {
    expect(() => historyRetentionDefaultDays('29')).toThrowError(/HISTORY_EVENT_RETENTION_DAYS/);
    expect(() => historyRetentionDefaultDays('3651')).toThrowError(/HISTORY_EVENT_RETENTION_DAYS/);
    expect(() => historyRetentionDefaultDays('45.5')).toThrowError(/HISTORY_EVENT_RETENTION_DAYS/);
    expect(() => historyRetentionDefaultDays('abc')).toThrowError(/HISTORY_EVENT_RETENTION_DAYS/);
  });
});

describe('retentionCutoff', () => {
  const now = new Date('2026-08-19T00:00:00.000Z');

  it('subtracts whole days from the supplied clock', () => {
    expect(retentionCutoff(30, now).toISOString()).toBe('2026-07-20T00:00:00.000Z');
    expect(retentionCutoff(365, now).toISOString()).toBe('2025-08-19T00:00:00.000Z');
  });

  it('never returns an instant inside the floor, even if asked', () => {
    expect(retentionCutoff(1, now).toISOString()).toBe(retentionCutoff(RETENTION_FLOOR_DAYS, now).toISOString());
  });
});
