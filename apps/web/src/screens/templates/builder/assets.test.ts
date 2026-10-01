import { describe, expect, it } from 'vitest';
import type { Asset } from '../../../api/assets.js';
import { defaultTheme, type Doc, type Node } from './document.js';
import { assetSizeLabel, assetUploaderLabel, missingAssetNodes } from './assets.js';

let counter = 0;
function node(kind: Node['kind'], extra: Partial<Node> = {}): Node {
  counter += 1;
  return { id: `n${counter}`, kind, visible: true, ...extra };
}

function doc(...nodes: Node[]): Doc {
  return { title: 'T', nodes, variables: [], theme: defaultTheme };
}

/** A leaf sits under column > row > section in a real document, so every walk has to reach it. */
function nested(leaf: Node): Node {
  return node('section', { children: [node('row', { children: [node('column', { children: [leaf] })] })] });
}

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'a1', url: 'https://app.example.test/api/v1/assets/a1/logo.png', filename: 'logo.png',
    contentType: 'image/png', byteSize: 2048, width: null, height: null,
    createdBy: 'u1', createdByName: 'Minh An', archivedAt: null, createdAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('missingAssetNodes (MC-UI-005 missing_assets)', () => {
  it('flags an image with no src at all -- the emitter drops it, so the canvas shows what the email will not', () => {
    const found = missingAssetNodes(doc(nested(node('image'))));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'image', reason: 'unbound', src: null });
  });

  it('flags a banner with no src for the same reason', () => {
    expect(missingAssetNodes(doc(nested(node('banner'))))).toMatchObject([{ kind: 'banner', reason: 'unbound' }]);
  });

  it('leaves a logo with no src alone -- it has a real text wordmark fallback, so nothing goes missing', () => {
    expect(missingAssetNodes(doc(nested(node('logo', { content: 'ALTA' }))))).toEqual([]);
  });

  it.each([
    ['http://cdn.example.test/logo.png'],
    ['//cdn.example.test/logo.png'],
    ['/api/v1/assets/a1/logo.png'],
    ['data:image/png;base64,iVBORw0KGgo='],
  ])('flags %s -- Task 32 measured the sanitizer strips exactly these, leaving a broken image in published mail', (src) => {
    expect(missingAssetNodes(doc(nested(node('image', { src }))))).toMatchObject([{ reason: 'not_https', src }]);
  });

  it('accepts an absolute https src, wherever it is hosted', () => {
    expect(missingAssetNodes(doc(nested(node('image', { src: 'https://app.example.test/api/v1/assets/a1/logo.png' }))))).toEqual([]);
    expect(missingAssetNodes(doc(nested(node('image', { src: 'https://cdn.partner.test/hero.jpg' }))))).toEqual([]);
  });

  it('flags a logo whose src is set but unusable -- the fallback only covers having no src', () => {
    expect(missingAssetNodes(doc(nested(node('logo', { src: 'http://cdn.example.test/logo.png' }))))).toMatchObject([{ kind: 'logo', reason: 'not_https' }]);
  });

  it('walks the whole tree and reports every node, in document order', () => {
    const found = missingAssetNodes(doc(
      nested(node('image', { src: 'http://a.test/1.png' })),
      nested(node('text', { content: 'no image here' })),
      nested(node('banner')),
    ));
    expect(found.map((entry) => entry.reason)).toEqual(['not_https', 'unbound']);
  });
});

describe('assetSizeLabel', () => {
  it('reads in the unit a person would say it in', () => {
    expect(assetSizeLabel(512)).toBe('512 B');
    expect(assetSizeLabel(2048)).toBe('2,0 KB');
    expect(assetSizeLabel(5 * 1024 * 1024)).toBe('5,0 MB');
  });
});

describe('assetUploaderLabel', () => {
  it('names the uploader, and says so plainly when the account is gone', () => {
    expect(assetUploaderLabel(asset())).toBe('Minh An');
    expect(assetUploaderLabel(asset({ createdByName: null }))).toBe('Không rõ người tải lên');
  });
});
