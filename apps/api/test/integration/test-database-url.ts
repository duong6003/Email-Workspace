import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../../../');
config({ path: resolve(repoRoot, '.env'), quiet: true });
process.env.SENDER_CREDENTIAL_KEY ??= 'b'.repeat(64);

/**
 * Compose's postgres/redis services are only DNS-reachable as "postgres"/"redis"
 * inside the backend network. Host-run tests need the loopback port bindings
 * instead (EOW_POSTGRES_BIND/PORT), not the in-container DATABASE_URL host.
 */
export function testDatabaseUrl(): string {
  const user = process.env.EOW_POSTGRES_USER ?? 'eow';
  const password = process.env.EOW_POSTGRES_PASSWORD;
  const db = process.env.EOW_POSTGRES_DB ?? 'eow';
  const bind = process.env.EOW_POSTGRES_BIND ?? '127.0.0.1';
  const port = process.env.EOW_POSTGRES_PORT ?? '55432';
  if (!password) {
    throw new Error('EOW_POSTGRES_PASSWORD is not set. Run `pnpm infra:up` with a local .env first.');
  }
  return `postgresql://${user}:${password}@${bind}:${port}/${db}`;
}

export function testAppDatabaseUrl(): string {
  const password = process.env.EOW_POSTGRES_APP_PASSWORD;
  const db = process.env.EOW_POSTGRES_DB ?? 'eow';
  const bind = process.env.EOW_POSTGRES_BIND ?? '127.0.0.1';
  const port = process.env.EOW_POSTGRES_PORT ?? '55432';
  if (!password) {
    throw new Error('EOW_POSTGRES_APP_PASSWORD is not set. Apply migrations with a local .env first.');
  }
  return `postgresql://eow_app:${password}@${bind}:${port}/${db}`;
}
