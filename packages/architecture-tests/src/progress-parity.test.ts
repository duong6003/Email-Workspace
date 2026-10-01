import { describe, expect, it } from 'vitest';
import { read } from './repo.js';

/**
 * ARCH-PROGRESS-PARITY (M6-S1 CP5, D-105/D-116/DEC-123). The progress-facts
 * read and progress-snapshot write have two producers that cannot share one
 * implementation: apps/worker/src/campaign-send/progress-snapshot.ts (a
 * pg.PoolClient, called from the synchronous send loop and reconciliation
 * job) and apps/api/src/campaigns/progress-snapshot.ts (an EntityManager,
 * called from the progress route and the webhook apply path). Neither app
 * can import the other's source (rootDir: "src", no shared workspace
 * package dependency), so the API file is a deliberate transliteration --
 * the same DEC-107 arrangement apps/worker/src/campaign-send/suppression.ts
 * and apps/api/src/webhooks/suppression.ts already established. This test
 * is the mechanical guard: editing one file's post-conditions without the
 * other fails `pnpm check` in the same edit that caused the drift.
 */
const WORKER_FILE = 'apps/worker/src/campaign-send/progress-snapshot.ts';
const API_FILE = 'apps/api/src/campaigns/progress-snapshot.ts';

const REQUIRED_TOKENS: readonly string[] = [
  'progress_seq = progress_seq + 1',
  "eligibility = 'sendable'",
  "outcome = 'submitted'",
  'pending_count',
  'queued_count',
  'submitted_count',
  'delivered_count',
  'bounced_count',
  'failed_count',
  'skipped_count',
  'cancelled_count',
];

describe('ARCH-PROGRESS-PARITY: the worker and API progress-snapshot transliterations stay in step (D-116, DEC-123)', () => {
  it('both progress-snapshot.ts files exist', () => {
    expect(() => read(WORKER_FILE)).not.toThrow();
    expect(() => read(API_FILE)).not.toThrow();
  });

  it('each file names the other in a comment, so an editor of one is pointed at the other', () => {
    const worker = read(WORKER_FILE);
    const api = read(API_FILE);
    expect(worker, `${WORKER_FILE} does not reference ${API_FILE}`).toContain('apps/api/src/campaigns/progress-snapshot.ts');
    expect(api, `${API_FILE} does not reference ${WORKER_FILE}`).toContain('apps/worker/src/campaign-send/progress-snapshot.ts');
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

/**
 * ARCH-PROGRESS-PARITY, second pair (M6-S1 CP9, DEC-127). progress-reconcile.ts
 * repairs campaign_recipient from the delivery_event ledger using the exact
 * same ordering/legal-transition decision the live webhook path uses (A16) --
 * not a second copy of BR-SEND-008's decision table with its own bugs. Same
 * DEC-107 transliteration arrangement, same guard shape.
 */
const DECISION_WORKER_FILE = 'apps/worker/src/campaign-send/delivery-decision.ts';
const DECISION_API_FILE = 'apps/api/src/webhooks/apply-decision.ts';

const DECISION_REQUIRED_TOKENS: readonly string[] = [
  "'complaint'",
  "'deferred'",
  'ignored_out_of_order',
  'ignored_illegal_transition',
  'ignored_not_applicable',
  'isLegalMessageTransition',
  'hard_bounce',
];

describe('ARCH-PROGRESS-PARITY: the worker and API delivery-decision transliterations stay in step (DEC-127)', () => {
  it('both delivery-decision files exist', () => {
    expect(() => read(DECISION_WORKER_FILE)).not.toThrow();
    expect(() => read(DECISION_API_FILE)).not.toThrow();
  });

  it('each file names the other in a comment', () => {
    const worker = read(DECISION_WORKER_FILE);
    const api = read(DECISION_API_FILE);
    expect(worker, `${DECISION_WORKER_FILE} does not reference ${DECISION_API_FILE}`).toContain('apps/api/src/webhooks/apply-decision.ts');
    expect(api, `${DECISION_API_FILE} does not reference ${DECISION_WORKER_FILE}`).toContain('apps/worker/src/campaign-send/delivery-decision.ts');
  });

  it('both files carry every required decision-table token', () => {
    const worker = read(DECISION_WORKER_FILE);
    const api = read(DECISION_API_FILE);
    const missingFromWorker = DECISION_REQUIRED_TOKENS.filter((token) => !worker.includes(token));
    const missingFromApi = DECISION_REQUIRED_TOKENS.filter((token) => !api.includes(token));
    expect(missingFromWorker, `${DECISION_WORKER_FILE} is missing: ${missingFromWorker.join(', ')}`).toEqual([]);
    expect(missingFromApi, `${DECISION_API_FILE} is missing: ${missingFromApi.join(', ')}`).toEqual([]);
  });
});
