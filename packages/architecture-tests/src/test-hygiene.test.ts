import { describe, expect, it } from 'vitest';
import { describeViolations, listFiles, read } from './repo.js';

const TEST_FILES = [...listFiles('apps', ['.test.ts', '.spec.ts']), ...listFiles('packages', ['.test.ts', '.spec.ts'])].filter(
  (file) => !file.startsWith('packages/architecture-tests/'), // this suite's own regex literals would self-trip
);

/**
 * Files that legitimately hold a static connection string. Each needs a reason:
 * the point of the rule is that bypassing it is deliberate, not accidental.
 */
const STATIC_URL_ALLOWED: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'apps/api/src/config/env.test.ts',
    reason: 'pure unit test of the zod env schema — the strings are parser fixtures and are never connected to',
  },
  {
    file: 'apps/api/test/integration/boot.test.ts',
    reason:
      'deliberately controls the spawned process env to prove fail-fast; the process must exit before any connection ' +
      'is attempted, so deriving these from .env would couple a boot-validation test to a running Redis/Postgres',
  },
  {
    file: 'apps/worker/src/campaign-send/send.integration.test.ts',
    reason:
      'A15/DEC-103 deliberately points at a closed port to prove Redis-unreachable fails the batch closed rather ' +
      'than open; deriving this URL from .env would make it resolve to the real, reachable test Redis instance, ' +
      'defeating the one thing this test exists to exercise.',
  },
];

describe('ARCH-TEST-HYGIENE', () => {
  it('finds test files to scan', () => {
    expect(TEST_FILES.length).toBeGreaterThan(10);
  });

  /**
   * D-33, the regression this rule exists because of: M2-S4 made the API open a
   * real Redis connection at boot, so every suite building the real AppModule
   * suddenly needed a working REDIS_URL. New suites carried their own inline
   * .env-parsing helper; two pre-existing M1 suites still hardcoded a
   * password-less `redis://localhost:56379/0`. compose.yaml starts redis with
   * --requirepass, so those connections were refused, `beforeAll` threw, and
   * vitest reported the result as 30 SKIPPED tests under a green-looking
   * "158 passed" headline. The auth and RBAC safety net was gone and nothing said so.
   *
   * Connection strings must come from test-database-url.ts / test-redis-url.ts,
   * which derive from .env — so a port or password change cannot leave some
   * suites behind again.
   */
  it('has no hardcoded database or redis connection string (use the .env-derived helpers)', () => {
    const violations: string[] = [];
    for (const file of TEST_FILES) {
      if (STATIC_URL_ALLOWED.some((entry) => entry.file === file)) continue;
      read(file)
        .split(/\r?\n/)
        .forEach((line, index) => {
          // Only a *static* literal is a violation. A template literal that
          // interpolates process.env.EOW_* already tracks .env, which is the
          // behaviour this rule wants — flagging it would be a false positive,
          // and false positives are how a fitness function gets ignored.
          const match = /['"`](redis|postgres(ql)?):\/\/[^'"`]*['"`]/.exec(line);
          if (match && !match[0].includes('${')) {
            violations.push(`${file}:${index + 1}  ${line.trim().slice(0, 90)}`);
          }
        });
    }
    expect(
      violations,
      `Hardcoded connection string(s) found. Use testDatabaseUrl() / testRedisUrl() so every suite tracks .env ` +
        `together (see EXECPLAN D-33):${describeViolations(violations)}`,
    ).toEqual([]);
  });

  /**
   * AGENTS.md §5: "Do not mark work complete with skipped tests". A committed
   * .skip/.only silently shrinks the suite while the summary still reads green.
   */
  it('has no committed .skip or .only', () => {
    const violations: string[] = [];
    for (const file of TEST_FILES) {
      read(file)
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (/\b(describe|it|test)\.(skip|only)\s*\(/.test(line)) {
            violations.push(`${file}:${index + 1}  ${line.trim().slice(0, 90)}`);
          }
        });
    }
    expect(violations, `Committed .skip/.only found (AGENTS.md §5):${describeViolations(violations)}`).toEqual([]);
  });
});
