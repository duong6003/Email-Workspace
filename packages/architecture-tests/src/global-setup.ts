import { sweepStaleFixtures } from './docker-fixtures.js';

/**
 * The backstop under the per-test sweep in migration-runner-behavior.test.ts.
 *
 * That hook removes a fixture whose test vitest killed, which covers the case
 * this suite actually hits. It cannot cover the case where the worker itself
 * dies -- an interrupted run, a crashed process, a rebooted machine -- because
 * the registry lives in the worker's memory. So the run also sweeps at both
 * ends, using only the fixture label and the creation time stamped on it: a run
 * that was killed outright is cleaned up by the next one, instead of leaving
 * garbage that makes the next one slower and likelier to be killed in turn.
 *
 * Both sweeps ignore anything younger than STALE_FIXTURE_AGE_MS, so a second
 * copy of this suite running concurrently on the same machine is never touched.
 */
export default async function setup(): Promise<() => Promise<void>> {
  report(await sweepStaleFixtures(), 'before');
  return async () => { report(await sweepStaleFixtures(), 'after'); };
}

function report(removed: string[], phase: string): void {
  if (removed.length === 0) return;
  console.warn(
    `Swept ${String(removed.length)} stale migration fixture object(s) ${phase} the run: ${removed.join('; ')}`,
  );
}
