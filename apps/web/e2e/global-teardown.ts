import { request, type FullConfig } from '@playwright/test';
import { CLEANUP_ORDER, clearTrackedFixtures, FIXTURE_EMAIL_PREFIXES, FIXTURE_FIELD_KEY_PREFIXES, readTrackedFixtures } from './fixture-registry.js';

const DEMO_EMAIL = 'demo@acme.vn';
const DEMO_PASSWORD = 'Demo!Passw0rd';

/**
 * Deletes every fixture row the run created (see fixture-registry.ts for why
 * the suite has to clean up after itself at all).
 *
 * Best effort by design: a row a test already archived, or one the API refuses
 * to remove, must not fail a run whose tests all passed. A custom field a LIVE
 * template version still references is a legitimate 409 and stays behind --
 * correctly so. It used to be a permanent one even for archived templates,
 * which is how the tenant reached four figures of custom fields; that half was
 * a product bug and is fixed (custom-fields.service.ts `remove` now filters
 * deleted_at in its published-dependency query, as its draft query always did).
 *
 * A sender-config "removal" is not really one: DELETE /sender-configs/:id
 * calls disable() (sender-config.service.ts), which sets status='disabled'
 * and leaves deleted_at untouched, so the row never leaves GET
 * /sender-configs's own listing. Called here anyway -- disabling a config
 * this run created is still the correct cleanup action, just not one that
 * shrinks the tenant's sender_config count. Don't loop over that endpoint
 * expecting the count to drop: disable() also unconditionally inserts one
 * `sender_disabled` notification per call, and a retry loop that keeps seeing
 * the same "undeleted" rows will keep re-disabling them.
 */
export default async function globalTeardown(config: FullConfig): Promise<void> {
  const tracked = readTrackedFixtures();

  const baseURL = config.projects[0]?.use?.baseURL ?? process.env.E2E_BASE_URL ?? 'http://localhost:8080';
  const context = await request.newContext({ baseURL });
  let removed = 0;
  let swept = 0;
  let refused = 0;
  try {
    const login = await context.post('/api/v1/auth/login', {
      data: { email: DEMO_EMAIL, password: DEMO_PASSWORD, remember: false },
    });
    if (!login.ok()) {
      console.warn(`[e2e teardown] could not sign in (${login.status()}); leaving ${tracked.size} fixture group(s) behind`);
      return;
    }
    const { cookies } = await context.storageState();
    const csrf = cookies.find((cookie) => cookie.name === 'eow_csrf')?.value ?? '';

    for (const collection of CLEANUP_ORDER) {
      for (const id of tracked.get(collection) ?? []) {
        const response = await context.delete(`/api/v1/${collection}/${id}`, { headers: { 'x-csrf-token': csrf } });
        if (response.ok()) removed += 1;
        else refused += 1;
      }
    }
    clearTrackedFixtures();

    // The id registry misses whatever was created through the UI or in bulk,
    // which is why the tenant kept growing even with cleanup running. Sweep by
    // the suite's own naming conventions to catch the rest. Safe because the
    // API is tenant-scoped to the demo user and because the suite runs
    // serially (fullyParallel: false) -- a concurrent run would be sweeping
    // rows the other run still needs.
    for (const prefix of FIXTURE_EMAIL_PREFIXES) {
      for (;;) {
        const page = await context.get(`/api/v1/recipients?search=${encodeURIComponent(prefix)}&limit=100`);
        if (!page.ok()) break;
        const matches = ((await page.json()).items as Array<{ id: string; email: string }>)
          .filter((item) => item.email.startsWith(prefix));
        if (matches.length === 0) break;
        let deletedHere = 0;
        for (const item of matches) {
          const response = await context.delete(`/api/v1/recipients/${item.id}`, { headers: { 'x-csrf-token': csrf } });
          if (response.ok()) { swept += 1; deletedHere += 1; } else refused += 1;
        }
        // Every match refused means the next page is identical; stop rather
        // than loop forever on rows the API will not remove.
        if (deletedHere === 0) break;
      }
    }

    const fields = await context.get('/api/v1/custom-fields');
    if (fields.ok()) {
      const items = (await fields.json()).items as Array<{ id: string; key: string }>;
      for (const field of items.filter((item) => FIXTURE_FIELD_KEY_PREFIXES.some((prefix) => item.key.startsWith(prefix)))) {
        const response = await context.delete(`/api/v1/custom-fields/${field.id}`, { headers: { 'x-csrf-token': csrf } });
        if (response.ok()) swept += 1; else refused += 1;
      }
    }
  } catch (cause) {
    console.warn(`[e2e teardown] cleanup did not finish: ${String(cause)}`);
  } finally {
    await context.dispose();
    console.log(`[e2e teardown] removed ${removed} tracked row(s), swept ${swept} by name, ${refused} refused by the API`);
  }
}
