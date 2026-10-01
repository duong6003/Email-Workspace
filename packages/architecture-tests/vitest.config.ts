import { defineConfig } from 'vitest/config';
import { sharedTestExclude, integrationHookTimeoutMs, integrationTestTimeoutMs } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    exclude: sharedTestExclude,
    // Sweeps Docker fixtures left by a run that was killed before its per-test
    // cleanup could run. See src/global-setup.ts.
    globalSetup: ['./src/global-setup.ts'],
    // See vitest.shared.ts. Its reasoning was applied to apps/api and apps/worker
    // but not here, which left this package on vitest's 5s default even though
    // its tests are whole-repo file scans running in parallel with each other --
    // the same CPU-oversubscription shape, without a database in sight.
    // Surfaced when migration-execution-safety.test.ts (42 cases) joined the
    // package: text-encoding.test.ts blew the 5s budget at 10.3s under load,
    // while passing in 220ms when run alone. A timeout, not a mojibake finding.
    testTimeout: integrationTestTimeoutMs,
    hookTimeout: integrationHookTimeoutMs,
  },
});
