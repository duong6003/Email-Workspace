import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../../../');
config({ path: resolve(repoRoot, '.env'), quiet: true });

/**
 * MinIO is only DNS-reachable as "minio" inside the backend network, so a
 * host-run test needs the loopback binding instead -- the same split
 * `test-database-url.ts` already documents for postgres and redis.
 */
export function testAssetStorageSettings(bucket: string) {
  const password = process.env.EOW_MINIO_ROOT_PASSWORD;
  if (!password) {
    throw new Error('EOW_MINIO_ROOT_PASSWORD is not set. Run `pnpm infra:up` with a local .env first.');
  }
  const bind = process.env.EOW_MINIO_BIND ?? '127.0.0.1';
  const port = process.env.EOW_MINIO_PORT ?? '59000';
  return {
    endpoint: `http://${bind}:${port}`,
    region: process.env.ASSET_STORAGE_REGION ?? 'us-east-1',
    bucket,
    accessKeyId: process.env.EOW_MINIO_ROOT_USER ?? 'eow',
    secretAccessKey: password,
    forcePathStyle: true,
  };
}
