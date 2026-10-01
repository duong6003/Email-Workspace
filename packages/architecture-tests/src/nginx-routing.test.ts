import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_CREATED_LABEL, FIXTURE_LABEL, FIXTURE_NAME_PREFIX, releaseFixture, run, sweepTrackedFixtures, trackFixture,
  trackedFixtureCount, type CommandResult, type CommandRunner,
} from './docker-fixtures.js';

/**
 * ARCH-NGINX-ROUTING.
 *
 * Found 2026-09-03 while verifying the S6 asset feature over a real domain: a
 * plain `curl -X POST http://<host>:8080/api/v1/assets` -- the exact request
 * `apps/web/src/api/assets.ts` sends -- came back `301 Moved Permanently`
 * instead of reaching the API. `deploy/nginx/default.conf`'s asset location was
 * declared as `location /api/v1/assets/` (trailing slash); nginx's own
 * directory-redirect behaviour for a trailing-slash prefix location fires on
 * the bare path with no slash, and the redirect nginx synthesizes reflects its
 * OWN scheme and port (`http://<host>:8080`), never whatever a proxy or tunnel
 * presented externally. Confirmed with `docker exec ... nginx -T`: identical
 * behaviour in the real container, no stale image involved. This is a
 * pre-existing bug (Task 36 added the location), unrelated to https/tunnels --
 * it breaks the upload endpoint on EVERY deployment, and a browser hitting it
 * from an https page sees the `http://` redirect target as mixed content and
 * fails with a bare "Failed to fetch", which is exactly how it surfaced.
 *
 * This proves nginx's routing decision alone, against the real config file,
 * with no Postgres/API/MinIO -- a tiny fake backend on the same Docker network
 * is enough to distinguish "nginx proxied the request" (reaches the backend,
 * 200) from "nginx redirected before proxying" (301, backend never touched).
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const NGINX_CONFIG = resolve(REPO_ROOT, 'deploy/nginx/default.conf');
/** A fixed high port: this suite's other fixtures never bind a host port at all (container-to-container networking only), so there is no shared-port registry to draw from here -- one in the ephemeral range is enough. */
const HOST_PORT = 18173;

type Harness = { network: string; backend: string; nginx: string; configDir: string };

async function startHarness(command: CommandRunner = run): Promise<Harness> {
  const suffix = randomUUID().replaceAll('-', '');
  const network = `${FIXTURE_NAME_PREFIX}nginx_net_${suffix}`;
  const backend = `${FIXTURE_NAME_PREFIX}nginx_backend_${suffix}`;
  const nginx = `${FIXTURE_NAME_PREFIX}nginx_under_test_${suffix}`;
  const labels = ['--label', `${FIXTURE_LABEL}=1`, '--label', `${FIXTURE_CREATED_LABEL}=${String(Date.now())}`];
  const configDir = mkdtempSync(join(tmpdir(), 'eow-nginx-routing-'));
  const harness: Harness = { network, backend, nginx, configDir };

  // Registered before the first object exists, not after the last one. Vitest
  // kills a timed-out test mid-await, so a registration that waits for this
  // function to return covers nothing that this function itself created.
  // Measured 2026-09-04: a timeout inside here left `eow_cp1_nginx_backend_*`
  // running until it was removed by hand, because `harness` was never assigned
  // and the registry had never heard of it. `migration-runner-behavior.test.ts`
  // had already solved this exact problem for its own fixtures; this file was
  // written without inheriting the pattern.
  trackFixture(startHarness, `nginx routing fixture ${nginx}`, () => stopHarness(harness, command));

  await command('docker', ['network', 'create', ...labels, network]);

  // The fake backend: reachable at `api:3000`, matching `deploy/nginx/default.conf`'s
  // `set $api_upstream api:3000;` exactly, so nginx's resolver finds it the same
  // way it finds the real API container in compose.
  writeFileSync(join(configDir, 'default.conf'), 'server { listen 3000; location / { return 200 "backend-reached"; } }\n');
  await command('docker', [
    'run', '-d', ...labels, '--name', backend, '--network', network, '--network-alias', 'api',
    '-v', `${join(configDir, 'default.conf')}:/etc/nginx/conf.d/default.conf:ro`,
    'nginx:1.29-alpine',
  ]);

  await command('docker', [
    'run', '-d', ...labels, '--name', nginx, '--network', network, '-p', `127.0.0.1:${HOST_PORT}:8080`,
    '-v', `${NGINX_CONFIG}:/etc/nginx/conf.d/default.conf:ro`,
    'nginx:1.29-alpine',
  ]);

  return harness;
}

