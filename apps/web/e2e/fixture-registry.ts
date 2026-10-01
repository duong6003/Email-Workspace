import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every fixture row the suite creates, recorded so global-teardown.ts can
 * delete it once the whole run is over.
 *
 * The demo tenant is shared by every run and the suite used to leave every
 * fixture behind: by 2026-08-25 it held 345 live `email_template` rows and
 * 7,915 recipients. That is not merely untidy. GET /templates caps at 100 rows
 * (template.dto.ts), so an unbounded backlog silently pushes a fixture off the
 * end of the grid the test that created it is about to look at, and the
 * `bounced` recipients the M5-S4 webhook fixture leaves behind are what stopped
 * "recipients — empty" from being empty.
 *
 * The registry is a file, not a module-level array, for two reasons: Playwright
 * restarts the worker process after a failure (so a per-worker `afterAll` runs
 * repeatedly mid-run, overwriting the failing test's own error-context
 * artifact), and the run is spread across several worker processes that share
 * no memory. A file is append-only, crash-safe, and read once at the end.
 */
export type FixtureCollection =
  | 'templates'
  | 'recipient-lists'
  | 'tags'
  | 'recipients'
  | 'custom-fields'
  | 'sender-configs';

/**
 * Names the suite gives its own rows. The id registry cannot cover everything:
 * recipients.spec.ts and custom-fields.spec.ts create through the UI, so no
 * response body passes through a place that could call trackFixture, and some
 * API fixtures create rows in bulk that are never individually registered. A
 * sweep by name catches both.
 *
 * Measured on the shared dev tenant on 2026-08-26, every recipient row and
 * every custom field matched one of these; the handful that did not belonged
 * to throwaway API-test tenants the e2e teardown cannot reach anyway, since it
 * authenticates as the demo user and the API is tenant-scoped.
 *
 * Adding a prefix here is how a new fixture gets cleaned up. Reusing one of
 * these prefixes for anything a human should keep is how data gets lost.
 */
export const FIXTURE_EMAIL_PREFIXES = ['send-', 'visual-', 'gate-', 'reconcile-', 'ok-', 'snapshot-', 'e2e-', 'schedule-', 'dispatch-'];
export const FIXTURE_FIELD_KEY_PREFIXES = ['visual_', 'office_', 'employee_', 'rbac_', 'e2e_city_'];

/** Deletion order: content first, then the rows it points at. */
export const CLEANUP_ORDER: FixtureCollection[] = [
  'templates',
  'recipient-lists',
  'tags',
  'recipients',
  'custom-fields',
  'sender-configs',
];

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_LOG_PATH = resolve(__dirname, '../test-results/created-fixtures.log');

export function trackFixture(collection: FixtureCollection, id: string | null | undefined): void {
  if (!id) return;
  mkdirSync(dirname(FIXTURE_LOG_PATH), { recursive: true });
  appendFileSync(FIXTURE_LOG_PATH, `${collection} ${id}\n`, 'utf8');
}

export function readTrackedFixtures(): Map<FixtureCollection, string[]> {
  const grouped = new Map<FixtureCollection, string[]>();
  let raw: string;
  try {
    raw = readFileSync(FIXTURE_LOG_PATH, 'utf8');
  } catch {
    return grouped;
  }
  for (const line of raw.split('\n')) {
    const [collection, id] = line.trim().split(' ');
    if (!collection || !id) continue;
    if (!CLEANUP_ORDER.includes(collection as FixtureCollection)) continue;
    const bucket = grouped.get(collection as FixtureCollection) ?? [];
    if (!bucket.includes(id)) bucket.push(id);
    grouped.set(collection as FixtureCollection, bucket);
  }
  return grouped;
}

export function clearTrackedFixtures(): void {
  rmSync(FIXTURE_LOG_PATH, { force: true });
}
