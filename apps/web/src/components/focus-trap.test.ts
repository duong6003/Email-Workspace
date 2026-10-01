import { describe, expect, it } from 'vitest';
import { nextFocusTarget } from './focus-trap.js';

describe('modal focus trap', () => {
  const items = ['first', 'middle', 'last'];

  it('wraps forward from the last element to the first', () => {
    expect(nextFocusTarget(items, 'last', false)).toBe('first');
  });

  it('wraps backward from the first element to the last', () => {
    expect(nextFocusTarget(items, 'first', true)).toBe('last');
  });

  it('leaves ordinary movement to the browser', () => {
    expect(nextFocusTarget(items, 'first', false)).toBeNull();
    expect(nextFocusTarget(items, 'last', true)).toBeNull();
  });

  it('pulls focus back in when it sits outside the dialog', () => {
    expect(nextFocusTarget(items, 'somewhere-else', false)).toBe('first');
    expect(nextFocusTarget(items, null, true)).toBe('last');
  });

  it('does nothing when the dialog has no focusable element', () => {
    expect(nextFocusTarget([], null, false)).toBeNull();
  });
});
