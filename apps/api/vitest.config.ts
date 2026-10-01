import { defineConfig } from 'vitest/config';
import { sharedTestExclude, integrationHookTimeoutMs, integrationTestTimeoutMs } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    exclude: sharedTestExclude,
    // Integration fixtures temporarily disable immutable-table triggers for
    // bounded cleanup. Those ALTER TABLE operations are database-global, so
    // parallel files can deadlock even though every fixture uses its own
    // tenant. Keep files serial; concurrency is still exercised explicitly
    // inside the tests that own a concurrency acceptance criterion.
    fileParallelism: false,
    // See vitest.shared.ts for why the defaults are too tight for this workspace.
    testTimeout: integrationTestTimeoutMs,
    hookTimeout: integrationHookTimeoutMs,
  },
});
