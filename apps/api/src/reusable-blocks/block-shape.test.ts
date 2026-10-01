import { describe, expect, it } from 'vitest';
import { blockShape } from './block-shape.js';

/**
 * ADR-044 Task SV-4. The prototype's block library draws a little preview on
 * every saved row -- one bar per column -- and says how many elements the block
 * holds. ADR-044 §Context lists that preview among the four things lost when
 * the builder was rebuilt, so restoring it is scope, not decoration.
 *
 * The numbers are derived here rather than sent from the browser: the API
 * already holds the tree in the row it is projecting, so this costs no query,
 * and a client-computed count would be a second opinion about data the server
 * owns. `node` stays out of the listing (ADR-035's projection) -- two integers
 * are not a tree.
 */
describe('blockShape (ADR-044 Task SV-4)', () => {
  it('counts a row of columns', () => {
    const node = { kind: 'row', children: [{ kind: 'column' }, { kind: 'column' }] };
    expect(blockShape(node).columns).toBe(2);
  });

  it('counts leaves, not containers -- a section wrapping one heading is one element', () => {
    const node = { kind: 'section', children: [{ kind: 'row', children: [{ kind: 'column', children: [{ kind: 'heading' }] }] }] };
    expect(blockShape(node).elements).toBe(1);
  });

  it('counts leaves at any depth', () => {
    const node = {
      kind: 'row',
      children: [
        { kind: 'column', children: [{ kind: 'heading' }, { kind: 'text' }] },
        { kind: 'column', children: [{ kind: 'image' }] },
      ],
    };
    expect(blockShape(node)).toEqual({ columns: 2, elements: 3 });
  });

  it('treats a saved leaf as one element in a single column, so the preview still draws something', () => {
    // A block does not have to be a Row: the inspector offers "save" on a
    // Column too, and a preview with zero bars would look like a broken row.
    expect(blockShape({ kind: 'heading' })).toEqual({ columns: 1, elements: 1 });
  });

  it('never claims more columns than the preview can draw', () => {
    // studio.tsx clamps at four bars; past that the strip is illegible and the
    // number is not what a reader is scanning for anyway.
    const node = { kind: 'row', children: Array.from({ length: 9 }, () => ({ kind: 'column' })) };
    expect(blockShape(node).columns).toBe(4);
  });

  it('survives a tree it cannot read, because the column is untyped JSON', () => {
    // `node` is stored as opaque JSON and the API never parses it (ADR-035).
    // Anything could be in there; a listing must not 500 over a preview.
    expect(blockShape(null)).toEqual({ columns: 1, elements: 0 });
    expect(blockShape('not a node')).toEqual({ columns: 1, elements: 0 });
    // A container whose children are unreadable holds no elements anybody can
    // see. Reporting 1 would be inventing content to fill the label.
    expect(blockShape({ kind: 'row', children: 'nonsense' })).toEqual({ columns: 1, elements: 0 });
  });
});
