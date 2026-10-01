import { describe, expect, it } from 'vitest';
import { crossedThresholds } from './quota-threshold.js';

describe('BR-CFG-006: 80/90/100 percent threshold crossing', () => {
  it('reports nothing below 80 percent', () => {
    expect(crossedThresholds(0, 79, 100)).toEqual([]);
  });

  it('reports 80 exactly once when usage first reaches it', () => {
    expect(crossedThresholds(79, 80, 100)).toEqual([80]);
    expect(crossedThresholds(80, 85, 100)).toEqual([]);
  });

  it('reports every threshold a single large jump skips over', () => {
    expect(crossedThresholds(0, 100, 100)).toEqual([80, 90, 100]);
  });

  it('reports 100 when usage exceeds the limit, not a fourth threshold', () => {
    expect(crossedThresholds(95, 140, 100)).toEqual([100]);
  });

  it('reports nothing when the limit is null or zero', () => {
    expect(crossedThresholds(0, 500, null)).toEqual([]);
    expect(crossedThresholds(0, 500, 0)).toEqual([]);
  });

  it('never reports a threshold when usage goes down', () => {
    expect(crossedThresholds(95, 10, 100)).toEqual([]);
  });
});
