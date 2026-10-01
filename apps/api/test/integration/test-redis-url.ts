import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../../../');
config({ path: resolve(repoRoot, '.env'), quiet: true });

/**
 * Sibling of test-database-url.ts, for the same reason: Compose's redis service
 * is only DNS-reachable as "redis" inside the backend network, so host-run tests
 * need the loopback binding (EOW_REDIS_BIND/PORT) instead.
 *
 * The password is not optional. compose.yaml starts redis with
 * `--requirepass ${EOW_REDIS_PASSWORD}`, so a password-less URL is rejected with
 * NOAUTH. Since M2-S4 wired RealtimeGateway.onModuleInit() to open a real Redis
 * subscriber at Nest boot, that rejection now fails `beforeAll` for *every*
 * integration test that builds the real AppModule — which is what silently
 * skipped 30 previously-passing M1 tests (see EXECPLAN D-33). Centralised here
 * so a future test cannot reintroduce a hardcoded URL that drifts from .env.
 */
export function testRedisUrl(): string {
  const password = process.env.EOW_REDIS_PASSWORD;
  const bind = process.env.EOW_REDIS_BIND ?? '127.0.0.1';
  const port = process.env.EOW_REDIS_PORT ?? '56379';
  if (!password) {
    throw new Error('EOW_REDIS_PASSWORD is not set. Run `pnpm infra:up` with a local .env first.');
  }
  return `redis://:${encodeURIComponent(password)}@${bind}:${port}/0`;
}
