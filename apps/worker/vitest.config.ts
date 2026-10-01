import { defineConfig } from 'vitest/config';
import { sharedTestExclude, integrationHookTimeoutMs, integrationTestTimeoutMs } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    exclude: sharedTestExclude,
    // Worker integration files share the real PostgreSQL scan functions and
    // perform global trigger cleanup. Serial files prevent one fixture from
    // consuming another fixture's queued campaign or deadlocking on DDL.
    fileParallelism: false,
    // See vitest.shared.ts for why the defaults are too tight for this workspace.
    testTimeout: integrationTestTimeoutMs,
    hookTimeout: integrationHookTimeoutMs,
  },
});
