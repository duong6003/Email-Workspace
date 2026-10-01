import { describe, expect, it } from 'vitest';
import { THUMBNAIL_MAX_HTML_BYTES, thumbnailMode } from './template-thumbnail.js';

describe('template thumbnail mode', () => {
  it('waits while the template has not been fetched yet', () => {
    expect(thumbnailMode({ html: null, failed: false, observerAvailable: true })).toBe('pending');
  });

  it('renders the real html once it arrives', () => {
    expect(thumbnailMode({ html: '<p>Xin chào</p>', failed: false, observerAvailable: true })).toBe('thumbnail');
  });

  it('falls back to the poster when the fetch failed', () => {
    expect(thumbnailMode({ html: null, failed: true, observerAvailable: true })).toBe('poster');
  });

  it('falls back to the poster for html past the size ceiling', () => {
    const huge = 'x'.repeat(THUMBNAIL_MAX_HTML_BYTES + 1);
    expect(thumbnailMode({ html: huge, failed: false, observerAvailable: true })).toBe('poster');
  });

  it('falls back to the poster with no IntersectionObserver, before any fetch', () => {
    expect(thumbnailMode({ html: null, failed: false, observerAvailable: false })).toBe('poster');
  });

  it('measures bytes, not characters, so Vietnamese text is not undercounted', () => {
    const nearLimit = 'ế'.repeat(THUMBNAIL_MAX_HTML_BYTES / 2);
    expect(thumbnailMode({ html: nearLimit, failed: false, observerAvailable: true })).toBe('poster');
  });
});
