import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSET_KIND, isAssetId, parseAssetKind } from './asset.dto.js';

describe('assetIdSchema (S6 Task 33)', () => {
  it('accepts a uuid and rejects anything else, so a bad URL is not a 500', () => {
    expect(isAssetId('9f1d2a3c-0000-4000-8000-000000000000')).toBe(true);
    expect(isAssetId('../../etc/passwd')).toBe(false);
    expect(isAssetId('')).toBe(false);
  });
});

/**
 * ADR-044 Task SV-4, SV decision 3. `kind` is the classification a PERSON
 * chooses -- is this file a logo or a picture -- and it is not the content
 * type, which ADR-043 §4 decides from magic bytes and never from what the
 * client says. Two different questions about the same file, so two fields.
 */
describe('parseAssetKind (ADR-044 Task SV-4)', () => {
  it('takes the two values the contract allows', () => {
    expect(parseAssetKind('logo')).toBe('logo');
    expect(parseAssetKind('image')).toBe('image');
  });

  it('treats "not stated" as the default rather than an error', () => {
    // An upload that says nothing about the file is ordinary -- the filter bar
    // is a convenience, not a required step -- and most uploads are pictures.
    expect(parseAssetKind(undefined)).toBe(DEFAULT_ASSET_KIND);
    expect(DEFAULT_ASSET_KIND).toBe('image');
  });

  it('treats an empty multipart field as not stated, not as a bad value', () => {
    // A form that renders the field and leaves it blank sends '', not nothing.
    // Refusing that would fail an upload over a field the user never touched.
    expect(parseAssetKind('')).toBe(DEFAULT_ASSET_KIND);
    expect(parseAssetKind('   ')).toBe(DEFAULT_ASSET_KIND);
  });

  it('refuses a value that is present and wrong, rather than silently defaulting', () => {
    // Silently rewriting 'banner' to 'image' would file the asset somewhere the
    // caller did not ask for, and the caller would never learn. The column's
    // CHECK would refuse it anyway; this refuses it earlier, with a 400 instead
    // of a 500.
    expect(parseAssetKind('banner')).toBeNull();
    expect(parseAssetKind('Logo')).toBeNull();
    expect(parseAssetKind('LOGO')).toBeNull();
    expect(parseAssetKind(7)).toBeNull();
    expect(parseAssetKind(null)).toBeNull();
  });
});
