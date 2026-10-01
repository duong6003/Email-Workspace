import { describe, expect, it } from 'vitest';
import { missingImportedImages } from './imported-image-sources.js';

describe('missingImportedImages (MC-UI-006 missing_assets)', () => {
  it('lists an http image, which the sanitizer strips', () => {
    expect(missingImportedImages('<p><img src="http://cdn.test/hero.png" alt="Hero"></p>'))
      .toEqual([{ src: 'http://cdn.test/hero.png', alt: 'Hero' }]);
  });

  it('leaves https and cid alone, because both survive sanitization', () => {
    expect(missingImportedImages('<img src="https://cdn.test/a.png"><img src="cid:logo">')).toEqual([]);
  });

  /**
   * The three that look servable and are not. Task 32 measured all of them
   * against the real sanitizer; a protocol-relative or root-relative source is
   * as gone as an http one, and is far easier to mistake for working.
   */
  it.each(['//cdn.test/a.png', '/api/v1/assets/x/a.png', 'data:image/png;base64,AAAA'])('lists %s', (src) => {
    expect(missingImportedImages(`<img src="${src}">`).map((image) => image.src)).toEqual([src]);
  });

  it('says nothing about an image that has no source to lose', () => {
    expect(missingImportedImages('<img alt="placeholder">')).toEqual([]);
  });

  it('collapses one address repeated across rows into a single line to fix', () => {
    const repeated = '<img src="http://cdn.test/logo.png">'.repeat(8);
    expect(missingImportedImages(repeated)).toHaveLength(1);
  });

  it('keeps document order and reads attributes whatever order they were written in', () => {
    const html = '<img alt="Second" src=\'http://b.test/2.png\'><img src=http://c.test/3.png><img src="http://a.test/1.png">';
    expect(missingImportedImages(html).map((image) => image.src))
      .toEqual(['http://b.test/2.png', 'http://c.test/3.png', 'http://a.test/1.png']);
  });

  it('carries the alt text through, so the report can name the picture a person recognises', () => {
    expect(missingImportedImages('<img src="http://cdn.test/a.png" alt="Ảnh sản phẩm">')[0]?.alt).toBe('Ảnh sản phẩm');
  });

  it('does not mistake a src written in ordinary text for an image', () => {
    expect(missingImportedImages('<p>Dán src="http://cdn.test/a.png" vào đây</p>')).toEqual([]);
  });
});
