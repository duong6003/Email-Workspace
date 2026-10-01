import { z } from 'zod';

/**
 * There is no request body to validate here -- an upload is multipart and its
 * bytes are validated by magic bytes, not by a schema (ADR-043 §4). What does
 * need validating is the id in the path, and skipping it is not cosmetic:
 * TypeORM hands a malformed id straight to Postgres, which raises
 * `invalid input syntax for type uuid` and turns a bad URL into a 500. Measured
 * before fixing.
 */
export const assetIdSchema = z.string().uuid();

export function isAssetId(value: string): boolean {
  return assetIdSchema.safeParse(value).success;
}

/**
 * ADR-044 Task SV-4 (SV decision 3): what a person says this file IS -- the
 * company logo, or a picture used in a message. Deliberately NOT the content
 * type: ADR-043 §4 decides that from magic bytes and never from what the client
 * declares, and a PNG can be either of these. Two questions, two fields.
 *
 * The library filter bar (MC-UI-005, `v3-asset-filterbar`) is the reason it
 * exists, and the brand kit section (`v3-brand-kit`) is what reads it.
 */
export type AssetKind = 'logo' | 'image';

/** Most uploads are pictures; a logo is the exception someone marks. Also the backfill value for every row that predates migration 078. */
export const DEFAULT_ASSET_KIND: AssetKind = 'image';

export const assetKindSchema = z.enum(['logo', 'image']);

/**
 * `null` means "present and not one of the two" -- the caller turns that into a
 * 400. Absent (or an empty multipart field, which is what a form sends when it
 * renders the control and nobody touches it) is not an error: it means the
 * upload said nothing, and saying nothing is the default, not a mistake.
 *
 * Case-sensitive on purpose. The column's CHECK stores exactly these two
 * strings, so accepting 'Logo' here would only move the failure to Postgres and
 * turn a 400 into a 500.
 */
export function parseAssetKind(value: unknown): AssetKind | null {
  if (value === undefined) return DEFAULT_ASSET_KIND;
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_ASSET_KIND;
  const parsed = assetKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
