import { describe, expect, it } from 'vitest';
import type { Node } from './document.js';
import { contrastRatio, nodeLowContrast, lowContrastNodeIds } from './content-contrast.js';

describe('contrastRatio (WCAG 2.1 §1.4.3)', () => {
  it('reports the textbook black-on-white ratio, 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  it('reports 1:1 for identical colours, whatever they are', () => {
    expect(contrastRatio('#30463d', '#30463d')).toBeCloseTo(1, 5);
  });

  it('is symmetric -- the darker/lighter ordering does not change the ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#000000')!, 5);
  });

  it('expands the 3-digit shorthand the same way CSS does', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 0);
  });

  it('is case-insensitive', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 0);
  });

  it('returns null for anything that is not plain hex, rather than guessing', () => {
    expect(contrastRatio('rgb(0,0,0)', '#ffffff')).toBeNull();
    expect(contrastRatio('inherit', '#ffffff')).toBeNull();
    expect(contrastRatio('', '#ffffff')).toBeNull();
  });

  /** ADR-047's own measured numbers, so this function's output matches the ADR's table rather than merely being self-consistent. */
  it('reproduces ADR-047\'s measured dark-palette ratios', () => {
    expect(contrastRatio('#e6ede9', '#16211d')).toBeCloseTo(13.91, 1);
    expect(contrastRatio('#e6ede9', '#0f1613')).toBeCloseTo(15.43, 1);
    expect(contrastRatio('#30463d', '#ffffff')).toBeCloseTo(10.15, 1);
  });
});

describe('nodeLowContrast', () => {
  const node = (overrides: Partial<Node>): Node => ({ id: 'n', kind: 'text', visible: true, content: 'x', ...overrides });

  it('is false when the author never overrode the default ink', () => {
    expect(nodeLowContrast(node({}), '#ffffff')).toBe(false);
  });

  it('is true for white-on-white', () => {
    expect(nodeLowContrast(node({ textColor: '#ffffff' }), '#ffffff')).toBe(true);
  });

  it('is false for black-on-white', () => {
    expect(nodeLowContrast(node({ textColor: '#000000' }), '#ffffff')).toBe(false);
  });

  it('is false for a kind this check does not cover (button), whatever the colours are', () => {
    expect(nodeLowContrast(node({ kind: 'button', textColor: '#ffffff' }), '#ffffff')).toBe(false);
  });

  it('applies the large-text 3:1 threshold to a heading, not the 4.5:1 body threshold', () => {
    // ~3.8:1 -- fails 4.5, clears 3.
    expect(nodeLowContrast(node({ kind: 'heading', textColor: '#838383' }), '#ffffff')).toBe(false);
    expect(nodeLowContrast(node({ kind: 'text', textColor: '#838383' }), '#ffffff')).toBe(true);
  });

  it('an explicit large fontSize on a text block gets the same 3:1 threshold as a heading', () => {
    expect(nodeLowContrast(node({ kind: 'text', textColor: '#838383', fontSize: 24 }), '#ffffff')).toBe(false);
  });
});

describe('lowContrastNodeIds', () => {
  const leaf = (n: Partial<Node> & { id: string }): Node => ({ kind: 'text', visible: true, content: 'x', ...n }) as Node;

  it('walks nested children, inheriting each ancestor\'s own background', () => {
    const nodes: Node[] = [
      { id: 'sec', kind: 'section', visible: true, background: '#000000', children: [
        { id: 'col', kind: 'column', visible: true, children: [
          leaf({ id: 'ok', textColor: '#ffffff' }), // white on black -- fine
          leaf({ id: 'bad', textColor: '#0a0a0a' }), // near-black on black -- fails
        ] },
      ] },
    ];
    expect(lowContrastNodeIds(nodes, '#ffffff')).toEqual(['bad']);
  });

  it('falls back to the document default background only where no ancestor set one', () => {
    const nodes: Node[] = [leaf({ id: 'top', textColor: '#ffffff' })];
    expect(lowContrastNodeIds(nodes, '#ffffff')).toEqual(['top']);
    expect(lowContrastNodeIds(nodes, '#000000')).toEqual([]);
  });

  it('skips a hidden node and never descends into its children', () => {
    const nodes: Node[] = [
      { id: 'hidden', kind: 'section', visible: false, background: '#ffffff', children: [leaf({ id: 'inside', textColor: '#ffffff' })] },
    ];
    expect(lowContrastNodeIds(nodes, '#ffffff')).toEqual([]);
  });
});
