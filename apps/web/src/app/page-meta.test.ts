import { describe, expect, it } from 'vitest';
import { resolvePageMeta, isAutosaveRoute, isCampaignComposeRoute, isFocusRoute } from './page-meta.js';

describe('resolvePageMeta', () => {
  it('names the campaign list', () => {
    expect(resolvePageMeta('/campaigns').title).toBe('Chiến dịch');
  });

  it('names both composer routes the same', () => {
    expect(resolvePageMeta('/campaigns/new').title).toBe('Soạn chiến dịch');
    expect(resolvePageMeta('/campaigns/abc-123/edit').title).toBe('Soạn chiến dịch');
  });

  it('names the detail route, which a static pathname table could not match', () => {
    expect(resolvePageMeta('/campaigns/abc-123').title).toBe('Chi tiết chiến dịch');
  });

  it('still resolves the unchanged static routes', () => {
    expect(resolvePageMeta('/recipients').title).toBe('Người nhận');
    expect(resolvePageMeta('/templates').title).toBe('Email template');
    expect(resolvePageMeta('/settings/custom-fields').title).toBe('Cấu hình');
    expect(resolvePageMeta('/settings/senders').title).toBe('Cấu hình');
  });

  it('returns empty strings for an unknown path rather than throwing', () => {
    expect(resolvePageMeta('/nope')).toEqual({ title: '', description: '' });
  });

  it('titles the template editor route', () => {
    expect(resolvePageMeta('/templates/8f1c2d3e-0000-4000-8000-000000000000/edit').title).toBe('Chỉnh sửa template');
  });

  it('keeps the template list title', () => {
    expect(resolvePageMeta('/templates').title).toBe('Email template');
  });
});

describe('isAutosaveRoute', () => {
  it('is true for both composer routes and false elsewhere', () => {
    expect(isAutosaveRoute('/campaigns/new')).toBe(true);
    expect(isAutosaveRoute('/campaigns/abc-123/edit')).toBe(true);
    expect(isAutosaveRoute('/campaigns/abc-123')).toBe(false);
    expect(isAutosaveRoute('/campaigns')).toBe(false);
  });

  it('shows the autosave indicator on both composer and template editor routes', () => {
    expect(isAutosaveRoute('/campaigns/new')).toBe(true);
    expect(isAutosaveRoute('/campaigns/abc/edit')).toBe(true);
    expect(isAutosaveRoute('/templates/abc/edit')).toBe(true);
    expect(isAutosaveRoute('/templates')).toBe(false);
    expect(isAutosaveRoute('/campaigns')).toBe(false);
  });

  // Found by running the app: the shell hangs its "Gửi thử"/"Gửi ngay"
  // actions off a route predicate too. Widening one predicate for the save
  // indicator put send buttons on the template editor, which cannot send.
  it('keeps the campaign send actions off the template editor', () => {
    expect(isCampaignComposeRoute('/campaigns/new')).toBe(true);
    expect(isCampaignComposeRoute('/campaigns/abc/edit')).toBe(true);
    expect(isCampaignComposeRoute('/templates/abc/edit')).toBe(false);
    expect(isCampaignComposeRoute('/templates')).toBe(false);
  });
});

describe('isFocusRoute', () => {
  // ADR-041: a narrow, single-purpose predicate that decides layout only --
  // not a reuse of isAutosaveRoute, which answers a different question and
  // only happens to be true for the same route today (the trap page-meta.ts
  // already documents once for isCampaignComposeRoute).
  it('is true only for the builder route', () => {
    expect(isFocusRoute('/templates/abc/build')).toBe(true);
  });

  it('is false for the code editor route, the library and an unrelated compose route', () => {
    expect(isFocusRoute('/templates/abc/edit')).toBe(false);
    expect(isFocusRoute('/templates')).toBe(false);
    expect(isFocusRoute('/campaigns/new')).toBe(false);
  });
});
