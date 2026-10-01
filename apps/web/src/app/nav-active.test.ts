import { describe, expect, it } from 'vitest';
import { isNavItemActive } from './nav-active.js';

describe('sidebar nav active matching', () => {
  it('matches the item\'s own path', () => {
    expect(isNavItemActive({ path: '/settings/senders' }, '/settings/senders')).toBe(true);
  });

  it('matches a listed sibling path', () => {
    expect(isNavItemActive(
      { path: '/settings/senders', activePaths: ['/settings/policy', '/settings/custom-fields', '/settings/global-variables'] },
      '/settings/custom-fields',
    )).toBe(true);
  });

  it('does not match an unrelated path', () => {
    expect(isNavItemActive(
      { path: '/settings/senders', activePaths: ['/settings/policy'] },
      '/history',
    )).toBe(false);
  });

  it('does not match a sibling path when activePaths is absent', () => {
    expect(isNavItemActive({ path: '/settings/senders' }, '/settings/policy')).toBe(false);
  });

  it('stays active on a descendant route', () => {
    expect(isNavItemActive({ path: '/campaigns' }, '/campaigns/abc')).toBe(true);
    expect(isNavItemActive({ path: '/campaigns' }, '/campaigns/abc/edit')).toBe(true);
    expect(isNavItemActive({ path: '/campaigns' }, '/campaigns/new')).toBe(true);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    expect(isNavItemActive({ path: '/campaigns' }, '/campaigns-archive')).toBe(false);
  });
});
