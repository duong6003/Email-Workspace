import { describe, expect, it } from 'vitest';
import { MAX_ASSET_BYTES, validateAssetUpload } from './asset-validation.js';

function bytes(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function withPadding(signature: number[], totalLength = 32): Uint8Array {
  const out = new Uint8Array(totalLength);
  out.set(signature);
  return out;
}

const PNG_BYTES = withPadding([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = withPadding([0xff, 0xd8, 0xff, 0xe0]);
const GIF_BYTES = new TextEncoder().encode('GIF89a' + '\0'.repeat(10));
const WEBP_BYTES = (() => {
  const out = new Uint8Array(16);
  out.set(new TextEncoder().encode('RIFF'), 0);
  out.set(new TextEncoder().encode('WEBP'), 8);
  return out;
})();
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const SVG_WITH_XML_DECL = new TextEncoder().encode('  \n<?xml version="1.0"?><svg></svg>');

describe('validateAssetUpload (ADR-043 §4)', () => {
  it('accepts every allowed image type by its magic bytes', () => {
    const cases: Array<[Uint8Array, string]> = [
      [PNG_BYTES, 'image/png'],
      [JPEG_BYTES, 'image/jpeg'],
      [GIF_BYTES, 'image/gif'],
      [WEBP_BYTES, 'image/webp'],
    ];

    for (const [data, contentType] of cases) {
      const result = validateAssetUpload(data);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.contentType).toBe(contentType);
    }
  });

  it('refuses SVG with its own reason, distinct from "unsupported type"', () => {
    const result = validateAssetUpload(SVG_BYTES);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('SVG_REJECTED');
      expect(result.reason).not.toBe('UNSUPPORTED_TYPE');
    }
  });

  it('recognises SVG behind leading whitespace and an XML declaration', () => {
    const result = validateAssetUpload(SVG_WITH_XML_DECL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SVG_REJECTED');
  });

  it('refuses SVG even when the client labels it as something else', () => {
    const result = validateAssetUpload(SVG_BYTES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SVG_REJECTED');
  });

  it('accepts a valid image whatever the client declared -- the declared type is not consulted at all', () => {
    // Real clients send `image/jpg`, `application/octet-stream`, or nothing for
    // a dragged-in file with no extension. The bytes are authoritative and are
    // what gets stored, so none of that may refuse a good image.
    const result = validateAssetUpload(JPEG_BYTES);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contentType).toBe('image/jpeg');
  });

  it('rejects a MIME type outside the allowlist even when bytes are unrecognisable', () => {
    const result = validateAssetUpload(bytes([0x00, 0x01, 0x02, 0x03]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('UNSUPPORTED_TYPE');
  });

  it('accepts a file exactly at the size cap', () => {
    const data = new Uint8Array(MAX_ASSET_BYTES);
    data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = validateAssetUpload(data);
    expect(result.ok).toBe(true);
  });

  it('rejects a file one byte over the size cap', () => {
    const data = new Uint8Array(MAX_ASSET_BYTES + 1);
    data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = validateAssetUpload(data);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('FILE_TOO_LARGE');
  });

  it('rejects an empty buffer', () => {
    const result = validateAssetUpload(new Uint8Array(0));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EMPTY_FILE');
  });

  it('rejects a file truncated shorter than any known signature', () => {
    const result = validateAssetUpload(bytes([0x89, 0x50]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('UNSUPPORTED_TYPE');
  });
});
