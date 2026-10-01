import { defineConfig, devices } from '@playwright/test';

/**
 * E2E/a11y/visual layer. ONE ORIGIN serves both the SPA and the API: every
 * spec addresses the API with a relative `/api/v1/...` path, never an absolute
 * one, whether through `page.request` (resolved against `baseURL`) or through
 * `fetch` inside `page.evaluate` (resolved against the page's own origin).
 *
 * That contract is satisfied by exactly one thing in this repo: the packaged
 * compose stack, where Nginx serves the built SPA and proxies `/api/` to the
 * api container (deploy/nginx/default.conf). So the prerequisite is
 *
 *     pnpm deploy:up          # rebuilds the images from current source
 *     E2E_BASE_URL=http://localhost:8080 pnpm --filter @eow/web e2e
 *
 * and http://localhost:8080 is the default here for that reason.
 *
 * The Vite dev server does NOT satisfy it and is not a supported target: it
 * proxies nothing under /api, and its SPA fallback answers GET only, so every
 * relative POST a fixture makes would 404 on index.html. Publishing the API on
 * host port 3000 and calling it absolutely does not satisfy it either -- the
 * api container binds no host port, and its WEB_ORIGIN is http://localhost:8080,
 * so a cross-origin call from the page would be CORS-blocked. Mixing the two
 * styles is what produced 84 "TypeError: Failed to fetch" failures on
 * 2026-08-25; the suite now has a single contract instead.
 *
 * No `webServer` auto-start: the API needs real PostgreSQL/Redis and its
 * compiled build (see EXECPLAN Surprises: tsx/esbuild does not emit TypeScript
 * decorator metadata, so `tsx watch` cannot run NestJS DI correctly).
 *
 * Three more prerequisites, all of them things a fixture needs rather than a
 * spec:
 *
 *  - `pnpm install && pnpm build` in the checkout the run starts from. The
 *    out-of-process fixture scripts (apps/api/scripts, apps/worker/scripts) are
 *    run on the host, and apps/api's one loads that app's `tsc` build for the
 *    D-22 reason above.
 *  - a repo-root `.env`. Those same scripts read it for the PostgreSQL/Redis
 *    credentials and reach both on their published host ports.
 *  - `EOW_PROVIDER_WEBHOOK_SECRET` set in that `.env` (and the stack brought up
 *    with it). Unset -- the default -- the provider webhook route answers 503
 *    and accepts nothing, which is the right posture for a deployment with no
 *    provider callbacks but leaves M5-S4's delivered/bounced capture with no
 *    way to deliver a signed event. The value must match the one
 *    visual-capture.spec.ts passes to seed-campaign-webhook-fixture.mjs.
 *
 * One block has a prerequisite of its own: "Visual evidence: handoff baseline"
 * photographs the approved handoff app rather than this one, and needs it
 * served at `HANDOFF_BASE_URL` (default http://localhost:4173). That app lives
 * in design-reference/ui-handoff-v2/source with its own npm lockfile, outside
 * this pnpm workspace, so it is installed and started separately:
 *
 *     cd design-reference/ui-handoff-v2/source && npm ci
 *     npx vite --port 4173 --strictPort
 *
 * Without it those three tests fail on a connection refused.
 */
export default defineConfig({
  testDir: './e2e',
  // Deletes the run's own fixture rows once, at the very end. A per-worker
  // `afterAll` cannot do this job: Playwright restarts the worker after a
  // failure, so such a hook fires repeatedly mid-run and overwrites the
  // failing test's error-context artifact with the cleanup page's.
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  // One retry, because this suite drives real infrastructure on the same
  // machine that is running it: the compose stack (api, worker, scheduler,
  // postgres, redis, mailpit), Playwright and Chromium all compete for the
  // same cores. Two runs on 2026-08-26 lost different tests to plain timeouts
  // under that load -- sign-in not navigating within the 5s default, a
  // custom-field round trip crossing 30s -- while everything about them was
  // otherwise correct. The list reporter counts a recovered test as "flaky"
  // rather than "passed", so this hides nothing: a test that needs its retry
  // still says so on every run.
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
