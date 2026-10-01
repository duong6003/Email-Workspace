import { describe, expect, it } from 'vitest';
import { backNavigationAction } from './back-navigation.js';

describe('backNavigationAction (conventions spec §2.11 -- Back, four layers)', () => {
  it('closes an open modal or tool panel first, regardless of everything else', () => {
    expect(backNavigationAction({ modalOpen: true, previewOpen: false, dirty: false })).toBe('close-modal');
    expect(backNavigationAction({ modalOpen: true, previewOpen: true, dirty: true })).toBe('close-modal');
  });

  it('exits preview next, once no modal is open', () => {
    expect(backNavigationAction({ modalOpen: false, previewOpen: true, dirty: false })).toBe('exit-preview');
    expect(backNavigationAction({ modalOpen: false, previewOpen: true, dirty: true })).toBe('exit-preview');
  });

  // Back never silently discards (spec §2.11): once nothing is open, an
  // unsaved change must be confirmed before the editor is actually left.
  it('asks for confirmation before leaving with unsaved changes', () => {
    expect(backNavigationAction({ modalOpen: false, previewOpen: false, dirty: true })).toBe('confirm-dirty');
  });

  it('leaves for the template list once nothing is open and nothing is dirty', () => {
    expect(backNavigationAction({ modalOpen: false, previewOpen: false, dirty: false })).toBe('to-list');
  });
});
