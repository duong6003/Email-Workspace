import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, read, REPO_ROOT } from './repo.js';

/**
 * ARCH-MIGRATION: AGENTS.md §5 — "Never edit a published migration; add a
 * forward migration." database/migrate.sh enforces per-file checksums at
 * deploy time. This read-only test catches drift in `pnpm check` instead.
 *
 * `migrations.lock.json` is a deliberately reviewed, exact-byte manifest.
 * This test never creates, updates, or blesses that manifest: adding a
 * migration requires a matching manual lock entry in the same reviewed diff.
 */
const MANIFEST_PATH = 'database/migrations.lock.json';

describe('ARCH-MIGRATION: published migrations are immutable (AGENTS.md §5, DEPLOY-005)', () => {
  it('requires exact migration filename and SHA-256 equality with committed lock', () => {
    const files = listFiles('database/migrations', ['.sql']);
    expect(files.length, 'no migrations found — scanner path is wrong').toBeGreaterThan(0);

    const current = Object.fromEntries(files.map((file) => [
      file.split('/').pop()!,
      createHash('sha256').update(readFileSync(resolve(REPO_ROOT, file))).digest('hex'),
    ]));
    const recorded = JSON.parse(read(MANIFEST_PATH)) as Record<string, string>;

    const currentNames = Object.keys(current).sort();
    const recordedNames = Object.keys(recorded).sort();
    expect(
      currentNames,
      'Migration filename set differs from migrations.lock.json. Add only forward migrations and pin every final exact hash manually.',
    ).toEqual(recordedNames);

    const mismatches = recordedNames.filter((name) => current[name] !== recorded[name]);
    expect(
      mismatches,
      `Published migration hashes differ from migrations.lock.json: ${mismatches.join(', ')}`,
    ).toEqual([]);
  });
});
