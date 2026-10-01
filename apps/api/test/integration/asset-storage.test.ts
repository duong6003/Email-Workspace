import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3AssetStorage, assetObjectKey, assetPublicUrl } from '../../src/assets/asset-storage.js';
import { testAssetStorageSettings } from './test-asset-storage.js';

/**
 * S6 Task 33: the storage adapter against a REAL object store, not a mock.
 *
 * A mocked S3 client would pass while `forcePathStyle`, the endpoint shape or
 * the credentials were all wrong -- which are exactly the things that differ
 * between MinIO and S3 and exactly what this adapter exists to hide. The point
 * of the container in `infra:up` is that this can be checked for real.
 */
describe('S3AssetStorage against MinIO', () => {
  const bucket = `eow-assets-test-${randomUUID().slice(0, 8)}`;
  const settings = testAssetStorageSettings(bucket);
  let storage: S3AssetStorage;

  beforeAll(async () => {
    const client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: true,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    storage = new S3AssetStorage(settings);
  }, 30_000);

  afterAll(async () => {
    // The bucket is left behind on purpose: ADR-043 §5 keeps objects forever,
    // so the adapter has no delete to clean up with, and inventing one here
    // would be inventing the capability the ADR deliberately withholds. Test
    // buckets are uniquely named and cost nothing in a dev container.
  });

  it('round-trips bytes and content type through a real store', async () => {
    const key = assetObjectKey(randomUUID(), randomUUID());
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

    await storage.put(key, bytes, 'image/png');
    const stored = await storage.get(key);

    expect(stored).not.toBeNull();
    expect(stored!.contentType).toBe('image/png');
    expect(stored!.byteSize).toBe(bytes.length);

    const chunks: Buffer[] = [];
    for await (const chunk of stored!.body) chunks.push(Buffer.from(chunk as Buffer));
    expect(new Uint8Array(Buffer.concat(chunks))).toEqual(bytes);
  }, 30_000);

  it('returns null for a missing object instead of throwing, so the route can answer 404', async () => {
    expect(await storage.get(assetObjectKey(randomUUID(), randomUUID()))).toBeNull();
  }, 30_000);

  it('keys by tenant, so one tenant\'s prefix can never be another\'s', () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const assetId = randomUUID();
    expect(assetObjectKey(tenantA, assetId)).toBe(`tenant/${tenantA}/${assetId}`);
    expect(assetObjectKey(tenantA, assetId)).not.toBe(assetObjectKey(tenantB, assetId));
  });

  it('builds an ABSOLUTE https url -- Task 32 measured that a relative src is stripped by the sanitizer', () => {
    const id = randomUUID();
    expect(assetPublicUrl('https://app.example.test', id, 'logo.png')).toBe(`https://app.example.test/api/v1/assets/${id}/logo.png`);
    // A trailing slash on the configured origin must not produce a double slash.
    expect(assetPublicUrl('https://app.example.test/', id, 'logo.png')).toBe(`https://app.example.test/api/v1/assets/${id}/logo.png`);
    // Vietnamese filenames are the norm here, and Task 32 measured that the
    // percent-encoded form survives the sanitizer intact.
    expect(assetPublicUrl('https://app.example.test', id, 'ảnh bìa.png')).toBe(`https://app.example.test/api/v1/assets/${id}/${encodeURIComponent('ảnh bìa.png')}`);
  });
});