/** Removes whatever exists. `docker rm`/`network rm` on a name that was never created exits non-zero, and `run` reports rather than throws, so this is safe on a half-built harness. */
async function stopHarness(harness: Harness, command: CommandRunner = run): Promise<void> {
  await command('docker', ['rm', '-f', '-v', harness.nginx]);
  await command('docker', ['rm', '-f', '-v', harness.backend]);
  await command('docker', ['network', 'rm', harness.network]);
  rmSync(harness.configDir, { force: true, recursive: true });
}

/**
 * Waits for nginx's own healthz to answer, so the first real request does not race container startup.
 *
 * Every attempt is bounded. Docker's host-port proxy accepts the TCP connection
 * as soon as the port is published -- before anything inside the container is
 * listening -- so an unbounded `fetch` here does not fail fast, it hangs, and
 * the whole per-test budget drains into one attempt that will never answer.
 */
async function waitReady(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${HOST_PORT}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch { /* not listening yet, or accepted-but-silent */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('nginx fixture did not become ready in time');
}

describe('ARCH-NGINX-ROUTING: the asset endpoints route without a trailing-slash redirect', () => {
  /**
   * The teardown that holds when a test is killed. This replaces the `afterAll`
   * this file used to carry: that hook only fired once the test body had assigned
   * its harness variable, which never happens if the kill lands inside
   * `startHarness` -- exactly the case that leaked a container on 2026-09-04. It
   * also ran after `afterEach`, so the two could not simply coexist.
   */
  afterEach(async () => {
    const swept = await sweepTrackedFixtures();
    if (swept.length > 0) console.warn(`Swept ${String(swept.length)} abandoned nginx fixture(s): ${swept.join('; ')}`);
  });

  it('registers its teardown before it creates the first Docker object', async () => {
    const registeredAtCall: number[] = [];
    const command = vi.fn(async (): Promise<CommandResult> => {
      registeredAtCall.push(trackedFixtureCount());
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const built = await startHarness(command);

    expect(registeredAtCall[0], 'the first docker call ran with no teardown registered -- a kill here leaks whatever it creates').toBe(1);
    expect(await sweepTrackedFixtures()).toEqual([`nginx routing fixture ${built.nginx}`]);
    expect(command).toHaveBeenCalledWith('docker', ['rm', '-f', '-v', built.nginx]);
    expect(trackedFixtureCount()).toBe(0);
  });

  /**
   * 90s, matching this suite's other Docker-fixture tests (the plain-container
   * ones in `migration-runner-behavior.test.ts`; its Compose ones take 180s).
   * This test was written at 30s -- `vitest.shared.ts`'s default for tests that
   * do no Docker work at all -- and it held only on an idle machine: 11.5s run
   * alone, over 30s inside the full `pnpm check`, where 23 files run in parallel
   * and the package takes ~15 minutes. It failed for want of a budget, not for
   * anything wrong with the routing it guards, and a gate that goes red for
   * reasons unrelated to its subject teaches people to ignore it.
   */
  it('proxies /api/v1/assets straight to the backend -- bare path, file-serving path, and never a redirect', async () => {
    const harness = await startHarness();
    try {
      await waitReady();

      // The exact request apps/web/src/api/assets.ts sends for `listAssets`/`uploadAsset`.
      const get = await fetch(`http://127.0.0.1:${HOST_PORT}/api/v1/assets`, { redirect: 'manual' });
      expect(get.status, 'GET /api/v1/assets must reach the backend, not redirect').toBe(200);
      expect(await get.text()).toBe('backend-reached');

      const post = await fetch(`http://127.0.0.1:${HOST_PORT}/api/v1/assets`, { method: 'POST', redirect: 'manual' });
      expect(post.status, 'POST /api/v1/assets (the upload route) must reach the backend, not redirect').toBe(200);

      // The file-serving route (getAssetFile) still has to match -- fixing the
      // bare path must not narrow the location so it stops covering this one.
      const served = await fetch(`http://127.0.0.1:${HOST_PORT}/api/v1/assets/some-id/logo.png`, { redirect: 'manual' });
      expect(served.status).toBe(200);

      // The failure mode this bug actually caused: nginx's own redirect names its
      // internal http/8080 address, which an https-terminating proxy or tunnel
      // never matches -- a browser on the https page sees mixed content and the
      // request fails outright, surfacing as a bare "Failed to fetch".
      expect(get.headers.get('location')).toBeNull();
    } finally {
      await stopHarness(harness);
      releaseFixture(startHarness);
    }
  }, 90_000);
});
