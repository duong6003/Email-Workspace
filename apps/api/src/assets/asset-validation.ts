/**
 * ADR-043 §4: pure validation for uploaded builder images. No I/O, no framework
 * dependency -- the upload route calls this once bytes are in hand, and can also
 * check `Content-Length` against `MAX_ASSET_BYTES` before reading a body at all.
 */

/** Same number as `MAX_TEMPLATE_HTML_BYTES` on purpose -- ADR-043 §4: one cap to remember, not two. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

export type AllowedImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const ALLOWED_IMAGE_TYPES: readonly AllowedImageType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export type AssetValidationFailureReason =
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'SVG_REJECTED'
  | 'UNSUPPORTED_TYPE';

export type AssetValidationResult =
  | { ok: true; contentType: AllowedImageType }
  | { ok: false; reason: AssetValidationFailureReason; message: string };

function fail(reason: AssetValidationFailureReason, message: string): AssetValidationResult {
  return { ok: false, reason, message };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function isGif(bytes: Uint8Array): boolean {
  return asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a');
}

function isWebp(bytes: Uint8Array): boolean {
  return asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP');
}

/**
 * SVG is text, not a fixed byte signature -- detect it deliberately so it earns
 * its own refusal (ADR-043 §4) instead of falling through to "unrecognised".
 * A UTF-8 BOM or leading whitespace before `<?xml`/`<svg` is common real-world
 * output from image editors and must not dodge detection.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  let text = '';
  const probeLength = Math.min(bytes.length - start, 256);
  for (let i = 0; i < probeLength; i += 1) text += String.fromCharCode(bytes[start + i]);
  const trimmed = text.replace(/^\s+/, '');
  return /^(?:<\?xml|<svg)/i.test(trimmed);
}

/** Magic-byte sniff. Returns null when nothing recognised matches -- includes SVG so callers can give it a distinct reason. */
function sniffType(bytes: Uint8Array): AllowedImageType | 'image/svg+xml' | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (isGif(bytes)) return 'image/gif';
  if (isWebp(bytes)) return 'image/webp';
  if (looksLikeSvg(bytes)) return 'image/svg+xml';
  return null;
}

/**
 * The type is decided by magic bytes (ADR-043 §4). The client's declared
 * `Content-Type` is not a parameter here at all, which is a deliberate
 * narrowing of an earlier draft that refused an upload when the two disagreed.
 *
 * That check bought no safety: the sniffed type is what gets stored and served,
 * so a declared type never reaches storage and cannot influence how anything is
 * served. What it did buy was a way to refuse a perfectly good image -- real
 * clients send `image/jpg`, `application/octet-stream`, or nothing at all when
 * a file is dragged in without an extension. Refusing a valid JPEG over that is
 * a real cost against no benefit, so the declared value is simply ignored.
 */
export function validateAssetUpload(bytes: Uint8Array | Buffer): AssetValidationResult {
  if (bytes.length === 0) return fail('EMPTY_FILE', 'The uploaded file is empty.');
  if (bytes.length > MAX_ASSET_BYTES) return fail('FILE_TOO_LARGE', `The uploaded file exceeds the ${MAX_ASSET_BYTES}-byte limit.`);

  const sniffed = sniffType(bytes);

  if (sniffed === 'image/svg+xml') {
    return fail('SVG_REJECTED', 'SVG images are not accepted: they can carry scripts, and this route serves files from our own origin.');
  }

  // Anything unrecognised is refused, so an SVG that somehow evades the probe
  // window above still never gets stored -- it only gets a less specific
  // message. That is the right way round for a heuristic to fail.
  if (sniffed === null) {
    return fail('UNSUPPORTED_TYPE', 'The file is not a recognized PNG, JPEG, GIF, or WebP image.');
  }

  return { ok: true, contentType: sniffed };
}

export function isAllowedImageType(value: string): value is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(value);
}
