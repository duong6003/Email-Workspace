/**
 * Vitest's default test-file exclude list is only node_modules and .git.
 * Every workspace package here compiles src/**\/*.test.ts into dist/, so
 * without this, `pnpm build` followed by `pnpm test` (as `pnpm check` does
 * across its own three-phase run, and as any repeated local run does)
 * silently double-executes and double-counts every test once dist/ exists.
 *
 * Exported as a plain value (not a vitest config object) because this file
 * has no package.json of its own — importing `vitest/config` from here
 * would resolve against the repo root's node_modules, not the importing
 * package's, and fail under pnpm's strict per-package resolution.
 */
export const sharedTestExclude = ['**/node_modules/**', '**/dist/**', '**/.git/**'];

/**
 * Timeouts for the workspaces whose tests do real integration work — building a
 * full Nest application, hashing with argon2id, spawning a compiled process, or
 * talking to real PostgreSQL/Redis.
 *
 * Vitest's defaults (5s per test, 10s per hook) are only adequate on an idle
 * machine. `pnpm -r test` runs six workspaces concurrently and each of those
 * runs its own test files in parallel, so the CPU is heavily oversubscribed —
 * and argon2id is *designed* to be CPU-hard, so a test that hashes five
 * passwords (the BR-AUTH-005 lockout case) is the first to blow a 5s budget.
 *
 * That produced a ~1-in-3 flaky failure where `rbac-matrix.test.ts`'s
 * `beforeAll` timed out, vitest reported its 25 tests as *skipped*, and the run
 * looked like a partially-green suite rather than an environment problem.
 *
 * Diagnosed by measurement rather than assumption: peak PostgreSQL connections
 * during a reproduced failing run were 11 of 100, which rules out connection
 * exhaustion, and the reported errors were "Hook timed out in 10000ms" /
 * "Test timed out in 5000ms" / "Process did not exit within the timeout".
 *
 * These values are generous enough to absorb contention but still finite, so a
 * genuine hang fails the run instead of hanging CI forever.
 */
export const integrationTestTimeoutMs = 30_000;
export const integrationHookTimeoutMs = 60_000;
