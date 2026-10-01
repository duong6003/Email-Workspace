import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

/**
 * ADR-043 §1/§3. The object store, behind an interface so production can point
 * at S3/R2/Spaces by changing environment variables and nothing else, and so
 * every call site stays testable without one.
 *
 * There is no `delete`, and its absence is the design. ADR-043 §5 keeps assets
 * forever: an immutable published version still points at an asset's URL, so
 * removing the object would break an email that can no longer be edited.
 * "Deleting" an asset sets `archived_at` on the row and the object is still
 * served. An interface with a `delete` on it would be an invitation to use one.
 *
 * There is no overwrite either: `replace` (MC-UI-005) creates a NEW asset and
 * repoints the node, because overwriting bytes in place would change the image
 * inside every already-published email that references it.
 */
export type StoredObject = { body: Readable; contentType: string; byteSize: number };

export interface AssetStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
}

/**
 * `tenant/<tenant_id>/<asset_id>` (ADR-043 §3). A prefix rather than a bucket
 * per tenant: none of the five service-extraction criteria in the Mailcraft
 * builder spec §3.3 is true today, and moving to
 * per-tenant buckets later changes this one function rather than the data
 * model.
 */
export function assetObjectKey(tenantId: string, assetId: string): string {
  return `tenant/${tenantId}/${assetId}`;
}

export type AssetStorageSettings = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO serves buckets as a path segment rather than a subdomain; real S3 does the opposite. */
  forcePathStyle: boolean;
};

export class S3AssetStorage implements AssetStorage {
  private readonly client: S3Client;

  constructor(private readonly settings: AssetStorageSettings) {
    const config: S3ClientConfig = {
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    };
    this.client = new S3Client(config);
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.settings.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
  }

  /**
   * `null` for a missing object rather than a thrown error, so the serving
   * route answers 404 the same way it does for an unknown id. A row can outlive
   * its object only through operator error, and that should read as "not found",
   * not as a 500.
   */
  async get(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }));
      if (!result.Body) return null;
      return {
        body: result.Body as Readable,
        contentType: result.ContentType ?? 'application/octet-stream',
        byteSize: result.ContentLength ?? 0,
      };
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw error;
    }
  }
}

/**
 * The served URL (ADR-043 §2), and the reason it takes an origin rather than
 * building a relative path.
 *
 * Measured in Task 32 against the real sanitizer: a root-relative
 * `/api/v1/assets/...` src is DROPPED, because `isPermittedImageSource` matches
 * `^https:` and has no notion of "same origin". So the API has to know its own
 * public origin and emit an absolute URL. Getting this wrong does not fail
 * loudly -- it silently breaks every image in already-published email, which
 * cannot be re-edited (ADR-043 constraint 2).
 *
 * `/api/v1/...`, matching `app.setGlobalPrefix('api/v1')` (main.ts) -- every
 * other route in this API sits under that prefix, and `AssetsController` is no
 * exception (`@Controller('assets')`, mounted the same way as everything else).
 * This function omitted the prefix from 2026-09 (Task 36) until 2026-09-03,
 * when a real domain was fetched end to end for the first time: every asset URL
 * ever minted 404'd, because nothing before that point ever made an HTTP
 * request to the exact string this function returned -- every test that
 * checked "does the serving route work" reconstructed the path by hand instead
 * (`assets-http.test.ts`), and every test that checked "does the URL shape
 * survive the sanitizer" only ever compared this function's output against
 * itself (`builder-block-sanitizer.test.ts`). Both were internally consistent
 * and both were wrong the same way, which is exactly how the gap stayed
 * invisible: nothing computed the URL one way and dereferenced it another.
 */
export function assetPublicUrl(publicOrigin: string, assetId: string, filename: string): string {
  return `${publicOrigin.replace(/\/+$/, '')}/api/v1/assets/${assetId}/${encodeURIComponent(filename)}`;
}
