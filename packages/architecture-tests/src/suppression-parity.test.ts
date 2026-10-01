import { describe, expect, it } from 'vitest';
import { read } from './repo.js';

/**
 * ARCH-SUPPRESSION-PARITY (M5-S4 CP2, D-108/DEC-107). BR-SEND-011's
 * suppressRecipient() has two producers that cannot share one implementation:
 * apps/worker/src/campaign-send/suppression.ts (a pg.PoolClient, called from
 * the synchronous SMTP hard-bounce path) and
 * apps/api/src/webhooks/suppression.ts (an EntityManager, called from the
 * provider webhook path). Neither app can import the other's source
 * (rootDir: "src", no shared workspace-package dependency), and the two
 * client types cannot share a function body without an adapter layer built
 * for no other reason -- so the API file is a deliberate transliteration,
 * not a duplicate that should have been an import. This test is the
 * mechanical guard DEC-107 promised: editing one file's post-conditions
 * without the other fails `pnpm check` in the same edit that caused the
 * drift, rather than the two files silently diverging the way M5-S3's plan
 * document and its own shipped code already did once (D-108).
 */
const WORKER_FILE = 'apps/worker/src/campaign-send/suppression.ts';
const API_FILE = 'apps/api/src/webhooks/suppression.ts';

const REQUIRED_TOKENS: readonly string[] = [
  "subscription_status = 'bounced'",
  'suppressed_at = now()',
  'suppression_reason',
  "'recipient.suppressed'",
  'suppressed_at IS NULL',
];

describe('ARCH-SUPPRESSION-PARITY: the worker and API suppression transliterations stay in step (D-108, DEC-107)', () => {
  it('both suppressRecipient() files exist', () => {
    expect(() => read(WORKER_FILE)).not.toThrow();
    expect(() => read(API_FILE)).not.toThrow();
  });

  it('each file names the other in a comment, so an editor of one is pointed at the other', () => {
    const worker = read(WORKER_FILE);
    const api = read(API_FILE);
    expect(worker, `${WORKER_FILE} does not reference ${API_FILE}`).toContain('apps/api/src/webhooks/suppression.ts');
    expect(api, `${API_FILE} does not reference ${WORKER_FILE}`).toContain('apps/worker/src/campaign-send/suppression.ts');
  });

  it('both files carry every required post-condition token', () => {
    const worker = read(WORKER_FILE);
    const api = read(API_FILE);
    const missingFromWorker = REQUIRED_TOKENS.filter((token) => !worker.includes(token));
    const missingFromApi = REQUIRED_TOKENS.filter((token) => !api.includes(token));
    expect(missingFromWorker, `${WORKER_FILE} is missing: ${missingFromWorker.join(', ')}`).toEqual([]);
    expect(missingFromApi, `${API_FILE} is missing: ${missingFromApi.join(', ')}`).toEqual([]);
  });
});
