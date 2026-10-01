import { describe, expect, it } from 'vitest';
import { read } from './repo.js';

/**
 * ARCH-EXPORT-PARITY (M6-S3 CP8, ADR-027). BR-HIS-003/BR-HIS-007's export
 * renderer has two producers that cannot share one implementation:
 * apps/worker/src/export-processor.ts (invoked by the queued-export scan
 * for a background export) and apps/api/src/campaigns/export-render.ts
 * (invoked inline at export creation for a small export). Neither app can
 * import the other's source (rootDir: "src", no shared workspace package
 * dependency), so the worker file is a deliberate transliteration -- the
 * same DEC-107 arrangement apps/worker/src/campaign-send/suppression.ts and
 * apps/api/src/webhooks/suppression.ts already established. This test is
 * the mechanical guard: editing one file's post-conditions without the
 * other fails `pnpm check` in the same edit that caused the drift.
 */
const WORKER_FILE = 'apps/worker/src/export-processor.ts';
const API_FILE = 'apps/api/src/campaigns/export-render.ts';

const REQUIRED_TOKENS: readonly string[] = [
  'recipient_email',
  'skipped_reason',
  'attempt_count',
  'last_error_code',
  'last_error_class',
  'last_error_reason',
  'submitted_at',
  'delivered_at',
];

describe('ARCH-EXPORT-PARITY: the worker and API export-render transliterations stay in step (ADR-027)', () => {
  it('both export-render files exist', () => {
    expect(() => read(WORKER_FILE)).not.toThrow();
    expect(() => read(API_FILE)).not.toThrow();
  });

  it('each file names the other in a comment, so an editor of one is pointed at the other', () => {
    const worker = read(WORKER_FILE);
    const api = read(API_FILE);
    expect(worker, `${WORKER_FILE} does not reference ${API_FILE}`).toContain('apps/api/src/campaigns/export-render.ts');
    expect(api, `${API_FILE} does not reference ${WORKER_FILE}`).toContain('apps/worker/src/export-processor.ts');
  });

  it('both files carry every required CSV column token', () => {
    const worker = read(WORKER_FILE);
    const api = read(API_FILE);
    const missingFromWorker = REQUIRED_TOKENS.filter((token) => !worker.includes(token));
    const missingFromApi = REQUIRED_TOKENS.filter((token) => !api.includes(token));
    expect(missingFromWorker, `${WORKER_FILE} is missing: ${missingFromWorker.join(', ')}`).toEqual([]);
    expect(missingFromApi, `${API_FILE} is missing: ${missingFromApi.join(', ')}`).toEqual([]);
  });
});
