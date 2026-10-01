import { describe, expect, it } from 'vitest';
import { dropEdge } from './drop-position.js';

describe('dropEdge', () => {
  const box = { top: 100, height: 40 }; // midpoint at 120

  it('reads the top half of a block as "insert before it"', () => {
    expect(dropEdge(101, box)).toBe('before');
    expect(dropEdge(119, box)).toBe('before');
  });

  it('reads the bottom half as "insert after it"', () => {
    expect(dropEdge(121, box)).toBe('after');
    expect(dropEdge(139, box)).toBe('after');
  });

  it('resolves the exact midpoint one way rather than flickering', () => {
    expect(dropEdge(120, box)).toBe('after');
  });

  it('answers for a zero-height block instead of dividing by nothing', () => {
    expect(dropEdge(100, { top: 100, height: 0 })).toBe('after');
  });

  it('answers for a pointer that has left the block', () => {
    expect(dropEdge(0, box)).toBe('before');
    expect(dropEdge(9999, box)).toBe('after');
  });
});
