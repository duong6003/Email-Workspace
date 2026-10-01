import { describe, expect, it } from 'vitest';
import { read } from './repo.js';

/**
 * ARCH-JOB-WIRING: every job name the worker handles must be enqueued by the
 * scheduler, and every job name the scheduler enqueues must be handled by the
 * worker. D-87 and D-115 were both the same defect -- a `case` the scheduler
 * never enqueued (fabricated success) or a tick entry the worker answered with
 * a stub. Neither could survive this comparison.
 */
const WORKER_CASE = /case '([a-z-]+)':/g;
const SCHEDULER_ADD = /queue\.add\('([a-z-]+)'/g;

function names(source: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].map((match) => match[1]!).sort();
}

describe('ARCH-JOB-WIRING: scheduler and worker agree on every job name', () => {
  it('has no job name on only one side', () => {
    const handled = names(read('apps/worker/src/main.ts'), WORKER_CASE);
    const enqueued = names(read('apps/scheduler/src/main.ts'), SCHEDULER_ADD);
    expect(handled.length, 'no worker job cases found — the scanner path is wrong').toBeGreaterThan(0);
    expect(handled).toEqual(enqueued);
  });
});
