import { hashPassword } from '../../src/auth/password.service.js';

const hashes = new Map<string, Promise<string>>();

/**
 * argon2id is deliberately CPU-hard, and `pnpm -r test` oversubscribes the CPU
 * across six workspaces. A fixture file that hashes the same constant password
 * for three users pays that cost three times inside one `beforeAll`, which is
 * what pushed `campaign-snapshot-immutability` past its hook timeout — vitest
 * then reports the whole suite as skipped and the run fails for a reason that
 * looks nothing like the cause (see vitest.shared.ts).
 *
 * Vitest isolates modules per test file, so this cache is per file: the win is
 * removing the redundant hashes inside a single fixture, not sharing across
 * files.
 */
export function testPasswordHash(password: string): Promise<string> {
  const existing = hashes.get(password);
  if (existing) return existing;
  const created = hashPassword(password);
  hashes.set(password, created);
  return created;
}
